import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { CardAnnualFeePolicy, CardSpendRule } from '../../api/types';
import { CardAnnualFeeFields, CardAnnualFeeSummary, validateAnnualFeePolicy } from './CardAnnualFee';
import { CardSpendProgress } from './CardSpendProgress';

const countRule: CardSpendRule = {
  id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: '文旅卡返现', basis: 'calendar_month', start: '2026-11',
  currency: 'CNY', metric: 'count', count: 10, cashback: { rate: 1, cap: 100 },
};

afterEach(() => vi.restoreAllMocks());

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

  it('配置单卡自然月笔数和次月返现，无需填写年费', async () => {
    const policy = { spendRules: [countRule] };
    render(<CardAnnualFeeFields value={policy} />);
    expect(screen.getByLabelText('目标消费笔数')).toHaveProperty('value', '10');
    expect(screen.getByLabelText('次月返现比例')).toHaveProperty('value', '1.00');
    expect(screen.getByLabelText('次月返现上限')).toHaveProperty('value', '100.00');
    await expect(validateAnnualFeePolicy(null, policy)).resolves.toBeUndefined();
  });

  it('消费进度显示笔数和返现规则，保存当前自然月的银行笔数', async () => {
    const key = 'calendar_month:2026-11:count';
    vi.spyOn(api, 'get').mockResolvedValue({
      annualFee: null,
      tracks: [{ rule: countRule, periods: [{
        key, label: '2026-11', startsOn: '2026-11-01', endsOn: '2026-11-30',
        bankAmount: null, estimatedAmount: null, bankCount: null,
        estimatedCount: 7, remaining: 3, lastTransactionOn: '2026-11-20', canConfirm: true,
      }], estimatedStreak: 0, bankStreak: 0 }],
    });
    const save = vi.spyOn(api, 'put').mockResolvedValue({});
    render(<CardSpendProgress cardId={2} cardLabel="浙商银行 · 文旅卡" onClose={vi.fn()} />);
    expect(await screen.findByText('还差 3 笔')).toBeTruthy();
    expect(screen.getByText('账单估算 7 笔')).toBeTruthy();
    expect(screen.getByText(/达标后次月返现 1%，最高/)).toBeTruthy();
    expect(screen.getByText('最近一笔已导入交易 2026-11-20')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认笔数' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '2026-11 银行确认笔数' }), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(`/api/cards/2/spend-progress/${countRule.id}`, { periodKey: key, count: 9 }));
  });
});
