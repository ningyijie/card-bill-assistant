import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordRows = vi.hoisted(() => vi.fn());
const spendProgress = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/prisma', () => ({ prisma: { cardOfferRecord: { findMany: recordRows } } }));
vi.mock('../src/modules/bills/card-spend-service', () => ({ loadCardSpendProgress: spendProgress }));

import { fromYmd } from '../src/lib/dates';
import { compareOffers } from '../src/modules/offers/compare';
import type { RewardCard, SearchOffer } from '../src/modules/offers/compare';
import { extractOfferIntent } from '../src/modules/offers/intent';
import { collectOfferReminderEvents } from '../src/modules/offers/reminders';
import { offerRecordSchema, offerSchema } from '../src/modules/offers/rules';
import type { OfferRecordState, RewardOfferInput } from '../src/modules/offers/rules';
import { offerSources, parseOfficialOfferPage } from '../src/modules/offers/sources';

const date = '2026-11-22';
const cards: RewardCard[] = [
  { id: 1, bankName: '华夏银行', nickname: 'UP 卡', displayLast4: '0001', profile: { upGold: 5_000, valuePer1000UpGold: 3 } },
  { id: 2, bankName: '中信银行', nickname: '悦卡', displayLast4: '0002', profile: {} },
  { id: 3, bankName: '广发银行', nickname: '臻尚白', displayLast4: '0003', profile: {} },
];

function offer(id: number, fields: Partial<RewardOfferInput> = {}, state?: Partial<OfferRecordState>): SearchOffer {
  const rule = offerSchema.parse({ title: `活动 ${id}`, kind: 'activity', merchants: ['海底捞'],
    cardIds: [1], discount: { type: 'fixed', amount: 10 }, ...fields });
  return { id, rule, verifiedAt: null, records: new Map(state ? [[rule.cardIds[0], offerRecordSchema.parse(state)]] : []) };
}

describe('权益与活动', () => {
  it('只问商户也可查，上海时区正确理解周天、下周一与可选筛选', () => {
    const now = fromYmd(date);
    expect(extractOfferIntent('今晚吃海底捞，有什么优惠？', [], now)).toMatchObject({ merchant: '海底捞' });
    expect(extractOfferIntent('我要喝奈雪油什么优惠', [], now)).toMatchObject({ merchant: '奈雪' });
    expect(extractOfferIntent('下周一在北京吃海底捞，微信支付，预算 240 元', [], now))
      .toMatchObject({ merchant: '海底捞', city: '北京', channel: 'wechat', date: '2026-11-23', budget: 240 });
    expect(extractOfferIntent('周天喝喜茶', [], now)).toMatchObject({ date });
  });

  it('没填预算时按门槛比较同商户已持有卡，跳过尚未生效或不可用券', () => {
    const rows = [offer(1, { threshold: 100, cities: ['北京市'] }), offer(2, { cardIds: [2], threshold: 200, discount: { type: 'fixed', amount: 50 } }),
      offer(3, { cardIds: [4] }), offer(4, { endsOn: '2026-11-21' }), offer(5, { startsOn: '2026-11-23' }),
      offer(6, {}, { remaining: 0 }), offer(7, { weekdays: [1] })];
    const answer = compareOffers(rows, cards, { merchant: '海底捞火锅', city: '北京', date });
    expect(answer.results.map(({ offerId }) => offerId)).toEqual([1, 2]);
    expect(answer.tiers).toEqual([{ amount: 100, offerId: 1, cardId: 1 }, { amount: 200, offerId: 2, cardId: 2 }]);
  });

  it('积分估值、已领券、资格待确认和随机上限不会混成同一口径', () => {
    const points: RewardOfferInput['discount'] = { type: 'points', unit: 'UP金', amount: 30, cost: 2_000, purchasePrice: 1 };
    const rows = [offer(1, { discount: points, requiresClaim: true }), offer(2, { cardIds: [2], requiresClaim: true,
      discount: { type: 'points', unit: '积分', amount: 28, cost: 10_000 } }, { status: 'claimed', voucherEndsOn: '2026-11-23' }),
    offer(3, { cardIds: [3], discount: { type: 'random', max: 88 }, limited: true }),
    offer(4, { cardIds: [2], discount: { type: 'cashback', rate: 5, cap: 8 } }),
    offer(5, { discount: points, requiresClaim: true }, { status: 'claimed', voucherEndsOn: '2026-11-21' })];
    const { results } = compareOffers(rows, cards, { merchant: '海底捞', date, budget: 200 });
    expect(results.map(({ offerId, status }) => [offerId, status])).toEqual([[2, 'ready'], [4, 'ready'], [1, 'action'], [5, 'action'], [3, 'check']]);
    expect(results[0].quote).toMatchObject({ pay: 172, pointCost: null });
    expect(results[1].quote).toMatchObject({ pay: 200, cashback: 8, comparableCost: 192 });
    expect(results[2].quote).toMatchObject({ pay: 171, comparableCost: 177, pointCost: { cost: 2_000, balance: 5_000 } });
    expect(results[3].neededActions).toContain('先领券');
    expect(results[4].quote).toMatchObject({ pay: null, saving: 0, randomMax: 88, comparableCost: 200 });
  });

  it('只计算确认能同单叠加且支付方式兼容的同卡固定立减', () => {
    const rows = [
      offer(1, { stackWith: [2, 3, 4, 5], channels: ['wechat'], threshold: 100 }),
      offer(2, { stackWith: [1], channels: ['wechat', 'alipay'], threshold: 200, discount: { type: 'fixed', amount: 30 } }),
      offer(3, { channels: ['alipay'] }), offer(4, { cardIds: [2], channels: ['wechat'] }),
      offer(5, { requiresClaim: true }),
    ];
    const response = compareOffers(rows, cards, { merchant: '海底捞', date, budget: 200 });
    expect(response.prefersCombination).toBe(true);
    expect(response.combinations).toEqual([expect.objectContaining({ offerIds: [1, 2], saving: 40, pay: 160, channels: ['wechat'] })]);
    expect(compareOffers(rows, cards, { merchant: '海底捞', date, budget: 199 }).combinations).toEqual([]);
  });
});

