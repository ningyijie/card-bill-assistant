import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../config';
import { decrypt, encrypt } from '../../lib/crypto';
import { ymd } from '../../lib/dates';
import { ApiError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { WechatArticle } from './wechat-articles';
import { createWechatArticleBrowser } from './wechat-browser';
import { describeWechatArticles, importedWechatArticles, importWechatArticles, wechatArticleKey } from './wechat-source';
import { recordWechatSyncRun } from './wechat-sync-runs';
import type { WechatSyncRunContext } from './wechat-sync-runs';
import { claimWechatSubscription, createWechatSyncRunner, emptySync, listWechatSubscriptions, removeWechatSubscription,
  saveWechatSubscription, subscriptionRunMatch, wechatAuthorized, wechatRetryTime } from './wechat-subscriptions';
import type { SyncCounts, SyncTrigger } from './wechat-subscriptions';
import { checkWereadLogin, listWereadArticles, readWereadArticle, startWereadLogin, wereadBookIdSchema,
  WereadAuthorizationExpired, wereadCredentialSchema, WereadRateLimited } from './wechat-weread';
import type { WereadLogin } from './wechat-weread';

// Keep the stored source ID for existing WeRead authorizations and subscriptions.
const where = { id: 2 };
const scanDuration = 3 * 60_000;
const suggestedAccount = { id: 'MP_WXS_3209006872', name: '卡羊腿' };
const syncHoursSchema = z.union([z.literal(24), z.literal(12), z.literal(6), z.literal(3), z.literal(1)]);
type ScanStatus = 'waiting' | 'scanned' | 'otp' | 'expired' | 'authorized';
type ScanResult = { status: ScanStatus; rejected?: boolean };
type ActiveScan = WereadLogin & { id: string; expiresAt: number; result: ScanResult; lastPoll: number };
type SyncResult = SyncCounts & { latestOnly: boolean };
const empty: SyncResult = { ...emptySync, latestOnly: false };

let scan: ActiveScan | undefined;
let starting: ReturnType<typeof createScan> | undefined;
let polling: Promise<ScanResult> | undefined;
const runner = createWechatSyncRunner(where.id, empty, collect);

export async function wereadCollectionStatus() {
  const [row, accounts] = await Promise.all([prisma.wechatOfferSubscription.findUnique({ where }), listWechatSubscriptions(where.id)]);
  return { authorized: wechatAuthorized(row), accounts, suggestedAccount,
    activeAccountId: runner.activeAccount(), error: row?.credential ? null : row?.error ?? null,
    retryAfter: wechatRetryTime(row) };
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
        authorizedAt: new Date(), expiresAt: null, error: null };
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
    credential: null, authorizedAt: null, expiresAt: null, error: null,
  } });
}

export const wereadSettings = z.object({ bookId: wereadBookIdSchema, name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean(), syncHours: syncHoursSchema.optional() });
export function configureWereadCollection({ bookId, name, enabled, syncHours }: z.infer<typeof wereadSettings>) {
  return saveWechatSubscription(where.id, bookId, { name: name ?? (bookId === suggestedAccount.id ? suggestedAccount.name : undefined),
    enabled, syncHours });
}

export function unsubscribeWereadCollection(bookId: string) {
  return removeWechatSubscription(where.id, bookId);
}

export function refreshWereadCollection(manual = false, now = new Date(), bookId?: string) {
  if (!manual && now.getMinutes() !== 0) return Promise.resolve(empty);
  return runner.refresh(manual ? 'manual' : 'scheduled', now, bookId);
}

async function collect(bookId: string, trigger: SyncTrigger, lastAttempt: Date): Promise<SyncResult> {
  const account = await claimWechatSubscription(where.id, bookId, trigger, lastAttempt, ({ syncHours, lastAttempt: previous }) => {
    const hours = syncHoursSchema.safeParse(syncHours).data ?? 24;
    const elapsed = (lastAttempt.getHours() - config.reminderHour + 24) % 24;
    return elapsed % hours === 0 && (!previous || ymd(previous) !== ymd(lastAttempt)
      || (hours !== 24 && previous.getHours() < lastAttempt.getHours()));
  }, (time) => new WereadRateLimited(time));
  if (!account) return empty;
  const match = subscriptionRunMatch(account, lastAttempt);
  const sourceMatch = { ...where, authorizedAt: account.source.authorizedAt };
  const history: WechatSyncRunContext = { source: 'weread', accountId: bookId, accountName: account.name, trigger, startedAt: lastAttempt };
  let listed: Awaited<ReturnType<typeof listWereadArticles>>['articles'] = [];
  const browser = createWechatArticleBrowser();
  try {
    const raw = decrypt(config.encryptionKey, account.source.credential!);
    const credential = wereadCredentialSchema.parse(JSON.parse(raw));
    const { articles, latestOnly } = await listWereadArticles(credential, bookId);
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
    const result = await importWechatArticles(content, async (tx) => !!await tx.wechatSubscribedAccount.findFirst({
      where: match, select: { accountId: true },
    }));
    const missing = remaining.length - content.length;
    const warning = [latestOnly ? '微信读书暂只返回最新一篇，当天多篇可能漏同步。' : '',
      missing ? missing + ' 篇文章缺少可读正文。' : '',
      browser.unavailable ? '正文补读浏览器未能启动。可以在活动来源手动导入文章。' : ''].filter(Boolean).join(' ');
    const updated = JSON.stringify(credential);
    if (updated !== raw) await prisma.wechatOfferSubscription.updateMany({ where: sourceMatch,
      data: { credential: encrypt(config.encryptionKey, updated) } });
    await prisma.wechatSubscribedAccount.updateMany({ where: match, data: { error: warning || null,
      ...(content.length || !missing ? { lastSuccess: new Date() } : {}),
    } });
    const counts = { discovered: articles.length, updated: result.updated, skipped: result.skipped + articles.length - remaining.length, missing };
    await recordWechatSyncRun(history, { ...counts, status: warning ? 'partial' : 'completed', message: warning || null,
      articles: describeWechatArticles(articles, result.outcomes, imported) });
    return { ...counts, latestOnly };
  } catch (error) {
    const reason = error instanceof ApiError ? error : new ApiError(502, '微信读书同步失败，请稍后重试');
    await prisma.wechatSubscribedAccount.updateMany({ where: match, data: { error: reason.message } });
    if (reason instanceof WereadRateLimited) await prisma.wechatOfferSubscription.updateMany({
      where: { ...sourceMatch, OR: [{ retryAfter: null }, { retryAfter: { lt: reason.retryAt } }] },
      data: { retryAfter: reason.retryAt },
    });
    if (reason instanceof WereadAuthorizationExpired) await prisma.wechatOfferSubscription.updateMany({
      where: sourceMatch, data: { credential: null, expiresAt: new Date(), error: reason.message },
    });
    await recordWechatSyncRun(history, { ...empty, discovered: listed.length, status: reason instanceof WereadRateLimited ? 'limited' : 'failed',
      ...(reason instanceof WereadRateLimited ? { retryAfter: reason.retryAt.toISOString() } : {}),
      message: reason.message, articles: listed.map((item) => ({ ...item, state: 'unprocessed' })) });
    if (trigger === 'manual') throw reason;
    return empty;
  } finally {
    await browser.close();
  }
}
