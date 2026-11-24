import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  appSetting: { findUnique: vi.fn() }, rewardSource: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  card: { findMany: vi.fn() }, rewardOffer: { findFirst: vi.fn() }, $transaction: vi.fn(),
  wechatOfferSubscription: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
}));
const saveDraft = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/modules/offers/service', () => ({ knownOfferMerchants: async () => ['奈雪', '海底捞'], saveOfferInTransaction: saveDraft }));

import { articleDrafts, articleUrlSchema, feedUrlSchema, parseWechatFeed, parseWechatPage } from '../src/modules/offers/wechat-articles';
import { importWechatArticle, refreshWechatFeed, wechatImportSchema } from '../src/modules/offers/wechat-source';
import { pollWechatScan, refreshWechatCollection, searchWechatAccounts, startWechatScan, wechatCollectionStatus } from '../src/modules/offers/wechat-collection';
import { findWechatAccounts, listWechatArticleLinks } from '../src/modules/offers/wechat-platform';
import { decrypt, encrypt } from '../src/lib/crypto';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

const url = 'https://mp.weixin.qq.com/s/example_offer_A';
const feedUrl = 'http://192.168.1.3:8001/feed/MP_WXS_123456.rss';
const article = `<h2>1. 中信精彩365 · 海底捞</h2><p>满 <strong>200</strong> 元随机立减最高 50 元</p>
  <h2>2. 华夏银行 · 奈雪</h2><p>满 40 元减 8 元</p>
  <h2>3. 平安银行消费立减</h2><p>满 10 元减 1 元</p>`;
const feed = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>活动测试</title>
  <item><title>三项银行优惠</title><link>${url}?from=share</link><description>摘要</description>
  <content:encoded><![CDATA[${article}<script>恶意立减</script>]]></content:encoded></item>
  <item><title>空正文</title><link>https://mp.weixin.qq.com/s/empty</link><description>只有摘要</description></item>
  </channel></rss>`;

describe('公众号活动', () => {
  it('从 RSS 正文拆出持卡银行草稿，保留原文并过滤脚本和未持有银行', () => {
    const { articles, missing } = parseWechatFeed(feed);
    expect(missing).toBe(1);
    expect(articles[0].url).toBe(url);
    expect(articles[0].text).not.toContain('恶意立减');
    expect(articleDrafts(articles[0], ['中信银行', '华夏银行'], ['海底捞', '奈雪'], true).map(({ rule }) => rule))
      .toEqual([
        expect.objectContaining({ bankName: '中信银行', merchants: ['海底捞'], threshold: 200, discount: { type: 'random', max: 50 }, sourceUrl: url }),
        expect.objectContaining({ bankName: '华夏银行', merchants: ['奈雪'], threshold: 40, discount: { type: 'fixed', amount: 8 }, sourceUrl: url }),
      ]);
  });

  it('支持 Atom 正文和微信正文结构，验证页及非订阅页面可明确辨别', () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>商户优惠</title>
      <link href="${url}"/><content type="html">&lt;p&gt;喜茶立减&lt;/p&gt;</content></entry></feed>`;
    expect(parseWechatFeed(atom).articles).toEqual([{ url, title: '商户优惠', text: '喜茶立减' }]);
    expect(parseWechatPage(url, '<title>微信安全验证</title>')).toBeUndefined();
    expect(parseWechatPage(url, `<h1 id="activity-name">银行优惠</h1><div id="js_content">${article}</div>`))
      .toMatchObject({ url, title: '银行优惠' });
    expect(() => parseWechatFeed('<html>登录 WeRSS</html>')).toThrow('有效的 RSS');
  });

  it('限制服务器读取的地址，并归一化微信文章的分享参数', () => {
    expect(feedUrlSchema.parse(feedUrl)).toBe(feedUrl);
    for (const url of ['不是地址', 'https://mp.weixin.qq.com/s/abc', 'http://localhost:8001/feed/MP_WXS_1.rss',
      'http://192.168.1.3:8001/feed/all.rss', 'http://user@192.168.1.3/feed/MP_WXS_1.rss', `${feedUrl}?key=x`]) {
      expect(feedUrlSchema.safeParse(url).success).toBe(false);
    }
    expect(articleUrlSchema.parse(`${url}?from=wx#share`)).toBe(url);
    expect(articleUrlSchema.safeParse('https://mp.weixin.qq.com.example.net/s/test').success).toBe(false);
    expect(articleUrlSchema.parse('https://mp.weixin.qq.com/s?idx=1&from=wx&sn=abc&mid=123&__biz=MzA%3D'))
      .toBe('https://mp.weixin.qq.com/s?__biz=MzA%3D&mid=123&idx=1&sn=abc');
  });
});

