import type { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../lib/errors';
import { ymd } from '../../lib/dates';
import { loadCardSpendProgress } from '../bills/card-spend-service';
import { appliesToCard, compareOffers, normalizedName } from './compare';
import type { RewardCard, SearchOffer } from './compare';
import { readCardProfile, readOfferRecord, readOfferRule } from './rules';
import type { OfferQuery, RewardOfferInput } from './rules';

const offerSelect = {
  id: true, kind: true, title: true, rule: true, verifiedAt: true, updatedAt: true, review: true, sourceKey: true,
  records: { select: { cardId: true, state: true } },
} satisfies Prisma.RewardOfferSelect;

export async function rewardCards(): Promise<RewardCard[]> {
  const rows = await prisma.card.findMany({
    where: { hidden: false, status: 'active' }, orderBy: [{ bankName: 'asc' }, { id: 'asc' }],
    select: { id: true, bankName: true, nickname: true, displayLast4: true, rewardProfile: true },
  });
  return rows.map(({ rewardProfile, ...row }) => ({ ...row, profile: readCardProfile(rewardProfile) }));
}

export async function saveOfferInTransaction(
  tx: Prisma.TransactionClient, rule: RewardOfferInput, review: string, id?: number,
  source?: { sourceKey: string; fingerprint: string },
) {
  if (rule.cardIds.length) {
    const count = await tx.card.count({ where: { id: { in: [...new Set(rule.cardIds)] }, hidden: false } });
    if (count !== new Set(rule.cardIds).size) throw new ApiError(400, '有适用卡片不存在或已隐藏');
  }
  const current = id ? await tx.rewardOffer.findUnique({ where: { id } }) : null;
  if (id && !current) throw new ApiError(404, '活动不存在');
  if (rule.stackWith.length) {
    const ids = [...new Set(rule.stackWith)];
    if (id && ids.includes(id)) throw new ApiError(400, '活动不能和自身叠加');
    const others = await tx.rewardOffer.findMany({ where: { id: { in: ids } }, select: { rule: true } });
    if (others.length !== ids.length || others.some((other) => readOfferRule(other.rule)?.discount.type !== 'fixed')) {
      throw new ApiError(400, '请选择已录入的固定立减作为叠加优惠');
    }
  }
  const previous = current && { rule: current.rule, review: current.review };
  if (current && JSON.stringify(previous) !== JSON.stringify({ rule, review })) {
    await tx.rewardOfferRevision.create({ data: { offerId: current.id, snapshot: previous! } });
  }
  const data = { title: rule.title, kind: rule.kind, rule, review, verifiedAt: review === 'ready' ? new Date() : null, ...source };
  const offer = current ? await tx.rewardOffer.update({ where: { id: current.id }, data }) : await tx.rewardOffer.create({ data });
  await tx.rewardOfferMerchant.deleteMany({ where: { offerId: offer.id } });
  const keys = [...new Set(rule.merchants.map(normalizedName).filter(Boolean))];
  if (keys.length) await tx.rewardOfferMerchant.createMany({ data: keys.map((key) => ({ key, offerId: offer.id })) });
  return offer;
}

export async function knownOfferMerchants() {
  const rows = await prisma.rewardOffer.findMany({ where: { review: 'ready' }, select: { rule: true },
    orderBy: { updatedAt: 'desc' }, take: 500 });
  return [...new Set(rows.flatMap((row) => readOfferRule(row.rule)?.merchants ?? []))];
}

export async function searchRewardOffers(input: OfferQuery) {
  const query = { ...input, date: input.date ?? ymd() };
  const [cards, rows] = await Promise.all([
    rewardCards(),
    prisma.rewardOffer.findMany({
      where: { review: 'ready', merchantKeys: { some: { key: normalizedName(query.merchant) } } }, select: offerSelect,
    }),
  ]);
  const valid = rows.flatMap((row): SearchOffer[] => {
    const rule = readOfferRule(row.rule);
    return rule ? [{ id: row.id, rule, verifiedAt: row.verifiedAt?.toISOString() ?? null,
      records: new Map(row.records.map((record) => [record.cardId, readOfferRecord(record.state)])) }] : [];
  });
  const result = compareOffers(valid, cards, query);
  const linked = result.results.filter((row) => row.rule.spendRuleId);
  if (linked.length) {
    const cardIds = [...new Set(linked.map((row) => row.card.id))].slice(0, 6);
    const progress = await Promise.allSettled(cardIds.map(async (cardId) => [cardId, await loadCardSpendProgress(cardId)] as const));
    const byId = new Map(progress.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []));
    return { ...result, results: result.results.map((row) => ({
      ...row, progress: byId.get(row.card.id)?.tracks.find((track) => track.rule.id === row.rule.spendRuleId)?.periods.at(-1) ?? null,
    })) };
  }
  return result;
}

export async function offerCatalog() {
  const [rows, cards] = await Promise.all([
    prisma.rewardOffer.findMany({ select: offerSelect, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] }),
    rewardCards(),
  ]);
  return { cards, offers: rows.flatMap((row) => {
    const rule = readOfferRule(row.rule);
    return rule ? [{ ...row, rule, applicableCardIds: cards.filter((card) => appliesToCard(rule, card)).map((card) => card.id),
      records: row.records.map((item) => ({ ...item, state: readOfferRecord(item.state) })) }] : [];
  }) };
}
