import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../lib/errors';
import { ymd } from '../../lib/dates';
import { withTransactionRetry } from '../../parsers/pipeline';
import { commonOfferMerchants } from './intent';
import { knownOfferMerchants, saveOfferInTransaction } from './service';
import { boundedOfferDocument } from './sources';
import { articleDrafts, articleUrlSchema, feedUrlSchema, parseWechatFeed, parseWechatPage } from './wechat-articles';
import type { WechatArticle } from './wechat-articles';

const stateKey = 'werss';
const settingKey = 'offerWerssFeedUrl';
export const wechatImportSchema = z.object({
  url: articleUrlSchema, title: z.string().trim().max(120).optional(), text: z.string().trim().min(1).max(24_000).optional(),
});
export const wechatFeedSettings = z.object({ url: feedUrlSchema, enabled: z.boolean() });

export async function wechatFeedStatus() {
  const [setting, state] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: settingKey } }), prisma.rewardSource.findUnique({ where: { key: stateKey } }),
  ]);
  return { url: setting?.value ?? '', enabled: state?.enabled ?? false,
    lastSuccess: state?.lastSuccess ?? null, lastAttempt: state?.lastAttempt ?? null, error: state?.error ?? null };
}

export async function configureWechatFeed({ url, enabled }: z.infer<typeof wechatFeedSettings>) {
  await withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const old = await tx.appSetting.findUnique({ where: { key: settingKey } });
    const reset = old?.value !== url ? { lastAttempt: null, lastSuccess: null, error: null } : {};
    await tx.appSetting.upsert({ where: { key: settingKey }, create: { key: settingKey, value: url }, update: { value: url } });
    await tx.rewardSource.upsert({ where: { key: stateKey }, create: { key: stateKey, enabled }, update: { enabled, ...reset } });
  }, { isolationLevel: 'Serializable' }));
}

async function importArticles(items: WechatArticle[], feedUrl?: string) {
  const [known, cards] = await Promise.all([knownOfferMerchants(), feedUrl
    ? prisma.card.findMany({ where: { hidden: false }, distinct: ['bankName'], select: { bankName: true } }) : []]);
  const merchants = [...new Set([...known, ...commonOfferMerchants])];
  const ownedBanks = cards.map(({ bankName }) => bankName);
  let updated = 0;
  let skipped = 0;
  for (const article of items) {
    const prefix = `wechat:${createHash('sha256').update(article.url).digest('hex')}:`;
    const drafts = articleDrafts(article, ownedBanks, merchants, Boolean(feedUrl));
    const count = await withTransactionRetry(() => prisma.$transaction(async (tx) => {
      if (feedUrl && (await tx.appSetting.findUnique({ where: { key: settingKey } }))?.value !== feedUrl) return 0;
      if (!drafts.length || await tx.rewardOffer.findFirst({ where: { sourceKey: { startsWith: prefix } }, select: { id: true } })) return 0;
      for (const { rule, fingerprint } of drafts) {
        await saveOfferInTransaction(tx, rule, 'draft', undefined, { sourceKey: `${prefix}${fingerprint}`, fingerprint });
      }
      return drafts.length;
    }, { isolationLevel: 'Serializable' }));
    updated += count;
    if (!count) skipped++;
  }
  return { updated, skipped };
}

export async function importWechatArticle({ url, title, text }: z.infer<typeof wechatImportSchema>) {
  let article: WechatArticle | undefined;
  if (text) article = { url, text, title: title || text.split(/\r?\n/, 1)[0].slice(0, 120) };
  else {
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' } });
      if (response.ok) article = parseWechatPage(url, await boundedOfferDocument(response));
    } catch { /* 公众号可能要求验证，前端保留地址方便补录。 */ }
  }
  if (!article) return { updated: 0, skipped: 0, needsContent: true };
  return { ...await importArticles([article]), needsContent: false };
}

let runningFeed: Promise<{ updated: number; skipped: number; missing: number }> | undefined;
export async function refreshWechatFeed(manual = false) {
  if (!runningFeed) {
    runningFeed = syncWechatFeed(manual).finally(() => { runningFeed = undefined; });
  }
  return runningFeed;
}

async function syncWechatFeed(manual: boolean) {
  const empty = { updated: 0, skipped: 0, missing: 0 };
  const lastAttempt = new Date();
  const setting = await withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const row = await tx.appSetting.findUnique({ where: { key: settingKey } });
    if (!row) return;
    const state = await tx.rewardSource.findUnique({ where: { key: stateKey } });
    if (!state || !manual && (!state.enabled || state.lastAttempt && ymd(state.lastAttempt) === ymd(lastAttempt))) return;
    await tx.rewardSource.update({ where: { key: stateKey }, data: { lastAttempt } });
    return row;
  }, { isolationLevel: 'Serializable' }));
  if (!setting) return empty;
  try {
    const url = feedUrlSchema.parse(setting.value);
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml' } });
    if (!response.ok) throw new Error(`WeRSS 返回 HTTP ${response.status}`);
    const { articles, missing } = parseWechatFeed(await boundedOfferDocument(response, 4_000_000));
    const result = await importArticles(articles, url);
    const warning = missing ? `${missing} 篇缺少可读正文或微信原文链接。请在 WeRSS 启用全文和原链接。` : null;
    await prisma.rewardSource.updateMany({ where: { key: stateKey, lastAttempt }, data: {
      ...(articles.length > 0 || !missing ? { lastSuccess: new Date() } : {}), error: warning,
    } });
    return { ...result, missing };
  } catch (error) {
    const known = error instanceof Error && /^(?:WeRSS 返回|该地址没有|来源内容)/.test(error.message);
    const detail = known ? (error as Error).message : '无法读取 WeRSS，请核对订阅地址和 NAS 网络连接';
    await prisma.rewardSource.updateMany({ where: { key: stateKey, lastAttempt }, data: { error: detail } });
    if (manual) throw new ApiError(502, detail);
    return empty;
  }
}
