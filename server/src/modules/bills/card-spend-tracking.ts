import { z } from 'zod';
import { addDays, fromYmd, lastDayOfMonth, periodOf, ymd } from '../../lib/dates';

const monthSchema = z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/, '请选择有效月份');
export const spendDateSchema = z.iso.date().refine((value) => value >= '1000-01-01', '请选择有效日期');
export const spendAmountSchema = z.number().nonnegative().max(999_999_999.99)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.0001, '金额最多两位小数');
export const spendRuleIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
export const annualFeeWaivers = ['none', 'count', 'points', 'either', 'spend', 'spend_or_points', 'other'] as const;
export const spendCountSchema = z.number().int().min(0).max(100_000);
const positiveAmount = spendAmountSchema.refine((value) => value >= 0.01, '目标金额至少为 0.01');
const ruleFields = {
  id: spendRuleIdSchema,
  name: z.string().trim().min(1, '请填写跟踪名称').max(48),
  currency: z.string().regex(/^[A-Z]{3}$/, '请输入三位币种代码'),
  cashback: z.object({
    rate: positiveAmount.refine((value) => value <= 100, '返现比例不能超过 100%'),
    cap: positiveAmount,
  }).optional(),
};

const spendRulePeriod = z.discriminatedUnion('basis', [
  z.object({
    ...ruleFields,
    basis: z.enum(['statement_month', 'calendar_month']),
    start: monthSchema,
    end: monthSchema.optional(),
    consecutive: z.number().int().min(1).max(24).default(1),
  }),
  z.object({
    ...ruleFields,
    basis: z.literal('date_range'),
    start: spendDateSchema,
    end: spendDateSchema,
  }),
]);
const spendRuleTarget = z.union([
  z.object({ metric: z.literal('amount').optional(), amount: positiveAmount }),
  z.object({ metric: z.literal('count'), count: spendCountSchema.min(1) }),
]);
const spendRuleSchema = z.intersection(spendRulePeriod, spendRuleTarget)
  .refine((rule) => !rule.end || rule.end >= rule.start, '截止时间不能早于开始时间');

export const spendRulesSchema = z.array(spendRuleSchema).max(12)
  .refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, '消费跟踪规则不能重复');
export type SpendRule = z.infer<typeof spendRuleSchema>;

export function readSpendRules(policy: unknown): SpendRule[] {
  const result = z.object({ spendRules: spendRulesSchema.default([]) }).safeParse(policy);
  return result.success ? result.data.spendRules : [];
}

interface SpendTransaction {
  amount: number;
  currency: string;
  description: string;
  transactionDate: Date | null;
  statementPeriod: string | null;
}

interface SpendPeriod {
  key: string;
  label: string;
  startsOn: string;
  endsOn: string;
}

