import { fromYmd } from '../../lib/dates';
import type { CardProfile, OfferQuery, OfferRecordState, RewardOfferInput } from './rules';

export interface RewardCard {
  id: number;
  bankName: string;
  nickname: string | null;
  displayLast4: string;
  profile: CardProfile;
}

export interface SearchOffer {
  id: number;
  rule: RewardOfferInput;
  verifiedAt: string | null;
  records: Map<number, OfferRecordState>;
}

const canonicalBrands: Record<string, string> = { 海底捞火锅: '海底捞', 奈雪的茶: '奈雪', 奈雪の茶: '奈雪', 喜茶go: '喜茶' };
export function normalizedName(value: string): string {
  const clean = value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
  return canonicalBrands[clean] ?? clean;
}

function listed(value: string, entries: string[]): boolean {
  const name = normalizedName(value);
  return entries.some((entry) => normalizedName(entry) === name);
}

function normalizedBank(value: string): string {
  return normalizedName(value).replace(/^中国/, '');
}

const normalizedCity = (city: string) => normalizedName(city).replace(/市$/, '');

export function activeOn(rule: RewardOfferInput, date: string): boolean {
  if (rule.startsOn && date < rule.startsOn || rule.endsOn && date > rule.endsOn) return false;
  const weekday = new Date(fromYmd(date).getTime() + 8 * 3_600_000).getUTCDay() || 7;
  return !rule.weekdays.length || rule.weekdays.includes(weekday);
}

export function appliesToCard(rule: RewardOfferInput, card: RewardCard): boolean {
  if (rule.cardIds.length && !rule.cardIds.includes(card.id)) return false;
  if (rule.bankName && normalizedBank(rule.bankName) !== normalizedBank(card.bankName)) return false;
  if (rule.product && card.profile.product && normalizedName(rule.product) !== normalizedName(card.profile.product)) return false;
  return !rule.network || !card.profile.network || rule.network === card.profile.network;
}

type Availability = 'ready' | 'action' | 'check';
const priority: Record<Availability, number> = { ready: 0, action: 1, check: 2 };
const cash = (value: number) => Math.round(value * 100) / 100;

function comparableQuote(rule: RewardOfferInput, budget: number | undefined, card: RewardCard, state?: OfferRecordState) {
  const discount = rule.discount;
  const points = discount.type === 'points' && state?.status !== 'claimed' ? {
    cost: discount.cost, unit: discount.unit,
    balance: discount.unit === 'UP金' ? card.profile.upGold ?? null : card.profile.points ?? null,
    valuePer1000: discount.unit === 'UP金' ? card.profile.valuePer1000UpGold ?? null : card.profile.valuePer1000Points ?? null,
  } : null;
  if (budget === undefined || discount.type === 'service') {
    return { pay: null, saving: null, randomMax: null, cashback: null, pointCost: points, comparableCost: null };
  }
  if (discount.type === 'cashback') {
    const cashback = cash(Math.min(discount.cap ?? budget, budget * discount.rate / 100));
    return { pay: budget, saving: 0, randomMax: null, cashback, pointCost: null, comparableCost: cash(budget - cashback) };
  }
  if (discount.type === 'random') {
    const saving = Math.min(budget, discount.min ?? 0);
    return { pay: null, saving, randomMax: Math.min(discount.max, budget), cashback: null,
      pointCost: null, comparableCost: cash(budget - saving) };
  }
  const saving = cash(Math.min(budget, discount.type === 'percent'
    ? Math.min(discount.cap ?? budget, budget * discount.rate / 100) : discount.amount));
  const purchasePrice = discount.type === 'points' && state?.status !== 'claimed' ? discount.purchasePrice ?? 0 : 0;
  const pay = cash(budget - saving + purchasePrice);
  const comparableCost = points
    ? points.valuePer1000 === null ? null : cash(pay + points.cost * points.valuePer1000 / 1000)
    : pay;
  return { pay, saving, randomMax: null, cashback: null, pointCost: points, comparableCost };
}

function assess(offer: SearchOffer, card: RewardCard, query: OfferQuery & { date: string }) {
  const { rule } = offer;
  const state = offer.records.get(card.id);
  const claimed = state?.status === 'claimed' && (!state.voucherEndsOn || state.voucherEndsOn >= query.date);
  const scopeVerified = rule.cardIds.includes(card.id)
    || Boolean(rule.bankName && (!rule.product || card.profile.product) && (!rule.network || card.profile.network))
    || Boolean(rule.network && rule.network === card.profile.network && (!rule.product || card.profile.product));
  const quote = comparableQuote(rule, query.budget, card, claimed ? state : undefined);
  const needsCheck: string[] = [];
  const neededActions: string[] = [];
  if (!scopeVerified) needsCheck.push('核对卡产品或卡组织');
  if (rule.cities.length && !query.city) needsCheck.push('核对适用城市');
  if (rule.stores.length && !query.store) needsCheck.push('核对适用门店');
  if ((rule.startsAt || rule.endsAt) && !query.time) needsCheck.push('核对使用时段');
  if ((rule.needsEligibility || rule.spendRuleId) && state?.eligible !== true) needsCheck.push('核对银行资格或达标进度');
  if (rule.limited && !claimed) needsCheck.push('核对名额或库存');
  if (rule.requiresRegistration && (!state || state.status === 'tracked')) neededActions.push('先报名');
  if (rule.requiresClaim && !claimed) neededActions.push('先领券');
  if (quote.pointCost) {
    if (quote.pointCost.balance === null) needsCheck.push(`核对${quote.pointCost.unit}余额`);
    else if (quote.pointCost.balance < quote.pointCost.cost) needsCheck.push(`${quote.pointCost.unit}余额不足`);
    else neededActions.push(`使用${quote.pointCost.unit}兑换`);
  }
  const status: Availability = needsCheck.length ? 'check' : neededActions.length ? 'action' : 'ready';
  return { offerId: offer.id, title: rule.title, rule, verifiedAt: offer.verifiedAt,
    card: { id: card.id, bankName: card.bankName, nickname: card.nickname, displayLast4: card.displayLast4 },
    status, neededActions, needsCheck, quote, state: state ?? null };
}

