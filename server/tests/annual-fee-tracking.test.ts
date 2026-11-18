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

  it('不同卡或币种、部分退款及模糊描述不自动标记到账', () => {
    const unrelatedCredits = bill(2, '2026-07-24', [
      { cardId: 1, amount: -300, description: '年费退款' },
      { cardId: 2, amount: -300, description: '年费退款', currency: 'USD' },
      { cardId: 2, amount: -100, description: '年费退款' },
      { cardId: 2, amount: -300, description: '信用卡年费' },
    ]);
    const [row] = buildAnnualFeeTracking([primary, secondary], [charge, unrelatedCredits], [review]);
    expect(row).toMatchObject({ status: 'requested', refundDate: null });
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
