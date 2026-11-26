#!/usr/bin/env bash
set -euo pipefail

if [[ ! "$TARGET_IMAGE" =~ ^([a-z0-9-]+\.)+aliyuncs\.com/[a-z0-9][a-z0-9_-]*/[a-z0-9][a-z0-9_.-]*$ ]]; then
  echo "::error::NAS_ACR_IMAGE must be an Alibaba Cloud image repository without a tag"
  exit 1
fi
if [[ -z "$ACR_USERNAME" || -z "$ACR_PASSWORD" ]]; then
  echo "::error::Configure NAS_ACR_USERNAME and NAS_ACR_PASSWORD as repository secrets"
  exit 1
fi
remote_head=$(git ls-remote --exit-code origin refs/heads/nas-custom | cut -f1)
if [[ "$remote_head" != "$EXPECTED_HEAD" ]]; then
  exit 0
fi

manifest=$(mktemp)
auth_file=$(mktemp)
trap 'rm -f "$manifest" "$auth_file"' EXIT
printf '{}\n' > "$auth_file"
printf '%s' "$ACR_PASSWORD" | skopeo login --authfile "$auth_file" \
  --username "$ACR_USERNAME" --password-stdin "${TARGET_IMAGE%%/*}"

skopeo inspect --raw "docker://$SOURCE_IMAGE" > "$manifest"
if jq -e 'has("manifests")' "$manifest" >/dev/null; then
  digest=$(jq -er '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")]
    | if length == 1 then .[0].digest else error("Expected one linux/amd64 image") end' "$manifest")
else
  digest="sha256:$(sha256sum "$manifest" | cut -d' ' -f1)"
fi
release_image="$TARGET_IMAGE:${SOURCE_IMAGE##*:}"
skopeo copy --authfile "$auth_file" --preserve-digests --retry-times 3 \
  "docker://${SOURCE_IMAGE%:*}@$digest" "docker://$release_image"

remote_head=$(git ls-remote --exit-code origin refs/heads/nas-custom | cut -f1)
if [[ "$remote_head" != "$EXPECTED_HEAD" ]]; then
  exit 0
fi
skopeo copy --authfile "$auth_file" --preserve-digests --retry-times 3 \
  "docker://$TARGET_IMAGE@$digest" "docker://$TARGET_IMAGE:nas-custom"
actual="sha256:$(skopeo inspect --raw "docker://$TARGET_IMAGE:nas-custom" | sha256sum | cut -d' ' -f1)"
if [[ "$actual" != "$digest" ]]; then
  echo "::error::The public ACR tag did not return the verified linux/amd64 manifest"
  exit 1
fi
echo "ACR NAS update image: $TARGET_IMAGE:nas-custom" >> "$GITHUB_STEP_SUMMARY"