describe('内置公众号采集', () => {
  it('使用微信二维码确认授权，加密后保存且状态接口不暴露会话', async () => {
    const sampleKey = '21'.repeat(32);
    vi.stubEnv('ENCRYPTION_KEY', sampleKey);
    const requests = [new Response('page'), Response.json({ base_resp: { ret: 0 }, uuid: 'official-qr' }),
      new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { 'Content-Type': 'image/jpg' } }),
      Response.json({ base_resp: { ret: 0 }, status: 3 }),
      Response.json({ redirect_url: '/cgi-bin/home?token=9712' }, { headers: { 'Set-Cookie': 'slave_sid=private_test_session; Path=/; Max-Age=3600' } })];
    const fetch = vi.fn(async (_request: URL) => requests.shift()!);
    vi.stubGlobal('fetch', fetch);
    const login = await startWechatScan();
    expect(login.image).toMatch(/^data:image\/jpeg;base64,/);
    expect(fetch.mock.calls.every(([request]) => new URL(String(request)).origin === 'https://mp.weixin.qq.com')).toBe(true);
    expect(await pollWechatScan(login.id)).toEqual({ status: 'authorized' });
    const stored = db.wechatOfferSubscription.upsert.mock.calls.at(-1)?.[0].update;
    expect(JSON.parse(decrypt(Buffer.from(sampleKey, 'hex'), stored.credential))).toMatchObject({ token: '9712',
      cookies: expect.arrayContaining([['slave_sid', 'private_test_session']]) });
    db.wechatOfferSubscription.findUnique.mockResolvedValue(stored);
    expect(await wechatCollectionStatus()).toEqual({ account: null, authorized: true, enabled: false,
      error: null, expiresAt: stored.expiresAt, lastSuccess: null, retryAfter: null });
  });

  it('搜索公众号后仅保留有效微信原文，并按微信返回值区分频控与授权过期', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    const credential = { token: '123', cookies: [['slave_sid', 'mock']] as [string, string][] };
    const article = JSON.stringify({ appmsgex: [{ link: `${url}?from=share` }, { link: url }, { link: 'https://example.org/article' }] });
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ base_resp: { ret: 0 }, list: [{ fakeid: 'MzE=', nickname: '卡羊腿' }] }))
      .mockResolvedValueOnce(Response.json({ base_resp: { ret: 0 }, publish_page: JSON.stringify({ publish_list: [{ publish_info: article }] }) }))
      .mockResolvedValueOnce(Response.json({ base_resp: { ret: 200013 } }))
      .mockResolvedValueOnce(Response.json({ base_resp: { ret: 200003 } }));
    vi.stubGlobal('fetch', fetch);
    await expect(findWechatAccounts(credential, '卡羊腿')).resolves.toEqual([{ id: 'MzE=', name: '卡羊腿' }]);
    await expect(listWechatArticleLinks(credential, 'MzE=')).resolves.toEqual([url]);
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('fakeid')).toBe('MzE=');
    await expect(listWechatArticleLinks(credential, 'MzE=')).rejects.toMatchObject({ status: 429, retryAt: new Date('2026-11-24T12:15:00Z') });
    await expect(listWechatArticleLinks(credential, 'MzE=')).rejects.toMatchObject({ status: 409 });
  });

  it('微信限频时保存 Retry-After，期间阻止刷新和搜索，并保留扫码授权', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-11-24T12:00:00Z');
    const retryAt = new Date('2026-11-24T12:02:00Z');
    vi.setSystemTime(now);
    const key = '21'.repeat(32);
    vi.stubEnv('ENCRYPTION_KEY', key);
    const credential = encrypt(Buffer.from(key, 'hex'), JSON.stringify({ token: '100', cookies: [] }));
    const row = { credential, authorizedAt: now, accountId: 'MzE=', accountName: '卡羊腿', enabled: true };
    db.wechatOfferSubscription.findUnique.mockResolvedValue(row);
    db.$transaction.mockImplementation(async (run) => run(db));
    db.wechatOfferSubscription.update.mockImplementation(async ({ data }) => Object.assign(row, data));
    db.wechatOfferSubscription.updateMany.mockImplementation(async ({ data }) => Object.assign(row, data));
    const fetch = vi.fn().mockResolvedValueOnce(new Response('Too many requests', { status: 429, headers: { 'Retry-After': '120' } }))
      .mockResolvedValueOnce(Response.json({ base_resp: { ret: 0 }, publish_page: '{"total_count":0}' }));
    vi.stubGlobal('fetch', fetch);

    await expect(refreshWechatCollection(true)).rejects.toMatchObject({ status: 429, retryAt });
    await expect(wechatCollectionStatus()).resolves.toMatchObject({ authorized: true, retryAfter: retryAt });
    await expect(refreshWechatCollection(true)).rejects.toMatchObject({ status: 429, retryAt });
    await expect(searchWechatAccounts('卡羊腿')).rejects.toMatchObject({ status: 429, retryAt });
    await refreshWechatCollection();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(row.credential).toBe(credential);

    vi.setSystemTime(retryAt);
    await expect(refreshWechatCollection(true)).resolves.toMatchObject({ missing: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(wechatCollectionStatus()).resolves.toMatchObject({ authorized: true, retryAfter: null, error: null });
  });
});

