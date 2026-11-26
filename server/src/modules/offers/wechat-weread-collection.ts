import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../config';
import { decrypt, encrypt } from '../../lib/crypto';
import { ymd } from '../../lib/dates';
import { ApiError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { withTransactionRetry } from '../../parsers/pipeline';
import type { Prisma, WechatOfferSubscription } from '../../generated/prisma/client';
import type { WechatArticle } from './wechat-articles';
import { createWechatArticleBrowser } from './wechat-browser';
import { refreshWechatCollection } from './wechat-collection';
import { describeWechatArticles, importedWechatArticles, importWechatArticles, wechatArticleKey } from './wechat-source';
import { recordWechatSyncRun } from './wechat-sync-runs';
import type { WechatSyncRunContext } from './wechat-sync-runs';
import { checkWereadLogin, listWereadArticles, readWereadArticle, startWereadLogin, wereadBookIdSchema,
  WereadAuthorizationExpired, wereadCredentialSchema, WereadRateLimited } from './wechat-weread';
import type { WereadLogin } from './wechat-weread';

// The original WeChat Official Accounts source uses row 1.
const where = { id: 2 };
const scanDuration = 3 * 60_000;
const suggestedAccount = { id: 'MP_WXS_3209006872', name: '卡羊腿' };
const frequencyKey = 'weread_sync_hours';
const syncHoursSchema = z.union([z.literal(24), z.literal(12), z.literal(6), z.literal(3), z.literal(1)]);
type ScanStatus = 'waiting' | 'scanned' | 'otp' | 'expired' | 'authorized';
type ScanResult = { status: ScanStatus; rejected?: boolean };
type ActiveScan = WereadLogin & { id: string; expiresAt: number; result: ScanResult; lastPoll: number };
type CollectionCounts = { discovered: number; updated: number; skipped: number; missing: number };
type SyncResult = CollectionCounts & { latestOnly: boolean; supplement?: CollectionCounts };

let scan: ActiveScan | undefined;
let starting: ReturnType<typeof createScan> | undefined;
let polling: Promise<ScanResult> | undefined;
let syncing: Promise<SyncResult> | undefined;

function retryTime(row: WechatOfferSubscription | null, now = Date.now()) {
  return row?.retryAfter && row.retryAfter.getTime() > now ? row.retryAfter : null;
}

async function readSyncHours(db: Pick<Prisma.TransactionClient, 'appSetting'>) {
  const setting = await db.appSetting.findUnique({ where: { key: frequencyKey }, select: { value: true } });
  return syncHoursSchema.safeParse(Number(setting?.value)).data ?? 24;
}

export async function wereadCollectionStatus() {
  const [row, syncHours] = await Promise.all([prisma.wechatOfferSubscription.findUnique({ where }), readSyncHours(prisma)]);
  const account = row?.accountId ? { id: row.accountId, name: row.accountName || row.accountId } : null;
  return { authorized: Boolean(row?.credential), account, suggestedAccount, enabled: row?.enabled ?? false, syncHours,
    lastSuccess: row?.lastSuccess ?? null, error: row?.error ?? null, retryAfter: retryTime(row) };
}

async function createScan() {
  scan = undefined;
  const { qrUrl, ...login } = await startWereadLogin();
  scan = { ...login, id: randomUUID(), expiresAt: Date.now() + scanDuration, result: { status: 'waiting' }, lastPoll: 0 };
  return { id: scan.id, qrUrl, expiresAt: scan.expiresAt };
}

export function startWereadScan() {
  if (polling) throw new ApiError(409, '正在确认微信读书授权，请稍后再试');
  starting ??= createScan().finally(() => { starting = undefined; });
  return starting;
}

export const wereadOtp = z.string().trim().regex(/^\d{4,8}$/, '请输入手机微信显示的验证码');
export async function pollWereadScan(id: string, otp?: string): Promise<ScanResult> {
  const active = scan;
  if (!active || active.id !== id) return { status: 'expired' };
  if (active.expiresAt <= Date.now()) {
    scan = undefined;
    return { status: 'expired' };
  }
  if (polling) return polling;
  if (['authorized', 'expired'].includes(active.result.status)) return active.result;
  if (otp && active.result.status !== 'otp') throw new ApiError(409, '此二维码未要求输入验证码');
  if ((!otp && active.result.status === 'otp') || Date.now() - active.lastPoll < 2500) return active.result;
  active.lastPoll = Date.now();
  polling = (async (): Promise<ScanResult> => {
    const result = await checkWereadLogin(active, otp);
    if (scan !== active || active.expiresAt <= Date.now()) return { status: 'expired' };
    if (result.status === 'authorized') {
      const data = { credential: encrypt(config.encryptionKey, JSON.stringify(result.credential)),
        authorizedAt: new Date(), expiresAt: null, lastAttempt: null, error: null };
      await prisma.wechatOfferSubscription.upsert({ where, create: { ...where, ...data }, update: data });
      active.cookies = {};
    }
    if (result.status === 'otp') active.result = { status: 'otp', rejected: result.rejected };
    else if (otp && result.status === 'waiting') active.result = { status: 'otp' };
    else active.result = { status: result.status };
    return active.result;
  })().finally(() => { polling = undefined; });
  return polling;
}

export async function revokeWereadScan() {
  if (starting || polling) throw new ApiError(409, '正在确认微信读书授权，请稍后再试');
  scan = undefined;
  await prisma.wechatOfferSubscription.updateMany({ where, data: {
    credential: null, authorizedAt: null, expiresAt: null, enabled: false, error: null,
  } });
}

export const wereadSettings = z.object({ bookId: wereadBookIdSchema, enabled: z.boolean(), syncHours: syncHoursSchema.optional() });
export async function configureWereadCollection({ bookId, enabled, syncHours }: z.infer<typeof wereadSettings>) {
  await withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const row = await tx.wechatOfferSubscription.findUnique({ where });
    if (!row?.credential && (enabled || row?.accountId !== bookId)) throw new WereadAuthorizationExpired();
    const moved = row?.accountId !== bookId ? { lastAttempt: null, lastSuccess: null, error: null } : {};
    await tx.wechatOfferSubscription.update({ where, data: {
      accountId: bookId, accountName: bookId === suggestedAccount.id ? suggestedAccount.name : bookId, enabled, ...moved,
    } });
    if (syncHours !== undefined) {
      const value = String(syncHours);
      await tx.appSetting.upsert({ where: { key: frequencyKey }, create: { key: frequencyKey, value }, update: { value } });
    }
  }, { isolationLevel: 'Serializable' }));
}

