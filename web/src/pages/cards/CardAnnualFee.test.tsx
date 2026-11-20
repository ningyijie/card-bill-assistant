import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CardAnnualFeePolicy } from '../../api/types';
import { CardAnnualFeeFields, CardAnnualFeeSummary, validateAnnualFeePolicy } from './CardAnnualFee';

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

  it('收费方式和减免条件为空时仍可填写其他字段，清空币种时保留金额', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<CardAnnualFeeFields value={null} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('规则备注'), { target: { value: '柜台申请' } });
    expect(onChange).toHaveBeenLastCalledWith({ notes: '柜台申请' });
    expect(screen.getByLabelText('需刷次数')).toBeTruthy();
    expect(screen.getByLabelText('所需积分')).toBeTruthy();

    rerender(<CardAnnualFeeFields value={{ amount: 300, currency: 'USD' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('币种'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ amount: 300, currency: undefined });
    await expect(validateAnnualFeePolicy(null, { amount: 300, waiver: 'either', confirmedCount: 0 })).resolves.toBeUndefined();
    await expect(validateAnnualFeePolicy(null, { currency: 'CN' })).rejects.toThrow();
  });

  it('只填写金额或部分进度时如实展示', () => {
    render(<CardAnnualFeeSummary policy={{ amount: 300, confirmedCount: 0, availablePoints: 1_200 }} onEdit={vi.fn()} />);
    expect(screen.getByText('标准年费 300.00')).toBeTruthy();
    expect(screen.getByText('银行已确认 0 笔')).toBeTruthy();
    expect(screen.getByText('当前可用 1,200 积分')).toBeTruthy();
  });

  it('添加消费规则会打开独立的账单月设置', () => {
    const onChange = vi.fn();
    const { rerender } = render(<CardAnnualFeeFields value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '添加消费跟踪规则' }));
    const draft = onChange.mock.calls[0][0];
    expect(draft.spendRules[0]).toMatchObject({ basis: 'statement_month', consecutive: 1, currency: 'CNY' });
    rerender(<CardAnnualFeeFields value={draft} onChange={onChange} />);
    expect(screen.getByLabelText('首个账单月')).toBeTruthy();
    expect(screen.getByLabelText('每期目标金额')).toBeTruthy();
    expect(screen.getByLabelText('连续达标期数')).toBeTruthy();
  });
});