describe('WeRSS 入库与补录', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.appSetting.findUnique.mockResolvedValue({ value: feedUrl });
    db.rewardSource.findUnique.mockResolvedValue({ enabled: true });
    db.card.findMany.mockResolvedValue([{ bankName: '中信银行' }, { bankName: '华夏银行' }]);
    db.$transaction.mockImplementation(async (run) => run(db));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('同步仅保存待核对草稿，已同步文章再用链接补录不会重建', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(feed)));
    await expect(refreshWechatFeed(true)).resolves.toEqual({ updated: 2, skipped: 0, missing: 1 });
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(saveDraft.mock.calls.map(([, , review]) => review)).toEqual(['draft', 'draft']);
    db.rewardOffer.findFirst.mockResolvedValue({ id: 1 });
    const pasted = wechatImportSchema.parse({ url: `${url}?from=share`, text: '海底捞优惠，满 200 元减 50 元' });
    await expect(importWechatArticle(pasted)).resolves.toMatchObject({ updated: 0, skipped: 1 });
    expect(db.rewardOffer.findFirst.mock.calls[0][0]).toEqual(db.rewardOffer.findFirst.mock.calls[1][0]);
    expect(saveDraft).toHaveBeenCalledTimes(2);
  });

  it('每日同步跳过当天已尝试的来源，文章验证页提示补录', async () => {
    db.rewardSource.findUnique.mockResolvedValue({ enabled: true, lastAttempt: new Date() });
    const fetch = vi.fn(async () => new Response('<title>微信安全验证</title>'));
    vi.stubGlobal('fetch', fetch);
    await refreshWechatFeed();
    expect(fetch).not.toHaveBeenCalled();
    await expect(importWechatArticle({ url })).resolves.toMatchObject({ needsContent: true, updated: 0 });
    expect(saveDraft).not.toHaveBeenCalled();
  });
});
