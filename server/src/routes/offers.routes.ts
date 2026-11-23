import express, { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { recognizeOfferScreenshot } from '../modules/bills/screenshot-upload';
import { extractOfferIntent, ollamaEnabled, resolveMerchantWithOllama } from '../modules/offers/intent';
import { cardProfileSchema, idSchema, offerQuerySchema, offerRecordSchema, offerWriteSchema, readCardProfile, readOfferRule } from '../modules/offers/rules';
import { appliesToCard } from '../modules/offers/compare';
import { knownOfferMerchants, offerCatalog, saveOfferInTransaction, searchRewardOffers } from '../modules/offers/service';
import { initialOfferSources, offerSourceStatus, offerSources, refreshOfferSource } from '../modules/offers/sources';
import { configureWechatFeed, importWechatArticle, refreshWechatFeed, wechatFeedSettings, wechatFeedStatus, wechatImportSchema } from '../modules/offers/wechat-source';
import { configureWechatCollection, pollWechatScan, refreshWechatCollection, revokeWechatScan,
  searchWechatAccounts, startWechatScan, wechatCollectionSettings, wechatCollectionStatus } from '../modules/offers/wechat-collection';
import { withTransactionRetry } from '../parsers/pipeline';
import { requireAuth } from './middleware';

const router = Router();
router.use(requireAuth);
const sourceKeySchema = z.enum(offerSources.map((source) => source.key));

router.get('/catalog', asyncHandler(async (_req, res) => {
  res.json({ ...await offerCatalog(), ollamaEnabled: ollamaEnabled() });
}));

async function lookup(query: z.infer<typeof offerQuerySchema>) {
  const sources = initialOfferSources(query.merchant);
  const attempts = await Promise.allSettled(sources.map(({ key }) => refreshOfferSource(key, 'initial')));
  const syncIssues = sources.filter((_, index) => attempts[index].status === 'rejected').map(({ name }) => name);
  return { ...await searchRewardOffers(query), syncIssues };
}

router.get('/search', asyncHandler(async (req, res) => {
  const query = offerQuerySchema.parse({ ...req.query,
    budget: typeof req.query.budget === 'string' && req.query.budget.trim() ? Number(req.query.budget) : undefined });
  res.json(await lookup(query));
}));

const askSchema = offerQuerySchema.partial().extend({ question: z.string().trim().min(1).max(240) });
router.post('/ask', asyncHandler(async (req, res) => {
  const { question, ...explicit } = askSchema.parse(req.body);
  const merchants = await knownOfferMerchants();
  const local = extractOfferIntent(question, merchants);
  const modelMerchant = explicit.merchant || local ? null : await resolveMerchantWithOllama(question, merchants);
  const merchant = explicit.merchant ?? local?.merchant ?? modelMerchant;
  if (!merchant) throw new ApiError(400, '请说出想去的商户，例如「今晚吃海底捞」');
  const filters = Object.fromEntries(Object.entries(explicit).filter(([, value]) => value !== undefined));
  const result = await lookup(offerQuerySchema.parse({ ...local, ...filters, merchant }));
  res.json({ ...result, interpretation: modelMerchant ? 'ollama' : 'local' });
}));

router.get('/sources', asyncHandler(async (_req, res) => { res.json(await offerSourceStatus()); }));
router.put('/sources/:key', asyncHandler(async (req, res) => {
  const key = sourceKeySchema.parse(req.params.key);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  await prisma.rewardSource.upsert({ where: { key }, create: { key, enabled }, update: { enabled } });
  res.json({ ok: true });
}));
router.post('/sources/:key/refresh', asyncHandler(async (req, res) => {
  res.json(await refreshOfferSource(sourceKeySchema.parse(req.params.key), 'manual'));
}));
router.get('/werss', asyncHandler(async (_req, res) => { res.json(await wechatFeedStatus()); }));
router.put('/werss', asyncHandler(async (req, res) => {
  await configureWechatFeed(wechatFeedSettings.parse(req.body));
  res.json({ ok: true });
}));
router.post('/werss/refresh', asyncHandler(async (_req, res) => { res.json(await refreshWechatFeed(true)); }));
router.post('/wechat-article', asyncHandler(async (req, res) => {
  res.json(await importWechatArticle(wechatImportSchema.parse(req.body)));
}));
router.get('/wechat-collection', asyncHandler(async (_req, res) => { res.json(await wechatCollectionStatus()); }));
router.put('/wechat-collection', asyncHandler(async (req, res) => {
  await configureWechatCollection(wechatCollectionSettings.parse(req.body));
  res.json({ ok: true });
}));
router.post('/wechat-collection/scan', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store').json(await startWechatScan());
}));
router.post('/wechat-collection/scan/:id', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await pollWechatScan(z.uuid().parse(req.params.id)));
}));
router.delete('/wechat-collection/authorization', asyncHandler(async (_req, res) => {
  await revokeWechatScan();
  res.json({ ok: true });
}));
router.get('/wechat-collection/accounts', asyncHandler(async (req, res) => {
  res.json(await searchWechatAccounts(z.string().trim().min(1).max(60).parse(req.query.q)));
}));
router.post('/wechat-collection/refresh', asyncHandler(async (_req, res) => { res.json(await refreshWechatCollection(true)); }));

