import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import Offers from './Offers';
import type { OfferSearchResult } from './offers/types';
import { ResponsiveProvider } from '../responsive';

afterEach(() => vi.restoreAllMocks());

function renderOffers() {
  render(<MemoryRouter><ResponsiveProvider><ConfigProvider theme={{ token: { motion: false } }}>
    <App><Offers /></App>
  </ConfigProvider></ResponsiveProvider></MemoryRouter>);
}

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
  renderOffers();
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
  renderOffers();
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
  renderOffers();
  fireEvent.click(screen.getByRole('tab', { name: '活动来源' }));
  fireEvent.click(screen.getByRole('button', { name: '外部 WeRSS（可选）' }));
  const rssInput = await screen.findByRole('textbox', { name: '公众号 RSS 地址' }) as HTMLInputElement;
  await waitFor(() => expect(rssInput.disabled).toBe(false));
  fireEvent.change(rssInput, { target: { value: address } });
  fireEvent.click(screen.getByRole('button', { name: '保存订阅' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('/api/offers/werss', { url: address, enabled: true }));
  fireEvent.click(screen.getByRole('button', { name: '导入公众号文章' }));
  const dialog = within(await screen.findByRole('dialog'));
  const linkInput = dialog.getByLabelText('微信文章链接') as HTMLInputElement;
  fireEvent.change(linkInput, { target: { value: article } });
  fireEvent.click(dialog.getByRole('button', { name: '读取文章' }));
  const articleBody = await dialog.findByLabelText('文章正文');
  expect(linkInput.value).toBe(article);
  fireEvent.change(articleBody, { target: { value: '海底捞满 200 元减 50 元' } });
  fireEvent.click(dialog.getByRole('button', { name: '生成活动草稿' }));
  await waitFor(() => expect(importArticle).toHaveBeenLastCalledWith('/api/offers/wechat-article',
    expect.objectContaining({ url: article, text: '海底捞满 200 元减 50 元' })));
}, 30_000);

it('按名称添加第二个公众号，保留原订阅并可查看该号的同步记录', async () => {
  const account = { id: 'MzI=', name: '第二个号' };
  const collection = { accounts: [{ accountId: 'MzE=', name: '卡羊腿', enabled: true }], authorized: true };
  const read = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.includes('/accounts?')) return [account];
    if (url.endsWith('/wechat-collection')) return collection;
    if (url.includes('/wechat-sync-runs')) return { runs: [], nextBefore: null };
    return url.endsWith('/sources') ? [] : { cards: [], offers: [], ollamaEnabled: false };
  });
  const save = vi.spyOn(api, 'put').mockImplementation(async () => {
    collection.accounts.push({ accountId: account.id, name: account.name, enabled: true });
    return { ok: true };
  });
  const sync = vi.spyOn(api, 'post').mockResolvedValue({ discovered: 1, updated: 1, missing: 0 });
  renderOffers();
  fireEvent.click(screen.getByRole('tab', { name: '活动来源' }));
  await screen.findByText('卡羊腿');
  fireEvent.click(screen.getByRole('button', { name: '添加公众号' }));
  const dialog = within(await screen.findByRole('dialog'));
  fireEvent.change(dialog.getByLabelText('搜索公众号'), { target: { value: account.name } });
  fireEvent.click(dialog.getByRole('button', { name: '搜索公众号' }));
  fireEvent.click(await dialog.findByRole('button', { name: '订阅 第二个号' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('/api/offers/wechat-collection', { account, enabled: true }));
  expect(read).toHaveBeenCalledWith('/api/offers/wechat-collection/accounts?' + new URLSearchParams({ q: account.name }));
  expect(await screen.findByRole('switch', { name: '卡羊腿 · 公众号平台自动同步' })).toBeTruthy();
  const row = (await screen.findByRole('switch', { name: '第二个号 · 公众号平台自动同步' })).closest('.offers-subscription') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: '立即同步' }));
  await waitFor(() => expect(sync).toHaveBeenCalledWith('/api/offers/wechat-collection/refresh', { accountId: account.id }));
  fireEvent.click(within(row).getByRole('button', { name: '查看记录' }));
  await waitFor(() => expect(read).toHaveBeenCalledWith('/api/offers/wechat-sync-runs?' +
    new URLSearchParams({ source: 'platform', account: account.name, accountId: account.id })));
}, 30_000);

