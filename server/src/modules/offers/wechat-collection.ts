import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../config';
import { decrypt, encrypt } from '../../lib/crypto';
import { ymd } from '../../lib/dates';
import { ApiError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { withTransactionRetry } from '../../parsers/pipeline';
import type { WechatOfferSubscription } from '../../generated/prisma/client';
import { importWechatArticles, readWechatArticle, wechatArticleKey } from './wechat-source';
import type { WechatArticle } from './wechat-articles';
import { checkPlatformLogin, createPlatformLogin, findWechatAccounts, listWechatArticleLinks, wechatAccountSchema,
  WechatAuthorizationExpired, wechatCredentialSchema } from './wechat-platform';
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

export async function wechatCollectionStatus() {
  const row = await prisma.wechatOfferSubscription.findUnique({ where: { id } });
  return {
    authorized: authorized(row), expiresAt: row?.expiresAt ?? null,
    account: row?.accountId && row.accountName ? { id: row.accountId, name: row.accountName } : null,
    enabled: row?.enabled ?? false, lastSuccess: row?.lastSuccess ?? null, error: row?.error ?? null,
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

export async function searchWechatAccounts(query: string) {
  const row = await prisma.wechatOfferSubscription.findUnique({ where: { id } });
  try { return await findWechatAccounts(getCredential(row), query); }
  catch (error) {
    if (row && error instanceof WechatAuthorizationExpired) await markAuthorizationExpired(row);
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

interface CollectionResult { updated: number; skipped: number; missing: number }
const empty: CollectionResult = { updated: 0, skipped: 0, missing: 0 };
export async function refreshWechatCollection(manual = false) {
  if (!sync) sync = collectWechatOffers(manual).finally(() => { sync = undefined; });
  return sync;
}

async function collectWechatOffers(manual: boolean): Promise<CollectionResult> {
  const lastAttempt = new Date();
  const row = await withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const row = await tx.wechatOfferSubscription.findUnique({ where: { id } });
    if (!row?.accountId || !manual && (!row.enabled || !authorized(row) || row.lastAttempt && ymd(row.lastAttempt) === ymd(lastAttempt))) return null;
    await tx.wechatOfferSubscription.update({ where: { id }, data: { lastAttempt } });
    return { ...row, accountId: row.accountId };
  }, { isolationLevel: 'Serializable' }));
  if (!row) return empty;
  const match = { id, accountId: row.accountId, authorizedAt: row.authorizedAt, lastAttempt };
  try {
    const links = await listWechatArticleLinks(getCredential(row), row.accountId);
    const earlier = new Set(links.length ? (await prisma.rewardOffer.findMany({
      where: { OR: links.map((url) => ({ sourceKey: { startsWith: wechatArticleKey(url) } })) }, select: { sourceKey: true },
    })).map(({ sourceKey }) => sourceKey?.match(/^wechat:[a-f0-9]{64}:/)?.[0]) : []);
    const remaining = links.filter((url) => !earlier.has(wechatArticleKey(url)));
    const articles: WechatArticle[] = [];
    for (let i = 0; i < remaining.length; i += 2) {
      const batch = await Promise.all(remaining.slice(i, i + 2).map(readWechatArticle));
      articles.push(...batch.filter((article) => article !== undefined));
    }
    const imported = await importWechatArticles(articles, async (tx) => !!await tx.wechatOfferSubscription.findFirst({ where: match, select: { id: true } }));
    const missing = remaining.length - articles.length;
    const warning = missing ? `${missing} 篇正文暂时无法读取，可通过「导入公众号文章」补录。` : null;
    await prisma.wechatOfferSubscription.updateMany({ where: match, data: { error: warning,
      ...(articles.length || !missing ? { lastSuccess: new Date() } : {}),
    } });
    return { updated: imported.updated, skipped: imported.skipped + links.length - remaining.length, missing };
  } catch (error) {
    if (error instanceof WechatAuthorizationExpired) await markAuthorizationExpired(row);
    else await prisma.wechatOfferSubscription.updateMany({ where: match, data: {
      error: error instanceof ApiError ? error.message : '公众号同步失败，请稍后重试',
    } });
    if (manual) throw error;
    return empty;
  }
}