router.post('/screenshot-draft', express.raw({ type: ['image/png', 'image/jpeg'], limit: '8mb' }), asyncHandler(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ApiError(400, '请选择 PNG 或 JPEG 活动截图');
  const sourceText = (await recognizeOfferScreenshot(req.body)).trim().slice(0, 8000);
  if (!sourceText) throw new ApiError(422, '没有识别到活动文字');
  const text = sourceText.normalize('NFKC').replace(/\s+/g, '');
  const fixed = text.match(/满(\d+(?:\.\d{1,2})?)元?(?:立减|减)(\d+(?:\.\d{1,2})?)元/);
  const random = text.match(/满(\d+(?:\.\d{1,2})?)元?随机(?:立)?减最高(\d+(?:\.\d{1,2})?)元/);
  res.json({ sourceText, ...(fixed || random ? {
    threshold: Number((fixed ?? random)![1]),
    discount: random ? { type: 'random', max: Number(random[2]) } : { type: 'fixed', amount: Number(fixed![2]) },
  } : {}) });
}));

router.put('/cards/:cardId/profile', asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.cardId);
  const rewardProfile = cardProfileSchema.parse(req.body);
  const changed = await prisma.card.updateMany({ where: { id, hidden: false }, data: { rewardProfile } });
  if (!changed.count) throw new ApiError(404, '未找到卡片');
  res.json({ ok: true });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { rule, review } = offerWriteSchema.parse(req.body);
  res.status(201).json(await withTransactionRetry(() =>
    prisma.$transaction((tx) => saveOfferInTransaction(tx, rule, review), { isolationLevel: 'Serializable' })));
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const { rule, review } = offerWriteSchema.parse(req.body);
  res.json(await withTransactionRetry(() =>
    prisma.$transaction((tx) => saveOfferInTransaction(tx, rule, review, id), { isolationLevel: 'Serializable' })));
}));

router.post('/:id/archive', asyncHandler(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  await withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const offer = await tx.rewardOffer.findUnique({ where: { id }, select: { rule: true, review: true } });
    if (!offer) throw new ApiError(404, '活动不存在');
    if (offer.review === 'archived') return;
    await tx.rewardOfferRevision.create({ data: { offerId: id, snapshot: offer } });
    await tx.rewardOffer.update({ where: { id }, data: { review: 'archived' } });
  }, { isolationLevel: 'Serializable' }));
  res.json({ ok: true });
}));

router.get('/:id/revisions', asyncHandler(async (req, res) => {
  const offerId = idSchema.parse(req.params.id);
  const rows = await prisma.rewardOfferRevision.findMany({
    where: { offerId }, orderBy: [{ changedAt: 'desc' }, { id: 'desc' }], take: 20,
    select: { id: true, changedAt: true, snapshot: true },
  });
  res.json(rows);
}));

router.put('/:id/cards/:cardId', asyncHandler(async (req, res) => {
  const offerId = idSchema.parse(req.params.id);
  const cardId = idSchema.parse(req.params.cardId);
  const state = offerRecordSchema.parse(req.body);
  const [offer, card] = await Promise.all([
    prisma.rewardOffer.findUnique({ where: { id: offerId }, select: { id: true, rule: true, review: true } }),
    prisma.card.findFirst({ where: { id: cardId, hidden: false }, select: {
      id: true, bankName: true, nickname: true, displayLast4: true, rewardProfile: true,
    } }),
  ]);
  if (!offer || !card) throw new ApiError(404, '未找到活动或卡片');
  const rule = readOfferRule(offer.rule);
  if (state.favorite && (offer.review !== 'ready' || !rule || !appliesToCard(rule, { ...card, profile: readCardProfile(card.rewardProfile) }))) {
    throw new ApiError(400, '请为这条活动选择适用的卡片');
  }
  const record = await prisma.cardOfferRecord.upsert({
    where: { offerId_cardId: { offerId, cardId } },
    create: { offerId, cardId, state }, update: { state },
  });
  res.json({ id: record.id, cardId, state });
}));

export default router;