describe('银行活动来源', () => {
  it('按明细和标题的日期交集导入中信活动，随机上限与最低价分开', () => {
    const html = `<p>活动时间：2026年6月1日至2026年11月30日</p>
      <div>微信满立减</div><p>满<strong>200元</strong>随机立减最高<strong>88元</strong></p>
      <p>海底捞火锅</p><div>支付宝满立减</div>
      <p>2026年11月1日至11月30日期间每日10点起</p>
      <p>海底捞火锅：到海底捞门店线下消费，使用微信支付时可参与本优惠活动</p>`;
    const parsed = parseOfficialOfferPage(offerSources[0], html);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ review: 'ready', rule: { startsOn: '2026-11-01', endsOn: '2026-11-30',
      startsAt: '10:00', threshold: 200, discount: { type: 'random', max: 88 }, channels: ['wechat'], limited: true } });
    expect(() => parseOfficialOfferPage(offerSources[0], '<p>无法显示此页</p>')).toThrow('页面结构已变');
  });

  it('官网目录只收本站活动链接并存为待核对草稿', () => {
    const to = '/promotion/national/20261101.html';
    const html = `<a href="${to}">信用卡周末消费立减优惠活动</a>
      <a href="${to}#again">信用卡周末消费立减优惠活动</a>
      <a href="https://example.org${to}">信用卡周末消费立减优惠活动</a>`;
    const parsed = parseOfficialOfferPage(offerSources[1], html);
    expect(parsed).toEqual([expect.objectContaining({ review: 'draft', rule: expect.objectContaining({
      merchants: [], sourceUrl: 'https://creditcard.cib.com.cn/promotion/national/20261101.html',
    }) })]);
  });
});

describe('收藏活动的 Bark 提醒', () => {
  beforeEach(() => vi.clearAllMocks());

  it('到期、领券与月底进度生成独立事件，已使用券跳过', async () => {
    const deadline = '2026-11-30';
    const spendRuleId = 'a'.repeat(24);
    const row = (id: number, fields: Partial<RewardOfferInput>, state: Partial<OfferRecordState>) => ({
      id, cardId: 1, state: { favorite: true, ...state }, card: cards[0], offer: { rule: offer(id, fields).rule },
    });
    recordRows.mockResolvedValue([
      row(1, { endsOn: deadline }, { reminder: 'expiry', status: 'claimed' }),
      row(2, { claimOn: '2026-11-28', claimAt: '12:00' }, { reminder: 'claim' }),
      row(3, { spendRuleId }, { reminder: 'month_end' }),
      row(4, { endsOn: deadline }, { reminder: 'expiry', status: 'used' }),
    ]);
    spendProgress.mockResolvedValue({ tracks: [{ rule: { id: spendRuleId }, periods: [{ startsOn: '2026-11-01', endsOn: deadline, bankCount: 6, remaining: 4 }] }] });
    const events = await collectOfferReminderEvents(fromYmd('2026-11-28'));
    expect(events.map(({ refId, type, channelType }) => [refId, type, channelType]))
      .toEqual([[1, 'offer_expiry', 'bark'], [2, 'offer_claim', 'bark'], [3, 'offer_month_end', 'bark']]);
    expect(events[0].fireDate).toEqual(fromYmd(deadline));
    expect(events[1].body).toContain('12:00');
  });
});
