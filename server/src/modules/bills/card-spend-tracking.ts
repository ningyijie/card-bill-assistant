import { z } from 'zod';
import { addDays, fromYmd, lastDayOfMonth, periodOf, ymd } from '../../lib/dates';

const monthSchema = z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/, '请选择有效月份');
export const spendDateSchema = z.iso.date().refine((value) => value >= '1000-01-01', '请选择有效日期');
export const spendAmountSchema = z.number().nonnegative().max(999_999_999.99)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.0001, '金额最多两位小数');
export const spendRuleIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
export const annualFeeWaivers = ['none', 'count', 'points', 'either', 'spend', 'spend_or_points', 'other'] as const;
const amountFields = {
  id: spendRuleIdSchema,
  name: z.string().trim().min(1, '请填写跟踪名称').max(48),
  currency: z.string().regex(/^[A-Z]{3}$/, '请输入三位币种代码'),
  amount: spendAmountSchema.refine((value) => value >= 0.01, '目标金额至少为 0.01'),
};

const spendRuleSchema = z.discriminatedUnion('basis', [
  z.object({
    ...amountFields,
    basis: z.enum(['statement_month', 'calendar_month']),
    start: monthSchema,
    end: monthSchema.optional(),
    consecutive: z.number().int().min(1).max(24).default(1),
  }),
  z.object({
    ...amountFields,
    basis: z.literal('date_range'),
    start: spendDateSchema,
    end: spendDateSchema,
  }),
]).refine((rule) => !rule.end || rule.end >= rule.start, '截止时间不能早于开始时间');

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
  if (rule.basis === 'date_range') {
    return [{ key: `range:${rule.start}:${rule.end}:${rule.currency}`, label: `${rule.start} 至 ${rule.end}`,
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
      key: `${rule.basis}:${month}:${rule.currency}`,
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

export function buildSpendProgress(
  rules: SpendRule[],
  transactions: SpendTransaction[],
  confirmations: { ruleId: string; periodKey: string; amount: number }[],
  now: Date,
  statementDay: number,
  statementDates: ReadonlyMap<string, Date>,
) {
  const confirmationByKey = new Map(confirmations.map((row) => [`${row.ruleId}:${row.periodKey}`, row.amount]));
  const estimatesByMonth = new Map<string, number>();
  const totalsByDate = new Map<string, Map<string, number>>();
  const todayText = ymd(now);
  for (const transaction of transactions) {
    const cents = estimatedCents(transaction);
    if (transaction.statementPeriod) {
      const key = `statement_month:${transaction.statementPeriod}:${transaction.currency}`;
      estimatesByMonth.set(key, (estimatesByMonth.get(key) ?? 0) + cents);
    }
    if (transaction.transactionDate) {
      const date = ymd(transaction.transactionDate);
      const key = `calendar_month:${date.slice(0, 7)}:${transaction.currency}`;
      estimatesByMonth.set(key, (estimatesByMonth.get(key) ?? 0) + cents);
      const totals = totalsByDate.get(transaction.currency) ?? new Map<string, number>();
      totals.set(date, (totals.get(date) ?? 0) + cents);
      totalsByDate.set(transaction.currency, totals);
    }
  }

  return rules.map((rule) => {
    let bankRun = 0;
    let estimatedRun = 0;
    let bankStreak = 0;
    let estimatedStreak = 0;
    const target = Math.round(rule.amount * 100);
    const periods = spendPeriods(rule, now, statementDay, statementDates).map((period) => {
      const bankAmount = confirmationByKey.get(`${rule.id}:${period.key}`) ?? null;
      let estimate = estimatesByMonth.get(period.key);
      if (rule.basis === 'date_range') {
        for (const [date, cents] of totalsByDate.get(rule.currency) ?? []) {
          if (date >= rule.start && date <= rule.end) estimate = (estimate ?? 0) + cents;
        }
      }
      const estimatedAmount = estimate === undefined ? null : Math.max(0, estimate) / 100;
      const amount = bankAmount ?? estimatedAmount;
      const cents = amount === null ? null : Math.round(amount * 100);
      const met = cents !== null && cents >= target;
      bankRun = met && bankAmount !== null ? bankRun + 1 : 0;
      estimatedRun = met ? estimatedRun + 1 : 0;
      bankStreak = Math.max(bankStreak, bankRun);
      estimatedStreak = Math.max(estimatedStreak, estimatedRun);
      return { ...period, bankAmount, estimatedAmount,
        remaining: cents === null ? null : Math.max(0, target - cents) / 100,
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