const empty: SyncResult = { discovered: 0, updated: 0, skipped: 0, missing: 0, latestOnly: false };

export function refreshWereadCollection(manual = false, now = new Date()) {
  syncing ??= collect(manual, now).finally(() => { syncing = undefined; });
  return syncing;
}

async function collect(manual: boolean, lastAttempt: Date): Promise<SyncResult> {
  const row = await withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const row = await tx.wechatOfferSubscription.findUnique({ where });
    if (!row?.credential || !row.accountId) {
      if (manual) throw new ApiError(409, '请先授权微信读书并保存公众号');
      return;
    }
    if (!manual) {
      if (!row.enabled || lastAttempt.getMinutes() !== 0) return;
      const hours = await readSyncHours(tx);
      const hoursSinceReminder = (lastAttempt.getHours() - config.reminderHour + 24) % 24;
      if (hoursSinceReminder % hours !== 0) return;
      const previous = row.lastAttempt;
      if (previous && ymd(previous) === ymd(lastAttempt)
        && (hours === 24 || previous.getHours() >= lastAttempt.getHours())) return;
    }
    const retryAt = retryTime(row, lastAttempt.getTime());
    if (retryAt) {
      if (manual) throw new WereadRateLimited(retryAt);
      return;
    }
    await tx.wechatOfferSubscription.update({ where, data: { lastAttempt } });
    return { ...row, credential: row.credential, accountId: row.accountId };
  }, { isolationLevel: 'Serializable' }));
  if (!row) return empty;
  const match = { ...where, accountId: row.accountId, authorizedAt: row.authorizedAt, lastAttempt };
  const history: WechatSyncRunContext = { source: 'weread', accountName: row.accountName || row.accountId,
    trigger: manual ? 'manual' : 'scheduled', startedAt: lastAttempt };
  let listed: Awaited<ReturnType<typeof listWereadArticles>>['articles'] = [];
  const browser = createWechatArticleBrowser();
  try {
    const raw = decrypt(config.encryptionKey, row.credential);
    const credential = wereadCredentialSchema.parse(JSON.parse(raw));
    const { articles, latestOnly } = await listWereadArticles(credential, row.accountId);
    listed = articles;
    const imported = await importedWechatArticles(articles.map(({ url }) => url));
    const remaining = articles.filter(({ url }) => !imported.has(wechatArticleKey(url)));
    const content: WechatArticle[] = [];
    // Fetch in small batches to keep memory use bounded and avoid bursts of requests.
    for (let i = 0; i < remaining.length; i += 2) {
      const group = await Promise.all(remaining.slice(i, i + 2).map(async (item) => {
        const article = await readWereadArticle(credential, item) ?? await browser.read(item.url);
        if (article) return { ...article, title: item.title || article.title };
      }));
      content.push(...group.filter((article) => article !== undefined));
    }
    const result = await importWechatArticles(content, async (tx) => !!await tx.wechatOfferSubscription.findFirst({
      where: match, select: { id: true },
    }));
    const missing = remaining.length - content.length;
    const warning = [latestOnly ? '微信读书暂只返回最新一篇，当天多篇可能漏同步。' : '',
      missing ? missing + ' 篇文章缺少可读正文。' : '',
      browser.unavailable ? '正文补读浏览器未能启动。可以在活动来源手动导入文章。' : ''].filter(Boolean).join(' ');
    const updated = JSON.stringify(credential);
    await prisma.wechatOfferSubscription.updateMany({ where: match, data: { error: warning || null,
      ...(updated === raw ? {} : { credential: encrypt(config.encryptionKey, updated) }),
      ...(content.length || !missing ? { lastSuccess: new Date() } : {}),
    } });
    const counts = { discovered: articles.length, updated: result.updated, skipped: result.skipped + articles.length - remaining.length, missing };
    await recordWechatSyncRun(history, { ...counts, status: warning ? 'partial' : 'completed', message: warning || null,
      articles: describeWechatArticles(articles, result.outcomes, imported) });
    // The platform uses the same numeric publisher ID encoded as __biz. Its daily task already runs separately.
    const platformId = Buffer.from(row.accountId.slice('MP_WXS_'.length)).toString('base64');
    const supplement = manual && latestOnly
      ? await refreshWechatCollection(false, platformId).catch(() => undefined)
      : undefined;
    return { ...counts, latestOnly, ...(supplement?.discovered ? { supplement } : {}) };
  } catch (error) {
    const reason = error instanceof ApiError ? error : new ApiError(502, '微信读书同步失败，请稍后重试');
    await prisma.wechatOfferSubscription.updateMany({ where: match, data: { error: reason.message,
      ...(reason instanceof WereadRateLimited ? { retryAfter: reason.retryAt } : {}),
      ...(reason instanceof WereadAuthorizationExpired ? { credential: null, expiresAt: new Date() } : {}),
    } });
    await recordWechatSyncRun(history, { ...empty, discovered: listed.length, status: reason instanceof WereadRateLimited ? 'limited' : 'failed',
      ...(reason instanceof WereadRateLimited ? { retryAfter: reason.retryAt.toISOString() } : {}),
      message: reason.message, articles: listed.map((item) => ({ ...item, state: 'unprocessed' })) });
    if (manual) throw reason;
    return empty;
  } finally {
    await browser.close();
  }
}
