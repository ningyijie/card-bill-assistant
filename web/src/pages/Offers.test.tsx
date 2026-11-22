import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import Offers from './Offers';
import type { OfferSearchResult } from './offers/types';
import { ResponsiveProvider } from '../responsive';

afterEach(() => vi.restoreAllMocks());

it('手机和桌面共用的查询页面仅凭商户问句显示门槛、卡片及领用路径', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => url.endsWith('/sources') ? [] : {
    cards: [], offers: [], ollamaEnabled: false,
  });
  const response: OfferSearchResult = {
    query: { merchant: '海底捞', date: '2026-11-22' }, tiers: [{ amount: 200, offerId: 1, cardId: 1 }],
    combinations: [], prefersCombination: false,
    results: [{
      offerId: 1, title: '测试满减', verifiedAt: null, status: 'ready', state: null,
      card: { id: 1, bankName: '中信银行', nickname: '悦卡', displayLast4: '1234' },
      neededActions: [], needsCheck: [],
      rule: {
        title: '测试满减', kind: 'activity', threshold: 200, discount: { type: 'fixed', amount: 20 },
        entry: '银行 App → 美食优惠', cardIds: [1], channels: ['wechat'], merchants: ['海底捞'],
        cities: [], stores: [], weekdays: [], stackWith: [],
        requiresClaim: false, requiresRegistration: false, needsEligibility: false, limited: false,
      },
      quote: { pay: null, saving: null, randomMax: null, cashback: null, pointCost: null, comparableCost: null },
    }],
  };
  const ask = vi.spyOn(api, 'post').mockResolvedValue(response);
  render(<MemoryRouter><ResponsiveProvider><App><Offers /></App></ResponsiveProvider></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('你想买什么或去哪儿消费'), { target: { value: '今晚吃海底捞' } });
  fireEvent.click(screen.getByRole('button', { name: '查询划算方案' }));
  await waitFor(() => expect(ask).toHaveBeenCalledWith('/api/offers/ask', { question: '今晚吃海底捞' }));
  expect(await screen.findByText('银行 App → 美食优惠')).toBeTruthy();
  expect(screen.getByText(/满.*测试满减.*悦卡/)).toBeTruthy();
  expect(screen.getByText('首选')).toBeTruthy();
});
