import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../config';
import { decrypt, encrypt } from '../../lib/crypto';
import { ymd } from '../../lib/dates';
import { ApiError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { withTransactionRetry } from '../../parsers/pipeline';
import type { WechatOfferSubscription } from '../../generated/prisma/client';
import { describeWechatArticles, importedWechatArticles, importWechatArticles, readWechatArticle, wechatArticleKey } from './wechat-source';
import type { WechatArticle } from './wechat-articles';
import { recordWechatSyncRun } from './wechat-sync-runs';
import type { WechatSyncRunContext } from './wechat-sync-runs';
import { checkPlatformLogin, createPlatformLogin, findWechatAccounts, listWechatArticles, wechatAccountSchema,
  WechatAuthorizationExpired, wechatCredentialSchema, WechatRateLimited } from './wechat-platform';
import type { PlatformLogin } from './wechat-platform';

const id = 1;
const loginDuration = 4 * 60_000;
type ScanStatus = 'waiting' | 'scanned' | 'authorized' | 'expired';
type ActiveScan = PlatformLogin & { id: string; expiresAt: number; status: ScanStatus; lastPoll: number };
let scan: ActiveScan | undefined;
let scanStart: Promise<{ id: string; image: string; expiresAt: number }> | undefined;
let poll: Promise<{ status: ScanStatus }> | undefined;
let sync: Promise<CollectionResult> | undefined;

function authorized(row: WechatOfferSubscription | null) {
  return Boolean(row?.credential && (!row.expiresAt || row.expiresAt.getTime() > Date.now()));
}

function rateLimitUntil(row: WechatOfferSubscription | null, now = Date.now()) {
  return row?.retryAfter && row.retryAfter.getTime() > now ? row.retryAfter : null;
}

export async function wechatCollectionStatus() {
  const row = await prisma.wechatOfferSubscription.findUnique({ where: { id } });
  return {
    authorized: authorized(row), expiresAt: row?.expiresAt ?? null,
    account: row?.accountId && row.accountName ? { id: row.accountId, name: row.accountName } : null,
    enabled: row?.enabled ?? false, lastSuccess: row?.lastSuccess ?? null, error: row?.error ?? null,
    retryAfter: rateLimitUntil(row),
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
        authorizedAt: new Date(), expiresAt: result.expiresAt ?? null, lastAttempt: null, error: null };
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
  if (!authorized(row)) throw new WechatAuthorizationExpired();
  try { return wechatCredentialSchema.parse(JSON.parse(decrypt(config.encryptionKey, row!.credential!))); }
  catch { throw new WechatAuthorizationExpired(); }
}

async function markAuthorizationExpired(row: WechatOfferSubscription) {
  return prisma.wechatOfferSubscription.updateMany({ where: { id, authorizedAt: row.authorizedAt }, data: {
    credential: null, expiresAt: new Date(), error: new WechatAuthorizationExpired().message,
  } });
}

async function rememberRateLimit(error: WechatRateLimited) {
  await prisma.wechatOfferSubscription.updateMany({
    where: { id, OR: [{ retryAfter: null }, { retryAfter: { lt: error.retryAt } }] },
    data: { retryAfter: error.retryAt },
  });
}

export async function searchWechatAccounts(query: string) {
  const row = await prisma.wechatOfferSubscription.findUnique({ where: { id } });
  const retryAt = rateLimitUntil(row);
  if (retryAt) throw new WechatRateLimited(retryAt);
  try { return await findWechatAccounts(getCredential(row), query); }
  catch (error) {
    if (row && error instanceof WechatAuthorizationExpired) await markAuthorizationExpired(row);
    if (error instanceof WechatRateLimited) await rememberRateLimit(error);
    throw error;
  }
}

export const wechatCollectionSettings = z.object({ account: wechatAccountSchema, enabled: z.boolean() });
export async function configureWechatCollection({ account, enabled }: z.infer<typeof wechatCollectionSettings>) {
  await withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const row = await tx.wechatOfferSubscription.findUnique({ where: { id } });
    if (row?.accountId !== account.id && !authorized(row)) throw new WechatAuthorizationExpired();
    const changed = row?.accountId !== account.id ? { lastAttempt: null, lastSuccess: null, error: null } : {};
    await tx.wechatOfferSubscription.update({ where: { id }, data: {
      accountId: account.id, accountName: account.name, enabled, ...changed,
    } });
  }, { isolationLevel: 'Serializable' }));
}

