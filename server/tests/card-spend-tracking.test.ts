import { describe, expect, it } from 'vitest';
import { fromYmd } from '../src/lib/dates';
import { buildAnnualFeeSpendEligibility, buildSpendProgress, readSpendRules, type SpendRule } from '../src/modules/bills/card-spend-tracking';

const base = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: '消费达标', amount: 5000, currency: 'CNY' };
const statementRule: SpendRule = { ...base, basis: 'statement_month', start: '2026-01', consecutive: 2 };
const calendarRule: SpendRule = { ...base, id: 'bbbbbbbbbbbbbbbbbbbbbbbb', basis: 'calendar_month', start: '2026-01', consecutive: 1 };
const now = fromYmd('2026-04-01');
type Transaction = Parameters<typeof buildSpendProgress>[1][number];

function transaction(amount: number, date: string, statementPeriod: string, overrides: Partial<Transaction> = {}): Transaction {
  return { amount, currency: 'CNY', description: '商户消费', transactionDate: fromYmd(date), statementPeriod, ...overrides };
}

describe('消费达标跟踪', () => {
  it('同一交易分别按实际账单期和交易日统计，排除费用与其他币种', () => {
    const [statement, calendar] = buildSpendProgress([statementRule, calendarRule], [
      transaction(5000, '2026-01-27', '2026-02'),
      transaction(200, '2026-01-27', '2026-02', { description: '年费' }),
      transaction(-100, '2026-01-28', '2026-02', { description: '原交易退款' }),
      transaction(800, '2026-01-28', '2026-02', { currency: 'USD' }),
    ], [], now, 25, new Map([['2026-01', fromYmd('2026-01-26')], ['2026-02', fromYmd('2026-02-25')]]));
    expect(statement.periods[1]).toMatchObject({
      label: '2026-02', startsOn: '2026-01-27', endsOn: '2026-02-25', estimatedAmount: 4900, remaining: 100,
    });
    expect(statement.periods[0].estimatedAmount).toBeNull();
    expect(calendar.periods[0]).toMatchObject({ label: '2026-01', estimatedAmount: 4900, remaining: 100 });
    expect(calendar.periods[1].estimatedAmount).toBeNull();
  });

  it('缺少账单的月份中断连续计算，银行确认优先，已完成的区间保留达标结果', () => {
    const [progress] = buildSpendProgress([{ ...statementRule, end: '2026-03' }], [
      transaction(5200, '2026-01-12', '2026-01'),
      transaction(5300, '2026-03-10', '2026-03'),
    ], [{ ruleId: base.id, periodKey: 'statement_month:2026-01:CNY', amount: 0 }], now, 26, new Map());
    expect(progress.periods).toHaveLength(3);
    expect(progress.periods[0]).toMatchObject({ bankAmount: 0, estimatedAmount: 5200, remaining: 5000 });
    expect(progress.periods[1].remaining).toBeNull();
    expect(progress).toMatchObject({ bankStreak: 0, estimatedStreak: 1 });

    const [confirmed] = buildSpendProgress([statementRule], [], [
      { ruleId: base.id, periodKey: 'statement_month:2026-01:CNY', amount: 5000 },
      { ruleId: base.id, periodKey: 'statement_month:2026-02:CNY', amount: 5000 },
      { ruleId: base.id, periodKey: 'statement_month:2026-03:CNY', amount: 4800 },
    ], now, 26, new Map());
    expect(confirmed).toMatchObject({ bankStreak: 2, estimatedStreak: 2 });
  });

  it('指定日期的起止当天均计入，其他日期和未定日期跳过', () => {
    const [progress] = buildSpendProgress([{ ...base, basis: 'date_range', start: '2026-01-15', end: '2026-03-15' }], [
      transaction(10, '2026-01-14', '2026-01'),
      transaction(2000, '2026-01-15', '2026-01'),
      transaction(3000, '2026-03-15', '2026-03'),
      transaction(10, '2026-03-16', '2026-03'),
      transaction(10, '2026-03-15', '2026-03', { transactionDate: null }),
    ], [], now, 26, new Map());
    expect(progress.periods).toEqual([expect.objectContaining({ estimatedAmount: 5000, remaining: 0 })]);
  });

  it('首期尚未开始时仍显示日期，旧版卡片无需消费规则', () => {
    const [progress] = buildSpendProgress([{ ...calendarRule, start: '2026-05' }], [], [], now, 31, new Map());
    expect(progress.periods).toEqual([expect.objectContaining({ label: '2026-05', canConfirm: false })]);
    expect(readSpendRules({ amount: 680 })).toEqual([]);
  });

  it('按交易日在自然月估算笔数，显示最近导入日期，并保留独立的银行确认', () => {
    const rule = {
      id: base.id, name: '文旅卡返现', basis: 'calendar_month', start: '2026-01', currency: 'CNY',
      metric: 'count', count: 10, cashback: { rate: 1, cap: 100 },
    };
    const rules = readSpendRules({ spendRules: [rule] });
    expect(rules[0]).toMatchObject(rule);
    expect(readSpendRules({ spendRules: [{ ...rule, count: 9.5 }] })).toEqual([]);
    const [progress] = buildSpendProgress(rules, [
      transaction(1, '2026-01-31', '2026-02'),
      transaction(2, '2026-01-31', '2026-02'),
      transaction(-1, '2026-01-31', '2026-02', { description: '原交易退款' }),
      transaction(500, '2026-02-01', '2026-02', { description: '年费' }),
      transaction(10, '2026-02-01', '2026-02', { currency: 'USD' }),
    ], [
      { ruleId: rule.id, periodKey: 'calendar_month:2026-01:CNY', amount: 5000 },
      { ruleId: rule.id, periodKey: 'calendar_month:2026-02:count', amount: 8 },
    ], now, 26, new Map());
    expect(progress.periods[0]).toMatchObject({
      label: '2026-01', bankCount: null, estimatedCount: 2, remaining: 8, lastTransactionOn: '2026-01-31',
    });
    expect(progress.periods[1]).toMatchObject({ label: '2026-02', bankCount: 8, estimatedCount: 1, remaining: 2 });
    expect(progress.periods[2]).toMatchObject({ label: '2026-03', bankCount: null, estimatedCount: null, remaining: null });
  });

  it.each(['statement_month', 'calendar_month'] as const)('年费使用 %s 时，银行确认达标或积分足够即满足任一条件', (basis) => {
    const rule: SpendRule = { ...statementRule, basis, consecutive: 2 };
    const progress = buildSpendProgress([rule], [], [
      { ruleId: rule.id, periodKey: `${basis}:2026-01:CNY`, amount: 5000 },
      { ruleId: rule.id, periodKey: `${basis}:2026-02:CNY`, amount: 5000 },
    ], now, 26, new Map());
    const policy = { waiver: 'spend_or_points', annualFeeSpendRuleId: rule.id,
      requiredPoints: 50000, availablePoints: 49000, pointsDeadline: '2026-04-01' };
    expect(buildAnnualFeeSpendEligibility(policy, progress, now)).toMatchObject({
      met: true, spend: { met: true, confirmed: 2, required: 2 }, points: { met: false, remaining: 1000 },
    });
    const enoughPoints = { ...policy, availablePoints: 50000 };
    expect(buildAnnualFeeSpendEligibility(enoughPoints, [], now)).toMatchObject({
      met: true, spend: null, points: { met: true, expired: false },
    });
    expect(buildAnnualFeeSpendEligibility(enoughPoints, [], fromYmd('2026-04-02'))).toMatchObject({
      met: false, points: { met: false, expired: true },
    });
  });

  it('估算达标需核对，另一条已确认的活动规则不计入年费', () => {
    const rule: SpendRule = { ...statementRule, consecutive: 1 };
    const progress = buildSpendProgress([rule, calendarRule], [
      transaction(5100, '2026-01-27', '2026-02'),
    ], [
      { ruleId: calendarRule.id, periodKey: 'calendar_month:2026-01:CNY', amount: 5100 },
    ], now, 26, new Map());
    expect(buildAnnualFeeSpendEligibility({
      waiver: 'spend', annualFeeSpendRuleId: rule.id,
    }, progress, now)).toMatchObject({
      met: false, spend: { met: false, confirmed: 0, estimated: 1 }, points: null,
    });
  });
});
