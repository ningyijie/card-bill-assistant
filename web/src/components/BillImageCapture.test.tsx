import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { CardRow } from '../api/types';
import BillImageCapture from './BillImageCapture';

const cards = [{ id: 7, cardLast4: '1083', displayLast4: '1083', bankName: '测试银行' }] as CardRow[];
afterEach(() => vi.restoreAllMocks());

describe('截图导入', () => {
  it('把相册中多选的文件作为同一批上传', async () => {
    const upload = vi.spyOn(api, 'uploadForm').mockResolvedValue({ id: 'capture-1' });
    const onCapture = vi.fn();
    const { container } = render(<App><BillImageCapture cards={cards} onCapture={onCapture} onClose={vi.fn()} /></App>);
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]') ?? container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(picker.multiple).toBe(true);
    fireEvent.change(picker, {
      target: { files: [new File(['one'], 'a.png', { type: 'image/png' }), new File(['two'], 'b.jpg', { type: 'image/jpeg' })] },
    });
    await waitFor(() => expect(onCapture).toHaveBeenCalledWith('capture-1'));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toBe('/api/bill-images');
    expect((upload.mock.calls[0][1].getAll('images') as File[]).map((file) => file.name)).toEqual(['a.png', 'b.jpg']);
  });

  it('同卡同账期的截图合成一个草稿，保存前折叠重叠明细', async () => {
    const fields = {
      tail: '1083', period: '2026-11', statementDate: '2026-11-19', dueDate: '2026-12-08',
      amount: 100, currency: 'CNY',
    };
    const transaction = { date: '2026-11-14', description: '测试商户', amount: 100 };
    vi.spyOn(api, 'get').mockResolvedValue({
      status: 'ready', total: 2, pages: [
        { index: 1, name: 'a.png', fields, transactions: [transaction] },
        { index: 2, name: 'b.png', fields, transactions: [{ ...transaction, date: '11-14' }] },
      ],
    });
    const save = vi.spyOn(api, 'post').mockResolvedValue({ status: 'created' });
    render(<App><BillImageCapture id="capture-1" cards={cards} onCapture={vi.fn()} onClose={vi.fn()} /></App>);
    const saveButtons = await screen.findAllByRole('button', { name: '保存这份账单' });
    expect(saveButtons).toHaveLength(1);
    fireEvent.click(saveButtons[0]);
    await waitFor(() => expect(save).toHaveBeenCalledWith('/api/bill-images/capture-1/bills', {
      cardId: 7, statementDate: '2026-11-19', dueDate: '2026-12-08', amount: 100, currency: 'CNY',
      minAmount: null, transactions: [transaction],
    }));
  });
});