const monthOffset = (period: string, offset: number): string => {
  const [year, month] = period.split('-').map(Number);
  const total = year * 12 + month - 1 + offset;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String(total % 12 + 1).padStart(2, '0')}`;
};

function monthEnd(period: string, day: number): Date {
  const [year, month] = period.split('-').map(Number);
  return fromYmd(`${period}-${String(Math.min(day, lastDayOfMonth(year, month))).padStart(2, '0')}`);
}

export function spendPeriods(
  rule: SpendRule,
  now: Date,
  statementDay: number,
  statementDates: ReadonlyMap<string, Date>,
): SpendPeriod[] {
  // 确认金额和确认笔数各自保留，切换统计方式时不会误用之前的数值。
  const scope = rule.metric === 'count' ? 'count' : rule.currency;
  if (rule.basis === 'date_range') {
    return [{ key: `range:${rule.start}:${rule.end}:${scope}`, label: `${rule.start} 至 ${rule.end}`,
      startsOn: rule.start, endsOn: rule.end }];
  }
  const statementEnd = (period: string) => statementDates.get(period) ?? monthEnd(period, statementDay);
  const calendarMonth = periodOf(now);
  const statement = rule.basis === 'statement_month';
  const current = statement && now > statementEnd(calendarMonth) ? monthOffset(calendarMonth, 1) : calendarMonth;
  // 尚未开始时显示首期，方便核对跟踪起点。已结束的规则停在截止月。
  const elapsed = current < rule.start ? rule.start : current;
  const last = rule.end && rule.end < elapsed ? rule.end : elapsed;
  const periods: SpendPeriod[] = [];
  for (let month = rule.start; month <= last; month = monthOffset(month, 1)) {
    periods.push({
      key: `${rule.basis}:${month}:${scope}`,
      label: month,
      startsOn: statement ? ymd(addDays(statementEnd(monthOffset(month, -1)), 1)) : `${month}-01`,
      endsOn: ymd(statement ? statementEnd(month) : monthEnd(month, 31)),
    });
    if (month === last) break;
  }
  return periods;
}

/** 常见非消费项目不计入估算。银行对渠道和计积分的判定以人工确认金额为准。 */
function estimatedCents(transaction: SpendTransaction): number {
  if (/年费|还款|还本|溢缴款|利息|违约金|罚息|滞纳金|手续费|取现|预借现金|转账|分期|积分兑换|刷卡金|返现|预授权/.test(transaction.description)) return 0;
  if (transaction.amount > 0 || /退款|退货|撤销|冲正/.test(transaction.description)) {
    return Math.round(transaction.amount * 100);
  }
  return 0;
}

interface SpendTotal {
  cents: number;
  count: number;
  latestOn: string | null;
}

function addTotal(totals: Map<string, SpendTotal>, key: string, cents: number, date: string | null) {
  const current = totals.get(key) ?? { cents: 0, count: 0, latestOn: null };
  current.cents += cents;
  if (cents > 0) current.count++;
  if (date && (!current.latestOn || current.latestOn < date)) current.latestOn = date;
  totals.set(key, current);
}

export function buildSpendProgress(
  rules: SpendRule[],
  transactions: SpendTransaction[],
  confirmations: { ruleId: string; periodKey: string; amount: number }[],
  now: Date,
  statementDay: number,
  statementDates: ReadonlyMap<string, Date>,
) {
  const confirmationByKey = new Map(confirmations.map((row) => [`${row.ruleId}:${row.periodKey}`, row.amount]));
  const estimatesByMonth = new Map<string, SpendTotal>();
  const totalsByDate = new Map<string, Map<string, SpendTotal>>();
  const todayText = ymd(now);
  for (const transaction of transactions) {
    const cents = estimatedCents(transaction);
    const date = transaction.transactionDate ? ymd(transaction.transactionDate) : null;
    // 金额按入账币种分开，笔数按本卡全部已导入的消费累计。
    for (const scope of [transaction.currency, 'count']) {
      if (transaction.statementPeriod) {
        addTotal(estimatesByMonth, `statement_month:${transaction.statementPeriod}:${scope}`, cents, date);
      }
      if (date) {
        addTotal(estimatesByMonth, `calendar_month:${date.slice(0, 7)}:${scope}`, cents, date);
        const totals = totalsByDate.get(scope) ?? new Map<string, SpendTotal>();
        addTotal(totals, date, cents, date);
        totalsByDate.set(scope, totals);
      }
    }
  }

  return rules.map((rule) => {
    let bankRun = 0;
    let estimatedRun = 0;
    let bankStreak = 0;
    let estimatedStreak = 0;
    const byCount = rule.metric === 'count';
    const target = byCount ? rule.count : Math.round(rule.amount * 100);
    const periods = spendPeriods(rule, now, statementDay, statementDates).map((period) => {
      const confirmed = confirmationByKey.get(`${rule.id}:${period.key}`) ?? null;
      let estimate = estimatesByMonth.get(period.key);
      if (rule.basis === 'date_range') {
        for (const [date, total] of totalsByDate.get(byCount ? 'count' : rule.currency) ?? []) {
          if (date < rule.start || date > rule.end) continue;
          const aggregate = estimate ??= { cents: 0, count: 0, latestOn: null };
          aggregate.cents += total.cents;
          aggregate.count += total.count;
          if (!aggregate.latestOn || aggregate.latestOn < date) aggregate.latestOn = date;
        }
      }
      const units = confirmed === null
        ? estimate === undefined ? null : byCount ? estimate.count : Math.max(0, estimate.cents)
        : byCount ? confirmed : Math.round(confirmed * 100);
      const met = units !== null && units >= target;
      bankRun = met && confirmed !== null ? bankRun + 1 : 0;
      estimatedRun = met ? estimatedRun + 1 : 0;
      bankStreak = Math.max(bankStreak, bankRun);
      estimatedStreak = Math.max(estimatedStreak, estimatedRun);
      return { ...period,
        bankAmount: byCount ? null : confirmed,
        estimatedAmount: !byCount && estimate ? Math.max(0, estimate.cents) / 100 : null,
        ...(byCount ? { bankCount: confirmed, estimatedCount: estimate?.count ?? null, lastTransactionOn: estimate?.latestOn ?? null } : {}),
        remaining: units === null ? null : Math.max(0, target - units) / (byCount ? 1 : 100),
        canConfirm: period.startsOn <= todayText };
    });
    return { rule, periods, bankStreak, estimatedStreak };
  });
}

export function buildAnnualFeeSpendEligibility(
  policy: unknown,
  progress: ReturnType<typeof buildSpendProgress>,
  now: Date,
) {
  const parsed = z.object({
    waiver: z.enum(['spend', 'spend_or_points']),
    annualFeeSpendRuleId: spendRuleIdSchema.optional(),
    requiredPoints: z.number().int().positive().optional(),
    availablePoints: z.number().int().nonnegative().optional(),
    pointsDeadline: spendDateSchema.optional(),
  }).safeParse(policy);
  if (!parsed.success) return null;
  const config = parsed.data;
  const selected = progress.find(({ rule }) => rule.id === config.annualFeeSpendRuleId);
  const requiredPeriods = selected && selected.rule.basis !== 'date_range' ? selected.rule.consecutive : 1;
  const spend = selected ? {
    name: selected.rule.name,
    confirmed: selected.bankStreak,
    estimated: selected.estimatedStreak,
    required: requiredPeriods,
    met: selected.bankStreak >= requiredPeriods,
  } : null;
  const expired = config.pointsDeadline !== undefined && config.pointsDeadline < ymd(now);
  const target = config.requiredPoints ?? null;
  const available = config.availablePoints ?? null;
  const remaining = target !== null && available !== null ? Math.max(0, target - available) : null;
  const points = config.waiver === 'spend_or_points' ? {
    target, available, remaining, deadline: config.pointsDeadline ?? null,
    expired, met: !expired && remaining === 0,
  } : null;
  return { met: Boolean(spend?.met || points?.met), spend, points };
}
