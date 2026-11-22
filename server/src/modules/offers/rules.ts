import { z } from 'zod';

const words = (max = 80) => z.string().trim().min(1).max(max);
const list = (max = 20) => z.array(words(60)).max(max).default([]);
const money = z.number().min(0).max(999_999).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-5);
const positiveMoney = money.refine((value) => value > 0, '请填写大于零的金额');
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const date = z.iso.date();
export const channels = ['wechat', 'alipay', 'unionpay', 'bank_app', 'pos', 'merchant_app'] as const;
export const networks = ['银联', 'Visa', '万事达', '美国运通', 'JCB', '其他'] as const;
export const pointsKinds = ['积分', 'UP金'] as const;
export const idSchema = z.coerce.number().int().positive();
export const safeOfficialUrl = z.string().max(600).pipe(z.url()).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, '请输入 HTTPS 活动原文链接');

const discount = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fixed'), amount: positiveMoney }),
  z.object({ type: z.literal('percent'), rate: z.number().positive().max(100), cap: positiveMoney.optional() }),
  z.object({ type: z.literal('random'), min: money.optional(), max: positiveMoney }),
  z.object({ type: z.literal('points'), amount: positiveMoney, cost: z.number().int().positive().max(100_000_000),
    unit: z.enum(pointsKinds), purchasePrice: money.optional() }),
  z.object({ type: z.literal('cashback'), rate: z.number().positive().max(100), cap: positiveMoney.optional() }),
  z.object({ type: z.literal('service') }),
]);

export const offerSchema = z.object({
  title: words(120),
  kind: z.enum(['activity', 'benefit']),
  merchants: list(32),
  cities: list(),
  stores: list(40),
  channels: z.array(z.enum(channels)).max(channels.length).default([]),
  bankName: words(40).optional(),
  product: words().optional(),
  network: z.enum(networks).optional(),
  cardIds: z.array(idSchema).max(60).default([]),
  startsOn: date.optional(),
  endsOn: date.optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  startsAt: clock.optional(),
  endsAt: clock.optional(),
  claimOn: date.optional(),
  claimAt: clock.optional(),
  threshold: money.optional(),
  discount,
  requiresClaim: z.boolean().default(false),
  requiresRegistration: z.boolean().default(false),
  needsEligibility: z.boolean().default(false),
  limited: z.boolean().default(false),
  stacking: words(250).optional(),
  stackWith: z.array(idSchema).max(12).default([]),
  cycle: z.enum(['month', 'year', 'once']).optional(),
  totalUses: z.number().int().positive().max(10_000).optional(),
  spendRuleId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  entry: words(300).optional(),
  sourceUrl: safeOfficialUrl.optional(),
  sourceText: words(8_000).optional(),
}).superRefine((row, ctx) => {
  if (row.startsOn && row.endsOn && row.endsOn < row.startsOn) {
    ctx.addIssue({ code: 'custom', path: ['endsOn'], message: '活动结束日不能早于开始日' });
  }
  if (row.startsAt && row.endsAt && row.endsAt <= row.startsAt) {
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: '结束时段应晚于开始时段' });
  }
  if (row.discount.type === 'random' && (row.discount.min ?? 0) > row.discount.max) {
    ctx.addIssue({ code: 'custom', path: ['discount', 'min'], message: '随机立减下限不能高于上限' });
  }
  if (row.stackWith.length && row.discount.type !== 'fixed') {
    ctx.addIssue({ code: 'custom', path: ['stackWith'], message: '只有按原订单金额判断门槛的固定立减可以合并计算' });
  }
});
export type RewardOfferInput = z.infer<typeof offerSchema>;
export const offerWriteSchema = z.object({ rule: offerSchema, review: z.enum(['ready', 'draft']).default('ready') })
  .refine(({ rule, review }) => review === 'draft' || rule.kind === 'benefit' || rule.merchants.length > 0,
    { path: ['rule','merchants'], message: '发布限时活动时，请填写可查询的商户' });

export const cardProfileSchema = z.object({
  product: words().optional(),
  network: z.enum(networks).optional(),
  points: z.number().int().min(0).max(100_000_000).optional(),
  upGold: z.number().int().min(0).max(100_000_000).optional(),
  valuePer1000Points: money.optional(),
  valuePer1000UpGold: money.optional(),
});
export type CardProfile = z.infer<typeof cardProfileSchema>;

export const offerRecordSchema = z.object({
  favorite: z.boolean().default(false),
  status: z.enum(['tracked', 'registered', 'claimed', 'used']).default('tracked'),
  eligible: z.boolean().optional(),
  remaining: z.number().int().min(0).max(10_000).optional(),
  voucherEndsOn: date.optional(),
  reminder: z.enum(['claim', 'expiry', 'month_end']).optional(),
});
export type OfferRecordState = z.infer<typeof offerRecordSchema>;

export const offerQuerySchema = z.object({
  merchant: words(80),
  city: words(60).optional(),
  store: words(100).optional(),
  date: date.optional(),
  time: clock.optional(),
  budget: money.optional(),
  channel: z.enum(channels).optional(),
});
export type OfferQuery = z.infer<typeof offerQuerySchema>;

export function readOfferRule(value: unknown): RewardOfferInput | undefined {
  const result = offerSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function readCardProfile(value: unknown): CardProfile {
  const result = cardProfileSchema.safeParse(value);
  return result.success ? result.data : {};
}

export function readOfferRecord(value: unknown): OfferRecordState {
  const result = offerRecordSchema.safeParse(value);
  return result.success ? result.data : { favorite: false, status: 'tracked' };
}
