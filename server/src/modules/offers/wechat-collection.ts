import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../config';
import { decrypt, encrypt } from '../../lib/crypto';
import { ymd } from '../../lib/dates';
import { ApiError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { WechatOfferSubscription } from '../../generated/prisma/client';
import { describeWechatArticles, importedWechatArticles, importWechatArticles, readWechatArticle, wechatArticleKey } from './wechat-source';
import type { WechatArticle } from './wechat-articles';
import { recordWechatSyncRun } from './wechat-sync-runs';
import type { WechatSyncRunContext } from './wechat-sync-runs';
import { claimWechatSubscription, createWechatSyncRunner, emptySync, listWechatSubscriptions, removeWechatSubscription,
  saveWechatSubscription, subscriptionRunMatch, wechatAuthorized, wechatRetryTime, wechatSources } from './wechat-subscriptions';
import type { SyncCounts, SyncTrigger } from './wechat-subscriptions';
import { checkPlatformLogin, createPlatformLogin, findWechatAccounts, listWechatArticles, wechatAccountSchema,
  WechatAuthorizationExpired, wechatCredentialSchema, WechatRateLimited } from './wechat-platform';
import type { PlatformLogin } from './wechat-platform';

const id = wechatSources.platform;
const loginDuration = 4 * 60_000;
type ScanStatus = 'waiting' | 'scanned' | 'authorized' | 'expired';
type ActiveScan = PlatformLogin & { id: string; expiresAt: number; status: ScanStatus; lastPoll: number };
let scan: ActiveScan | undefined;
let scanStart: Promise<{ id: string; image: string; expiresAt: number }> | undefined;
let poll: Promise<{ status: ScanStatus }> | undefined;
const runner = createWechatSyncRunner(id, emptySync, collectWechatOffers);

export async function wechatCollectionStatus() {
  const [row, accounts] = await Promise.all([prisma.wechatOfferSubscription.findUnique({ where: { id } }),
    listWechatSubscriptions(id)]);
  return {
    authorized: wechatAuthorized(row), expiresAt: row?.expiresAt ?? null, accounts,
    activeAccountId: runner.activeAccount(), error: row?.credential ? null : row?.error ?? null,
    retryAfter: wechatRetryTime(row),
  };
}

export function startWechatScan() {
  if (scanStart) return scanStart;
  if (poll) throw new ApiError(409, '正在确认微信授权，请稍后再试');
  scanStart = (async () => {
    scan = undefined;
    const { image, ...login } = await createPlatformLogin();
    scan = { ...login, id: randomUUID(), expiresAt: Date.now() + loginDuration, status: 'waiting', lastPoll: 0 };
    return { id: scan.id, image, expiresAt: scan.expiresAt };
  })().finally(() => { scanStart = undefined; });
  return scanStart;
}

export async function pollWechatScan(scanId: string): Promise<{ status: ScanStatus }> {
  const active = scan;
  if (!active || active.id !== scanId) return { status: 'expired' };
  if (active.expiresAt <= Date.now()) {
    active.session.cookies.clear();
    scan = undefined;
    return { status: 'expired' };
  }
  if (poll) return poll;
  if (active.status === 'authorized' || active.status === 'expired' || Date.now() - active.lastPoll < 2500) return { status: active.status };
  active.lastPoll = Date.now();
  poll = (async () => {
    const result = await checkPlatformLogin(active);
    if (scan !== active) return { status: 'expired' } as const;
    if (result.status === 'authorized') {
      const data = { credential: encrypt(config.encryptionKey, JSON.stringify(result.credential)),
        authorizedAt: new Date(), expiresAt: result.expiresAt ?? null, error: null };
      await prisma.wechatOfferSubscription.upsert({ where: { id }, create: { id, ...data }, update: data });
      active.session.cookies.clear();
    }
    if (result.status === 'expired') active.session.cookies.clear();
    active.status = result.status;
    return { status: active.status };
  })().finally(() => { poll = undefined; });
  return poll;
}

export async function revokeWechatScan() {
  if (scanStart || poll) throw new ApiError(409, '正在确认微信授权，请稍后再试');
  scan = undefined;
  await prisma.wechatOfferSubscription.updateMany({ where: { id }, data: {
    credential: null, expiresAt: null, authorizedAt: null, error: null,
  } });
}

function getCredential(row: WechatOfferSubscription | null) {
  if (!wechatAuthorized(row)) throw new WechatAuthorizationExpired();
  try { return wechatCredentialSchema.parse(JSON.parse(decrypt(config.encryptionKey, row!.credential!))); }
  catch { throw new WechatAuthorizationExpired(); }
}

async function markAuthorizationExpired(row: WechatOfferSubscription) {
  return prisma.wechatOfferSubscription.updateMany({ where: { id, authorizedAt: row.authorizedAt }, data: {
    credential: null, expiresAt: new Date(), error: new WechatAuthorizationExpired().message,
  } });
}

async function rememberRateLimit(error: WechatRateLimited, row: WechatOfferSubscription) {
  await prisma.wechatOfferSubscription.updateMany({
    where: { id, authorizedAt: row.authorizedAt, OR: [{ retryAfter: null }, { retryAfter: { lt: error.retryAt } }] },
    data: { retryAfter: error.retryAt },
  });
}

export async function searchWechatAccounts(query: string) {
  const row = await prisma.wechatOfferSubscription.findUnique({ where: { id } });
  const retryAt = wechatRetryTime(row);
  if (retryAt) throw new WechatRateLimited(retryAt);
  try { return await findWechatAccounts(getCredential(row), query); }
  catch (error) {
    if (row && error instanceof WechatAuthorizationExpired) await markAuthorizationExpired(row);
    if (row && error instanceof WechatRateLimited) await rememberRateLimit(error, row);
    throw error;
  }
}

export const wechatCollectionSettings = z.object({ account: wechatAccountSchema, enabled: z.boolean() });
export function configureWechatCollection({ account, enabled }: z.infer<typeof wechatCollectionSettings>) {
  return saveWechatSubscription(id, account.id, { name: account.name, enabled });
}

export function unsubscribeWechatCollection(accountId: string) {
  return removeWechatSubscription(id, accountId);
}

export function refreshWechatCollection(manual = false, accountId?: string, now = new Date()) {
  return runner.refresh(manual ? 'manual' : accountId ? 'supplement' : 'scheduled', now, accountId);
}

async function collectWechatOffers(accountId: string, trigger: SyncTrigger, lastAttempt: Date): Promise<SyncCounts> {
  const account = await claimWechatSubscription(id, accountId, trigger, lastAttempt,
    ({ lastAttempt: previous }) => !previous || ymd(previous) !== ymd(lastAttempt), (time) => new WechatRateLimited(time));
  if (!account) return emptySync;
  const match = subscriptionRunMatch(account, lastAttempt);
  const history: WechatSyncRunContext = { source: 'platform', accountId, accountName: account.name, trigger, startedAt: lastAttempt };
  let listed: Awaited<ReturnType<typeof listWechatArticles>> = [];
  try {
    listed = await listWechatArticles(getCredential(account.source), accountId);
    const earlier = await importedWechatArticles(listed.map(({ url }) => url));
    const remaining = listed.filter(({ url }) => !earlier.has(wechatArticleKey(url)));
    const articles: WechatArticle[] = [];
    for (let i = 0; i < remaining.length; i += 2) {
      const batch = await Promise.all(remaining.slice(i, i + 2).map(({ url }) => readWechatArticle(url)));
      articles.push(...batch.filter((article) => article !== undefined));
    }
    const imported = await importWechatArticles(articles, async (tx) => !!await tx.wechatSubscribedAccount.findFirst({ where: match, select: { accountId: true } }));
    const missing = remaining.length - articles.length;
    const warning = missing ? `${missing} 篇正文暂时无法读取，可通过「导入公众号文章」补录。` : null;
    await prisma.wechatSubscribedAccount.updateMany({ where: match, data: { error: warning,
      ...(articles.length || !missing ? { lastSuccess: new Date() } : {}),
    } });
    const counts = { discovered: listed.length, updated: imported.updated, skipped: imported.skipped + listed.length - remaining.length, missing };
    await recordWechatSyncRun(history, { ...counts, status: missing ? 'partial' : 'completed', message: warning,
      articles: describeWechatArticles(listed, imported.outcomes, earlier) });
    return counts;
  } catch (error) {
    if (error instanceof WechatRateLimited) await rememberRateLimit(error, account.source);
    const message = error instanceof ApiError ? error.message : '公众号同步失败，请稍后重试';
    await prisma.wechatSubscribedAccount.updateMany({ where: match, data: { error: message } });
    if (error instanceof WechatAuthorizationExpired) await markAuthorizationExpired(account.source);
    await recordWechatSyncRun(history, { ...emptySync, discovered: listed.length, status: error instanceof WechatRateLimited ? 'limited' : 'failed',
      ...(error instanceof WechatRateLimited ? { retryAfter: error.retryAt.toISOString() } : {}),
      message, articles: listed.map((item) => ({ ...item, state: 'unprocessed' })) });
    if (trigger === 'manual') throw error;
    return emptySync;
  }
}
