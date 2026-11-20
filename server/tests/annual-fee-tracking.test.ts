import { describe, expect, it, vi } from 'vitest';
import { fromYmd } from '../src/lib/dates';
import { buildAnnualFeeTracking, needsAnnualFeeAction } from '../src/modules/bills/annual-fee-tracking';

vi.mock('../src/lib/prisma', () => ({ prisma: {} }));

type TrackingInputs = Parameters<typeof buildAnnualFeeTracking>;
type Bill = TrackingInputs[1][number];

const primary = { id: 1, bankName: '测试银行', cardLast4: '1111' };
const secondary = {
  id: 2, bankName: '测试银行', cardLast4: '2222', annualFeePolicy: { settlement: 'apply' },
};

function bill(id: number, date: string, lines: { cardId?: number; amount: number; description: string; currency?: string }[]): Bill {
  return {
    id, cardId: 1, period: date.slice(0, 7), statementDate: fromYmd(date), annualFeeAmount: null,
    currency: 'CNY', cards: [{ cardId: 2 }],
    transactions: lines.map(({ cardId, amount, description, currency }) => ({
      cardId: cardId ?? null, cardLast4: null, bankName: primary.bankName, description,
      amount, currency: currency ?? 'CNY',
    })),
  };
}

describe('年费减免记录', () => {
  const charge = bill(1, '2026-06-24', [{ cardId: 2, amount: 300, description: '信用卡年费' }]);
  const review = { cardId: 2, period: '2026-06', currency: 'CNY', status: 'requested' };

  it('合账中按明细卡归属，已还账单仍可提醒申请', () => {
    const paid = { ...charge, paidStatus: 'paid' };
    const ambiguous = bill(2, '2026-07-24', [{ amount: 300, description: '信用卡年费' }]);
    const rows = buildAnnualFeeTracking([primary, secondary], [paid, ambiguous], []);
    expect(rows.filter(needsAnnualFeeAction)).toEqual([
      expect.objectContaining({ cardId: 2, period: '2026-06', amount: 300, status: 'apply' }),
    ]);
  });

  it('下一账期同卡同币同额且唯一的明确退款会结束已申请状态', () => {
    const refund = bill(2, '2026-07-24', [{ cardId: 2, amount: -300, description: '年费冲销' }]);
    const rows = buildAnnualFeeTracking([primary, secondary], [charge, refund], [review]);
    expect(rows).toEqual([
      expect.objectContaining({ cardId: 2, status: 'refunded', refundDate: '2026-07-24', manualStatus: 'requested' }),
    ]);
    expect(rows.filter(needsAnnualFeeAction)).toEqual([]);
  });

  it('不同卡或币种及模糊描述不自动标记到账', () => {
    const unrelatedCredits = bill(2, '2026-07-24', [
      { cardId: 1, amount: -300, description: '年费退款' },
      { cardId: 2, amount: -300, description: '年费退款', currency: 'USD' },
      { cardId: 2, amount: -100, description: '积分兑换' },
      { cardId: 2, amount: -300, description: '信用卡年费' },
    ]);
    const [row] = buildAnnualFeeTracking([primary, secondary], [charge, unrelatedCredits], [review]);
    expect(row).toMatchObject({ status: 'requested', refundDate: null, refundAmount: 0, remainingAmount: 300 });
  });

  it('跨账期识别积分换年费，累计抵扣仍保留待处理，抵足后才结案', () => {
    const original = bill(1, '2026-01-26', [{ cardId: 2, amount: 680, description: '年费' }]);
    const next = bill(2, '2026-02-26', [{ cardId: 2, amount: -300, description: '积分换年费' }]);
    next.transactions![0].transactionDate = fromYmd('2026-01-27');
    const [partial] = buildAnnualFeeTracking([primary, secondary], [next, original], []);
    expect(partial).toMatchObject({
      amount: 680, refundAmount: 300, remainingAmount: 380, refundDate: '2026-01-27',
      period: '2026-01', status: 'apply',
    });
    expect(needsAnnualFeeAction(partial)).toBe(true);

    const last = bill(3, '2026-03-26', [{ cardId: 2, amount: -380, description: '年费返还' }]);
    const [complete] = buildAnnualFeeTracking([primary, secondary], [last, next, original], []);
    expect(complete).toMatchObject({ refundAmount: 680, remainingAmount: 0, status: 'refunded' });
    expect(needsAnnualFeeAction(complete)).toBe(false);
  });

  it('部分抵扣有多个候选或累计超出原扣费时留待人工确认', () => {
    const secondCharge = bill(2, '2026-07-24', [{ cardId: 2, amount: 680, description: '信用卡年费' }]);
    const credit = bill(3, '2026-08-24', [{ cardId: 2, amount: -100, description: '积分兑换年费' }]);
    const competing = buildAnnualFeeTracking([primary, secondary], [charge, secondCharge, credit], []);
    expect(competing.map((row) => row.refundAmount)).toEqual([0, 0]);

    const extra = bill(4, '2026-09-24', [{ cardId: 2, amount: -250, description: '年费减免' }]);
    const [overTotal] = buildAnnualFeeTracking([primary, secondary], [charge, credit, extra], []);
    expect(overTotal).toMatchObject({ status: 'apply', refundAmount: 0, remainingAmount: 300 });
  });

  it('同一笔退款有多笔同额扣费候选时留待人工确认', () => {
    const repeatedCharge = bill(2, '2026-07-24', [{ cardId: 2, amount: 300, description: '信用卡年费' }]);
    const refund = bill(3, '2026-08-24', [{ cardId: 2, amount: -300, description: '年费退款' }]);
    const rows = buildAnnualFeeTracking([primary, secondary], [charge, repeatedCharge, refund], [
      { ...review, status: 'refunded' },
    ]);
    expect(rows.map((row) => [row.status, row.refundDate])).toEqual([['apply', null], ['refunded', null]]);
  });

  it('自动退回的卡等待到账，手动结案按扣费账期分别保存', () => {
    const automatic = { ...secondary, annualFeePolicy: { settlement: 'automaticRefund' } };
    const nextCharge = bill(2, '2027-06-24', [{ cardId: 2, amount: 300, description: '信用卡年费' }]);
    const rows = buildAnnualFeeTracking([primary, automatic], [charge, nextCharge], [
      { ...review, status: 'closed' },
    ]);
    expect(rows.map((row) => row.status)).toEqual(['waiting', 'closed']);
    expect(rows.filter(needsAnnualFeeAction)).toEqual([]);
  });
});