it('微信限频时提示可重试时间，同时保留手动导入', async () => {
  const collection = { accounts: [{ accountId: 'MzE=', name: '卡羊腿', enabled: true }], authorized: true,
    retryAfter: new Date(Date.now() + 60_000).toISOString() };
  vi.spyOn(api, 'get').mockImplementation(async (url) => url.endsWith('/wechat-collection') ? collection
    : url.endsWith('/sources') ? [] : { cards: [], offers: [], ollamaEnabled: false });
  renderOffers();
  fireEvent.click(screen.getByRole('tab', { name: '活动来源' }));
  expect(await screen.findByText(/后可重试/)).toBeTruthy();
  expect((screen.getByRole('button', { name: '立即同步' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: '导入公众号文章' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '添加公众号' }));
  expect((await screen.findByLabelText('搜索公众号') as HTMLInputElement).disabled).toBe(true);
});

it('微信读书可以从包含公众号编号的文章长链接添加订阅', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => url.endsWith('/weread-collection') ? { accounts: [], authorized: true }
    : url.endsWith('/sources') ? [] : { cards: [], offers: [], ollamaEnabled: false });
  const save = vi.spyOn(api, 'put').mockResolvedValue({ ok: true });
  renderOffers();
  fireEvent.click(screen.getByRole('tab', { name: '活动来源' }));
  await screen.findByText('已授权');
  fireEvent.click(screen.getByRole('button', { name: '添加公众号' }));
  fireEvent.change(await screen.findByLabelText('公众号名称'), { target: { value: '第二个号' } });
  fireEvent.change(screen.getByLabelText('微信读书编号或公众号文章长链接'), {
    target: { value: 'https://mp.weixin.qq.com/s?' + new URLSearchParams({ __biz: btoa('3209006873') }) },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加订阅' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('/api/offers/weread-collection',
    { bookId: 'MP_WXS_3209006873', name: '第二个号', enabled: true, syncHours: undefined }));
});

it('同步记录显示文章状态，并用原有链接和标题打开补录', async () => {
  const url = 'https://mp.weixin.qq.com/s/missing_content';
  vi.spyOn(api, 'get').mockImplementation(async (path) => path.endsWith('/wechat-sync-runs') ? {
    runs: [{ id: 1, source: 'weread', trigger: 'scheduled', accountName: '卡羊腿', startedAt: '2026-11-26T00:00:00Z',
      report: { status: 'partial', discovered: 1, updated: 0, skipped: 0, missing: 1, message: '1 篇文章缺少可读正文。',
        articles: [{ url, title: '本周活动', state: 'missing', drafts: 0 }] } }], nextBefore: null,
  } : { cards: [], offers: [], ollamaEnabled: false });
  renderOffers();
  fireEvent.click(screen.getByRole('tab', { name: '同步记录' }));
  expect(await screen.findByText('本周活动')).toBeTruthy();
  expect(screen.getByRole('link', { name: '查看原文' }).getAttribute('href')).toBe(url);
  fireEvent.click(screen.getByRole('button', { name: '补录正文' }));
  expect((await screen.findByLabelText('微信文章链接') as HTMLInputElement).value).toBe(url);
  expect((screen.getByLabelText('文章标题（可选）') as HTMLInputElement).value).toBe('本周活动');
  expect(screen.getByLabelText('文章正文')).toBeTruthy();
});

it('我的卡优惠显示已关联卡片的整理结果和领取路径', async () => {
  const rule = { title: '奈雪满40减8', kind: 'activity', cardIds: [1], merchants: ['奈雪'], channels: [],
    threshold: 40, discount: { type: 'fixed', amount: 8 }, sourceText: '公众号未整理的长文', entry: '华彩生活 → 奈雪优惠',
    startsOn: '2026-12-01', endsOn: '2026-12-31', requiresClaim: true };
  vi.spyOn(api, 'get').mockResolvedValue({
    cards: [{ id: 1, bankName: '华夏银行', nickname: 'UP卡', displayLast4: '1234', profile: {} }], ollamaEnabled: true,
    offers: [{ id: 1, rule, review: 'draft', applicableCardIds: [1], records: [] },
      { id: 2, rule: { ...rule, title: '未关联到持有卡', cardIds: [] }, review: 'draft', applicableCardIds: [1], records: [] }],
  });
  renderOffers();
  fireEvent.click(screen.getByRole('tab', { name: '我的卡优惠' }));
  expect(await screen.findByText('奈雪满40减8')).toBeTruthy();
  expect(screen.getByText('华夏银行（1234） · UP卡')).toBeTruthy();
  expect(screen.getByText('华彩生活 → 奈雪优惠')).toBeTruthy();
  expect(screen.getByText(/2026-12-01 至 2026-12-31.*需先领券/)).toBeTruthy();
  expect(screen.queryByText('公众号未整理的长文')).toBeNull();
  expect(screen.queryByText('未关联到持有卡')).toBeNull();
});
