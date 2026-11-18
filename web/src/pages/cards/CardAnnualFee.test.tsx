import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CardAnnualFeePolicy } from '../../api/types';
import { CardAnnualFeeSummary } from './CardAnnualFee';

describe('卡片年费进度', () => {
  const policy: CardAnnualFeePolicy = {
    charge: 'annual', amount: 300, currency: 'CNY', waiver: 'either',
    requiredCount: 6, confirmedCount: 4, cycleEnd: '2027-03-15',
    requiredPoints: 40_000, availablePoints: 35_000,
  };

  it('显示本期还差的有效次数与积分，次日进入已截止状态', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2027, 2, 15, 12));
      const onEdit = vi.fn();
      const { rerender } = render(<CardAnnualFeeSummary policy={policy} onEdit={onEdit} />);
      expect(screen.getByText(/还差 2 笔/)).toBeTruthy();
      expect(screen.getByText(/还差 5,000 积分/)).toBeTruthy();

      vi.setSystemTime(new Date(2027, 2, 16, 12));
      rerender(<CardAnnualFeeSummary policy={policy} onEdit={onEdit} />);
      expect(screen.getByText(/本期刷卡减免已截止/)).toBeTruthy();
      expect(screen.queryByText(/还差 2 笔/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('有效次数未填写时显示待核对', () => {
    render(<CardAnnualFeeSummary policy={{ ...policy, cycleEnd: undefined, confirmedCount: undefined }} onEdit={vi.fn()} />);
    expect(screen.getByText(/需刷 6 笔 · 进度待核对/)).toBeTruthy();
    expect(screen.queryByText(/还差 6 笔/)).toBeNull();
  });
});
