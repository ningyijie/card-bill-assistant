#!/usr/bin/env bash
set -euo pipefail

mode=${1:---check}
target=${2:-HEAD}
if [[ "$mode" != --check && "$mode" != --merge ]] || [[ $# -gt 2 ]] || [[ "$mode" == --merge && $# -gt 1 ]]; then
  printf '用法：bash scripts/nas-upstream.sh --check [commit] 或 --merge\n' >&2
  exit 1
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
target_commit=$(git rev-parse --verify --end-of-options "${target}^{commit}")
upstream='kukushouhou/card-bill-assistant'
upstream_url="https://github.com/${upstream}.git"
if ! tag=$(curl -fsSL --connect-timeout 8 --max-time 20 "https://api.github.com/repos/${upstream}/releases/latest" | python3 -c '
import json, re, sys

release = json.load(sys.stdin)
tag = release.get("tag_name", "")
if release.get("draft") or release.get("prerelease") or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
    sys.exit("无法确认上游正式版本")
print(tag)
'); then
  printf '读取上游正式版本失败，请稍后重试。\n' >&2
  exit 1
fi

printf '上游最新正式版本 %s\n' "$tag"
if ! upstream_commit=$(curl -fsSL --connect-timeout 8 --max-time 20 "https://api.github.com/repos/${upstream}/commits/$tag" |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["sha"])') || [[ ! "$upstream_commit" =~ ^[0-9a-f]{40}$ ]]; then
  printf '读取上游 %s 的提交失败，请稍后重试。\n' "$tag" >&2
  exit 1
fi

if git cat-file -e "${upstream_commit}^{commit}" 2>/dev/null && git merge-base --is-ancestor "$upstream_commit" "$target_commit"; then
  printf '当前提交已包含 %s。\n' "$tag"
  exit 0
fi
if [[ "$mode" == --check ]]; then
  printf '当前提交还未确认包含 %s。请在准备发布的分支上运行 bash scripts/nas-upstream.sh --merge。\n' "$tag"
  exit 2
fi
if [[ -n "$(git status --porcelain)" ]] || git rev-parse --quiet --verify MERGE_HEAD >/dev/null; then
  printf '请先处理工作区改动或正在进行的合并。\n' >&2
  exit 1
fi

git_transport=(-c http.version=HTTP/1.1 -c http.lowSpeedLimit=100 -c http.lowSpeedTime=20)
release_ref="refs/nas-upstream/releases/$tag"
if ! git cat-file -e "${upstream_commit}^{commit}" 2>/dev/null; then
  # GitHub 的 fork 共享提交对象。先从已配置的 origin 按上游确认的提交号读取。
  if ! git "${git_transport[@]}" fetch --no-tags --no-write-fetch-head origin "$upstream_commit:$release_ref"; then
    git "${git_transport[@]}" fetch --no-tags --no-write-fetch-head "$upstream_url" "refs/tags/$tag:$release_ref"
  fi
  if [[ "$(git rev-parse --verify "${release_ref}^{commit}")" != "$upstream_commit" ]]; then
    printf '上游 %s 的标签在检查期间发生变化，请重新检查。\n' "$tag" >&2
    exit 1
  fi
fi
if ! git merge-base "$target_commit" "$upstream_commit" >/dev/null && [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then
  printf '补齐浅克隆的提交历史，查找共同祖先。\n'
  git "${git_transport[@]}" fetch --unshallow --no-tags --no-write-fetch-head origin
  if git merge-base --is-ancestor "$upstream_commit" "$target_commit"; then
    printf '当前提交已包含 %s。\n' "$tag"
    exit 0
  fi
fi
if ! git merge-base "$target_commit" "$upstream_commit" >/dev/null; then
  printf '找不到与上游的共同祖先，无法预演合并。\n' >&2
  exit 1
fi

if preview=$(git merge-tree --write-tree --name-only --no-messages "$target_commit" "$upstream_commit"); then
  :
else
  preview_status=$?
  if [[ "$preview_status" -eq 1 ]]; then
    printf '上游 %s 存在合并冲突，涉及以下文件。\n' "$tag" >&2
    printf '%s\n' "$preview" | sed '1d' >&2
  else
    printf '上游 %s 合并预演失败（Git 退出码 %s）。\n' "$tag" "$preview_status" >&2
  fi
  exit 1
fi

git merge --no-commit --no-ff "$upstream_commit"
printf '已准备 %s 的合并。验证通过并更新定制版本号后，再提交和推送。\n' "$tag"