interface CollectionResult { discovered: number; updated: number; skipped: number; missing: number }
const empty: CollectionResult = { discovered: 0, updated: 0, skipped: 0, missing: 0 };
export async function refreshWechatCollection(manual = false, expectedAccountId?: string) {
  if (expectedAccountId && sync) return empty;
  if (!sync) sync = collectWechatOffers(manual, expectedAccountId).finally(() => { sync = undefined; });
  return sync;
}

async function collectWechatOffers(manual: boolean, expectedAccountId?: string): Promise<CollectionResult> {
  const lastAttempt = new Date();
  const row = await withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const row = await tx.wechatOfferSubscription.findUnique({ where: { id } });
    if (expectedAccountId && row?.accountId !== expectedAccountId) return null;
    if (!row?.accountId || !manual && (!row.enabled || !authorized(row) || row.lastAttempt && ymd(row.lastAttempt) === ymd(lastAttempt))) return null;
    const retryAt = rateLimitUntil(row, lastAttempt.getTime());
    if (retryAt) {
      if (manual) throw new WechatRateLimited(retryAt);
      return null;
    }
    await tx.wechatOfferSubscription.update({ where: { id }, data: { lastAttempt } });
    return { ...row, accountId: row.accountId };
  }, { isolationLevel: 'Serializable' }));
  if (!row) return empty;
  const match = { id, accountId: row.accountId, authorizedAt: row.authorizedAt, lastAttempt };
  const history: WechatSyncRunContext = { source: 'platform', accountName: row.accountName || row.accountId,
    trigger: expectedAccountId ? 'supplement' : manual ? 'manual' : 'scheduled', startedAt: lastAttempt };
  let listed: Awaited<ReturnType<typeof listWechatArticles>> = [];
  try {
    listed = await listWechatArticles(getCredential(row), row.accountId);
    const earlier = await importedWechatArticles(listed.map(({ url }) => url));
    const remaining = listed.filter(({ url }) => !earlier.has(wechatArticleKey(url)));
    const articles: WechatArticle[] = [];
    for (let i = 0; i < remaining.length; i += 2) {
      const batch = await Promise.all(remaining.slice(i, i + 2).map(({ url }) => readWechatArticle(url)));
      articles.push(...batch.filter((article) => article !== undefined));
    }
    const imported = await importWechatArticles(articles, async (tx) => !!await tx.wechatOfferSubscription.findFirst({ where: match, select: { id: true } }));
    const missing = remaining.length - articles.length;
    const warning = missing ? `${missing} 篇正文暂时无法读取，可通过「导入公众号文章」补录。` : null;
    await prisma.wechatOfferSubscription.updateMany({ where: match, data: { error: warning,
      ...(articles.length || !missing ? { lastSuccess: new Date() } : {}),
    } });
    const counts = { discovered: listed.length, updated: imported.updated, skipped: imported.skipped + listed.length - remaining.length, missing };
    await recordWechatSyncRun(history, { ...counts, status: missing ? 'partial' : 'completed', message: warning,
      articles: describeWechatArticles(listed, imported.outcomes, earlier) });
    return counts;
  } catch (error) {
    if (error instanceof WechatRateLimited) await rememberRateLimit(error);
    if (error instanceof WechatAuthorizationExpired) await markAuthorizationExpired(row);
    const message = error instanceof ApiError ? error.message : '公众号同步失败，请稍后重试';
    if (!(error instanceof WechatAuthorizationExpired)) await prisma.wechatOfferSubscription.updateMany({ where: match, data: { error: message } });
    await recordWechatSyncRun(history, { ...empty, discovered: listed.length, status: error instanceof WechatRateLimited ? 'limited' : 'failed',
      ...(error instanceof WechatRateLimited ? { retryAfter: error.retryAt.toISOString() } : {}),
      message, articles: listed.map((item) => ({ ...item, state: 'unprocessed' })) });
    if (manual) throw error;
    return empty;
  }
}