type Candidate = ReturnType<typeof assess>;
function fixedCombinations(candidates: Candidate[], budget: number, channel?: OfferQuery['channel']) {
  const byOfferAndCard = new Map(candidates.map((row) => [`${row.offerId}:${row.card.id}`, row]));
  const seen = new Set<string>();
  const combinations = [];
  for (const first of candidates) {
    if (first.status !== 'ready' || first.rule.discount.type !== 'fixed') continue;
    for (const id of first.rule.stackWith) {
      const second = byOfferAndCard.get(`${id}:${first.card.id}`);
      if (!second || first.offerId === second.offerId || second.status !== 'ready' || second.rule.discount.type !== 'fixed') continue;
      const left = first.rule.channels;
      const right = second.rule.channels;
      const compatible = left.length && right.length ? left.filter((item) => right.includes(item)) : left.length ? left : right;
      if (left.length && right.length && !compatible.length) continue;
      const pair = [first, second].sort((a, b) => a.offerId - b.offerId);
      const offerIds = pair.map((row) => row.offerId);
      const key = `${first.card.id}:${offerIds.join(':')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const saving = cash(Math.min(budget, first.rule.discount.amount + second.rule.discount.amount));
      combinations.push({ card: first.card, offerIds, titles: pair.map((row) => row.title),
        channels: channel ? [channel] : compatible, saving, pay: cash(budget - saving) });
    }
  }
  return combinations.sort((a, b) => a.pay - b.pay || a.card.id - b.card.id).slice(0, 10);
}

export function compareOffers(offers: SearchOffer[], cards: RewardCard[], query: OfferQuery & { date: string }) {
  const merchantOffers = offers.filter(({ rule }) => listed(query.merchant, rule.merchants));
  const dated = merchantOffers.filter(({ rule }) => activeOn(rule, query.date));
  const chosen = dated.filter(({ rule }) => (query.budget === undefined || query.budget >= (rule.threshold ?? 0))
    && (!query.city || !rule.cities.length || rule.cities.some((city) => normalizedCity(city) === normalizedCity(query.city!)))
    && (!query.store || !rule.stores.length || listed(query.store, rule.stores))
    && (!query.channel || !rule.channels.length || rule.channels.includes(query.channel))
    && (!query.time || (!rule.startsAt || query.time >= rule.startsAt) && (!rule.endsAt || query.time <= rule.endsAt)));

  const candidates = chosen.flatMap((offer) => cards
    .filter((card) => {
      const state = offer.records.get(card.id);
      return appliesToCard(offer.rule, card) && state?.eligible !== false && state?.status !== 'used' && state?.remaining !== 0;
    })
    .map((card) => assess(offer, card, query)));
  const rank = (a: typeof candidates[number], b: typeof candidates[number]) => priority[a.status] - priority[b.status]
    || (a.quote.comparableCost ?? Infinity) - (b.quote.comparableCost ?? Infinity)
    || (a.rule.threshold ?? 0) - (b.rule.threshold ?? 0) || a.offerId - b.offerId || a.card.id - b.card.id;
  candidates.sort(rank);
  const emptyReason = candidates.length ? null : !merchantOffers.length ? 'merchant' : !dated.length ? 'date'
    : !chosen.length ? 'filters' : !chosen.some(({ rule }) => cards.some((card) => appliesToCard(rule, card))) ? 'card' : 'record';
  const combinations = query.budget === undefined ? [] : fixedCombinations(candidates, query.budget, query.channel);

  // 无预算时按达到各优惠门槛的金额重新比较一次，提示何时值得换方案。
  const thresholds = [...new Set(candidates.map(({ rule }) => rule.threshold ?? 0))].sort((a, b) => a - b).slice(0, 10);
  const tiers = query.budget === undefined ? thresholds.flatMap((amount) => {
    const exampleBudget = Math.max(amount, 0.01);
    const eligible = candidates.filter((row) => (row.rule.threshold ?? 0) <= amount)
      .map((row) => ({ ...row, quote: comparableQuote(row.rule, exampleBudget,
        cards.find((card) => card.id === row.card.id)!,
        row.state?.voucherEndsOn && row.state.voucherEndsOn < query.date ? undefined : row.state ?? undefined) }))
      .sort(rank);
    const best = eligible[0];
    return best ? [{ amount, offerId: best.offerId, cardId: best.card.id }] : [];
  }) : [];
  return { query, results: candidates.slice(0, 100), tiers, combinations, emptyReason,
    prefersCombination: Boolean(combinations.length && (candidates[0]?.quote.comparableCost ?? Infinity) > combinations[0].pay) };
}
