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

it('有收录但预算不足时提示筛选条件，并可从查询结果打开来源', async () => {
  const sources = [{ key: 'citic-365', name: '中信活动源', enabled: true, lastSuccess: null, error: null, url: 'https://example.org' }];
  vi.spyOn(api, 'get').mockImplementation(async (url) => url.endsWith('/sources') ? sources : {
    cards: [], offers: [], ollamaEnabled: false,
  });
  vi.spyOn(api, 'post').mockResolvedValue({
    query: { merchant: '海底捞', date: '2026-11-22', budget: 199 },
    tiers: [], combinations: [], results: [], prefersCombination: false, emptyReason: 'filters',
  });
  render(<MemoryRouter><ResponsiveProvider><App><Offers /></App></ResponsiveProvider></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('你想买什么或去哪儿消费'), { target: { value: '今晚吃海底捞，预算199元' } });
  fireEvent.click(screen.getByRole('button', { name: '查询划算方案' }));
  expect(await screen.findByText('当前预算、地点、时间或支付方式与已收录的活动条件不符。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '查看活动来源' }));
  expect(await screen.findByText('中信活动源')).toBeTruthy();
});

it('保存公众号 RSS，遇到微信验证页后保留文章链接并允许粘贴正文', async () => {
  const address = 'http://192.168.1.3:8001/feed/MP_WXS_123456.rss';
  const article = 'https://mp.weixin.qq.com/s/offer_test';
  const feed = { url: '', enabled: false, error: null, lastSuccess: null, lastAttempt: null };
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/werss')) return feed;
    return url.endsWith('/sources') ? [] : { cards: [], offers: [], ollamaEnabled: false };
  });
  const save = vi.spyOn(api, 'put').mockImplementation(async () => {
    Object.assign(feed, { url: address, enabled: true });
    return { ok: true };
  });
  const importArticle = vi.spyOn(api, 'post').mockResolvedValueOnce({ updated: 0, needsContent: true })
    .mockResolvedValueOnce({ updated: 1, needsContent: false });
  render(<MemoryRouter><ResponsiveProvider><App><Offers /></App></ResponsiveProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole('tab', { name: '活动来源' }));
  fireEvent.click(screen.getByRole('button', { name: '外部 WeRSS（可选）' }));
  const rssInput = await screen.findByRole('textbox', { name: '公众号 RSS 地址' }) as HTMLInputElement;
  await waitFor(() => expect(rssInput.disabled).toBe(false));
  fireEvent.change(rssInput, { target: { value: address } });
  fireEvent.click(screen.getByRole('button', { name: '保存订阅' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('/api/offers/werss', { url: address, enabled: true }));
  fireEvent.click(screen.getByRole('button', { name: '导入公众号文章' }));
  const linkInput = await screen.findByLabelText('微信文章链接') as HTMLInputElement;
  fireEvent.change(linkInput, { target: { value: article } });
  fireEvent.click(screen.getByRole('button', { name: '读取文章' }));
  const articleBody = await screen.findByLabelText('文章正文');
  expect(linkInput.value).toBe(article);
  fireEvent.change(articleBody, { target: { value: '海底捞满 200 元减 50 元' } });
  fireEvent.click(screen.getByRole('button', { name: '生成活动草稿' }));
  await waitFor(() => expect(importArticle).toHaveBeenLastCalledWith('/api/offers/wechat-article',
    expect.objectContaining({ url: article, text: '海底捞满 200 元减 50 元' })));
});

it('内置公众号授权后可直接搜索并订阅，无需填写 RSS', async () => {
  const account = { id: 'MzE=', name: '卡羊腿' };
  const collection = { account: null, authorized: true, enabled: false, expiresAt: null, lastSuccess: null, error: null };
  const read = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.includes('/accounts?')) return [account];
    if (url.endsWith('/wechat-collection')) return collection;
    return url.endsWith('/sources') ? [] : { cards: [], offers: [], ollamaEnabled: false };
  });
  const save = vi.spyOn(api, 'put').mockImplementation(async () => {
    Object.assign(collection, { account, enabled: true });
    return { ok: true };
  });
  render(<MemoryRouter><ResponsiveProvider><App><Offers /></App></ResponsiveProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole('tab', { name: '活动来源' }));
  fireEvent.change(await screen.findByLabelText('搜索公众号'), { target: { value: '卡羊腿' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索公众号' }));
  fireEvent.click(await screen.findByRole('button', { name: '订阅 卡羊腿' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('/api/offers/wechat-collection', { account, enabled: true }));
  expect(read).toHaveBeenCalledWith('/api/offers/wechat-collection/accounts?' + new URLSearchParams({ q: '卡羊腿' }).toString());
  expect(await screen.findByRole('switch', { name: '公众号每日同步' })).toBeTruthy();
});

it('微信限频时提示可重试时间，同时保留手动导入', async () => {
  const collection = { account: { id: 'MzE=', name: '卡羊腿' }, authorized: true, enabled: true, expiresAt: null,
    retryAfter: new Date(Date.now() + 60_000).toISOString(), lastSuccess: null, error: null };
  vi.spyOn(api, 'get').mockImplementation(async (url) => url.endsWith('/wechat-collection') ? collection
    : url.endsWith('/sources') ? [] : { cards: [], offers: [], ollamaEnabled: false });
  render(<MemoryRouter><ResponsiveProvider><App><Offers /></App></ResponsiveProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole('tab', { name: '活动来源' }));
  expect(await screen.findByText(/后再试。等待期间可以手动导入文章/)).toBeTruthy();
  expect((screen.getByRole('button', { name: '立即刷新' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('搜索公众号') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: '导入公众号文章' }) as HTMLButtonElement).disabled).toBe(false);
});
