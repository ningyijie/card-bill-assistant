import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  appSetting: { findUnique: vi.fn(), upsert: vi.fn() }, rewardSource: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  card: { findMany: vi.fn() }, rewardOffer: { findFirst: vi.fn(), findMany: vi.fn() }, $transaction: vi.fn(),
  wechatSyncRun: { create: vi.fn(), findMany: vi.fn() },
  wechatOfferSubscription: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
}));
const saveDraft = vi.hoisted(() => vi.fn());
const browser = vi.hoisted(() => ({ read: vi.fn(), close: vi.fn(), unavailable: false }));
vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/modules/offers/service', () => ({
  knownOfferMerchants: async () => ['奈雪', '海底捞'],
  rewardCards: async () => {
    const rows: Partial<RewardCard>[] = await db.card.findMany() ?? [];
    return rows.map((row, index) => ({ id: index + 1, displayLast4: '1234', nickname: null, profile: {}, ...row }));
  },
  saveOfferInTransaction: saveDraft,
}));
vi.mock('../src/modules/offers/wechat-browser', () => ({ createWechatArticleBrowser: () => browser }));

import { articleDrafts, articleUrlSchema, feedUrlSchema, parseWechatFeed, parseWechatPage } from '../src/modules/offers/wechat-articles';
import { importWechatArticle, refreshWechatFeed, wechatArticleKey, wechatImportSchema } from '../src/modules/offers/wechat-source';
import { pollWechatScan, refreshWechatCollection, searchWechatAccounts, startWechatScan, wechatCollectionStatus } from '../src/modules/offers/wechat-collection';
import { findWechatAccounts, listWechatArticles } from '../src/modules/offers/wechat-platform';
import { listWechatSyncRuns } from '../src/modules/offers/wechat-sync-runs';
import { configureWereadCollection, refreshWereadCollection, wereadCollectionStatus,
  wereadSettings } from '../src/modules/offers/wechat-weread-collection';
import { decrypt, encrypt } from '../src/lib/crypto';
import type { RewardCard } from '../src/modules/offers/compare';

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
const imagePost = `<script>try {
  window.cgiDataNew = {
    title: '中信活动',
    desc: '中信银行海底捞消费满200元减50元\\n活动限指定门店',
    content_noencode: '仅供分享的摘要',
    item_show_type: '8' * 1,
    picture_page_info_list: [{ cdn_url: 'https://mmbiz.qpic.cn/example' }],
  };
} catch (error) {}</script>`;

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

  it('图文动态页面读取显示说明，普通文章的分享摘要仍不视为正文', () => {
    expect(parseWechatPage(url, imagePost)).toEqual({
      url, title: '中信活动', text: '中信银行海底捞消费满200元减50元\n活动限指定门店',
    });
    const full = imagePost.replace("desc:", "content: '中信银行海底捞满200元减50元<br>每周三可用', desc:");
    expect(parseWechatPage(url, full)?.text).toBe('中信银行海底捞满200元减50元\n每周三可用');
    expect(parseWechatPage(url, imagePost.replace('desc:', 'content: renderArticle(), desc:'))).toBeUndefined();
    expect(parseWechatPage(url, imagePost.replace("'8' * 1", "'0' * 1"))).toBeUndefined();
    expect(parseWechatPage(url, imagePost.replace(/picture_page_info_list: \[.*?\]/,
      'picture_page_info_list: []'))).toBeUndefined();
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
    const article = JSON.stringify({ appmsgex: [{ link: `${url}?from=share` }, { link: url, title: '公众号活动' }, { link: 'https://example.org/article' }] });
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ base_resp: { ret: 0 }, list: [{ fakeid: 'MzE=', nickname: '卡羊腿' }] }))
      .mockResolvedValueOnce(Response.json({ base_resp: { ret: 0 }, publish_page: JSON.stringify({ publish_list: [{ publish_info: article }] }) }))
      .mockResolvedValueOnce(Response.json({ base_resp: { ret: 200013 } }))
      .mockResolvedValueOnce(Response.json({ base_resp: { ret: 200003 } }));
    vi.stubGlobal('fetch', fetch);
    await expect(findWechatAccounts(credential, '卡羊腿')).resolves.toEqual([{ id: 'MzE=', name: '卡羊腿' }]);
    await expect(listWechatArticles(credential, 'MzE=')).resolves.toEqual([{ url, title: '公众号活动' }]);
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('fakeid')).toBe('MzE=');
    await expect(listWechatArticles(credential, 'MzE=')).rejects.toMatchObject({ status: 429, retryAt: new Date('2026-11-24T12:15:00Z') });
    await expect(listWechatArticles(credential, 'MzE=')).rejects.toMatchObject({ status: 409 });
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
    expect(db.wechatSyncRun.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({
      source: 'platform', trigger: 'manual', report: expect.objectContaining({ status: 'limited', articles: [] }),
    }) });
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
    expect(db.wechatSyncRun.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({
      source: 'werss', report: expect.objectContaining({ status: 'partial', articles: [
        expect.objectContaining({ state: 'drafted', drafts: 2 }), expect.objectContaining({ state: 'missing', title: '空正文' }),
      ] }),
    }) });
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

  it('AI 合并相同优惠，只保存有依据且匹配本地持卡产品和卡组织的规则', async () => {
    vi.stubEnv('OFFERS_OLLAMA_URL', 'http://ollama:11434');
    vi.stubEnv('OFFERS_OLLAMA_MODEL', 'mock-model');
    db.card.findMany.mockResolvedValue([
      { id: 21, bankName: '华夏银行', nickname: '私人别名', profile: { product: 'UP信用卡', network: '万事达', upGold: 233 } },
      { id: 22, bankName: '华夏银行', profile: { product: 'Safari卡', network: '万事达' } },
      { id: 23, bankName: '华夏银行', profile: { product: 'UP卡', network: 'Visa' } },
      { id: 24, bankName: '华夏银行', profile: { product: 'UP卡' } },
    ]);
    const evidence = '华夏银行 UP卡（万事达）专享：2026年12月1日至2026年12月31日，奈雪订单实付达40元，返现比例为5%，封顶8元。领取路径：华彩生活 → 奈雪优惠。';
    const otherBank = '平安银行信用卡在星巴克满30元减10元。';
    const offer = { title: '奈雪满40返5%', firstLine: 2, lastLine: 2, scope: 'restricted', bankName: '华夏银行', product: 'UP卡', network: '万事达',
      merchants: ['奈雪'], startsOn: '2026-12-01', endsOn: '2026-12-31', threshold: 40,
      discount: { type: 'cashback', rate: 5, cap: 8 }, entry: '华彩生活 → 奈雪优惠' };
    const reply = { offers: [offer, { ...offer, title: '华夏卡奈雪8元立减' },
      { ...offer, discount: { type: 'fixed', amount: 100 } },
      { ...offer, product: 'Safari卡' },
      { ...offer, scope: 'bank', product: undefined, network: undefined },
      { ...offer, firstLine: 3, lastLine: 3, title: '星巴克立减', scope: 'bank', bankName: '平安银行', product: undefined,
        network: undefined, merchants: ['星巴克'], startsOn: undefined, endsOn: undefined, threshold: 30, discount: { type: 'fixed', amount: 10 } },
    ] };
    const fetch = vi.fn(async (_url: URL, _init: RequestInit) => Response.json({ message: { content: JSON.stringify(reply) } }));
    vi.stubGlobal('fetch', fetch);
    await expect(importWechatArticle({ url, title: '银行优惠汇总', text: `${evidence}\n${otherBank}` }))
      .resolves.toEqual({ updated: 1, skipped: 0, needsContent: false });
    expect(saveDraft).toHaveBeenCalledExactlyOnceWith(db, expect.objectContaining({ title: offer.title, cardIds: [21],
      merchants: ['奈雪'], bankName: '华夏银行', product: 'UP信用卡', network: '万事达', threshold: 40, endsOn: '2026-12-31',
      discount: offer.discount, entry: offer.entry, needsEligibility: true,
    }), 'draft', undefined, expect.anything());
    expect(String(fetch.mock.calls[0][0])).toBe('http://ollama:11434/api/chat');
    const payload = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(JSON.parse(payload.messages[1].content)).toEqual({ text: `1: 银行优惠汇总\n2: ${evidence}\n3: ${otherBank}` });
    expect(String(fetch.mock.calls[0][1].body)).not.toContain('私人别名');
  });

  it('模型暂不可用时退回发卡行规则，排除产品限定优惠和未持卡银行', async () => {
    vi.stubEnv('OFFERS_OLLAMA_URL', 'http://ollama:11434');
    vi.stubEnv('OFFERS_OLLAMA_MODEL', 'mock-model');
    db.card.findMany.mockResolvedValue([{ id: 21, bankName: '华夏银行', profile: { product: 'Safari卡' } }]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    const text = '# 华夏银行信用卡奈雪优惠\n奈雪满40元立减8元。\n# 华夏银行 UP卡专享\n喜茶满50元减20元。\n# 平安银行星巴克信用卡优惠\n满30元减10元。';
    await expect(importWechatArticle({ url, title: '信用卡活动汇总', text })).resolves.toMatchObject({ updated: 1 });
    expect(saveDraft).toHaveBeenCalledExactlyOnceWith(db, expect.objectContaining({ cardIds: [21], merchants: ['奈雪'],
      discount: { type: 'fixed', amount: 8 } }), 'draft', undefined, expect.anything());
  });

  it.each([
    ['奈雪满40元立减8元', '奈雪满40元减8元', '满40元减8元', { type: 'fixed', amount: 8 }],
    ['奈雪单笔满100元返现5%，最高返20元', '奈雪满100元返现5%，最高返20元',
      '满100元返现5%，最高返20元', { type: 'cashback', rate: 5, cap: 20 }],
  ] as const)('保留原文优惠条件并整理短标题：%s', async (terms, title, summary, discount) => {
    vi.stubEnv('OFFERS_OLLAMA_URL', 'http://ollama:11434');
    vi.stubEnv('OFFERS_OLLAMA_MODEL', 'mock-model');
    db.card.findMany.mockResolvedValue([
      { id: 21, bankName: '华夏银行', profile: { product: 'UP信用卡', network: '万事达' } },
      { id: 22, bankName: '华夏银行', profile: { product: 'UP信用卡', network: 'Visa' } },
    ]);
    const fetch = vi.fn(async (_url: URL, _init: RequestInit) => Response.json({ message: { content: JSON.stringify({ titles: [title] }) } }));
    vi.stubGlobal('fetch', fetch);
    const text = `华夏银行 UP卡（万事达）专享。${terms}。2026年12月1日至2026年12月31日。领取路径：华彩生活→奈雪专区。`;
    await expect(importWechatArticle({ url, title: '银行优惠汇总', text })).resolves.toMatchObject({ updated: 1 });
    expect(saveDraft).toHaveBeenCalledExactlyOnceWith(db, expect.objectContaining({ title, discount,
      cardIds: [21], endsOn: '2026-12-31', entry: '华彩生活→奈雪专区',
    }), 'draft', undefined, expect.anything());
    const payload = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(payload.options.num_predict).toBe(40);
    expect(JSON.parse(payload.messages[1].content)).toEqual({ offers: [`华夏银行 · 奈雪 · ${summary}`] });
  });
});

describe('微信读书定时同步频率', () => {
  const bookId = 'MP_WXS_3209006872';
  const at = (hour: number, minute = 0, day = 26) => new Date(2026, 10, day, hour, minute);

  beforeEach(() => {
    vi.resetAllMocks();
    const secret = '21'.repeat(32);
    vi.stubEnv('ENCRYPTION_KEY', secret);
    vi.stubEnv('REMINDER_HOUR', '8');
    const row = { accountId: bookId, accountName: '卡羊腿', enabled: true, authorizedAt: at(7), lastAttempt: null,
      credential: encrypt(Buffer.from(secret, 'hex'), JSON.stringify({ wr_vid: '42', wr_skey: 'demo-token' })) };
    db.wechatOfferSubscription.findUnique.mockResolvedValue(row);
    db.wechatOfferSubscription.update.mockImplementation(async ({ data }) => Object.assign(row, data));
    db.$transaction.mockImplementation(async (run) => run(db));
    db.rewardOffer.findMany.mockResolvedValue([{ sourceKey: wechatArticleKey(url) + 'example' }]);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ hasMore: false, reviews: [{ subReviews: [{ review: {
      reviewId: bookId + '_example_offer_A', mpInfo: { title: '活动标题' },
    } }] }] })));
  });

  it('没有配置时每天在提醒时间运行一次，当日重复调度不会再次读取', async () => {
    await expect(wereadCollectionStatus()).resolves.toMatchObject({ syncHours: 24 });
    await refreshWereadCollection(false, at(7));
    expect(fetch).not.toHaveBeenCalled();

    await expect(refreshWereadCollection(false, at(8))).resolves.toMatchObject({ discovered: 1 });
    await refreshWereadCollection(false, at(8));
    await refreshWereadCollection(false, at(14));
    expect(fetch).toHaveBeenCalledTimes(1);

    await refreshWereadCollection(false, at(8, 0, 27));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('保存新间隔后同一天可按频率同步，关闭后仍可手动刷新', async () => {
    expect(wereadSettings.safeParse({ bookId, enabled: true, syncHours: 2 }).success).toBe(false);
    db.appSetting.upsert.mockImplementation(async ({ update }) => {
      db.appSetting.findUnique.mockResolvedValue({ value: update.value });
    });
    await configureWereadCollection({ bookId, enabled: true, syncHours: 6 });
    await expect(wereadCollectionStatus()).resolves.toMatchObject({ syncHours: 6 });

    await refreshWereadCollection(false, at(8));
    await refreshWereadCollection(false, at(11));
    await refreshWereadCollection(false, at(14));
    await refreshWereadCollection(false, at(14));
    expect(fetch).toHaveBeenCalledTimes(2);

    await configureWereadCollection({ bookId, enabled: false });
    await refreshWereadCollection(false, at(20));
    expect(fetch).toHaveBeenCalledTimes(2);
    await refreshWereadCollection(true, at(20, 5));
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(wereadCollectionStatus()).resolves.toMatchObject({ enabled: false, syncHours: 6 });
  });

  it('微信读书缺正文时补读公开原文，保存草稿并跳过已导入的文章', async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(Response.json({ hasMore: false, reviews: [{ review: {
      reviewId: bookId + '_example_offer_A', mpInfo: { title: '海底捞活动' },
    } }] }));
    fetch.mockResolvedValueOnce(new Response("<script>var data={content_noencode:'仅供分享的摘要'}</script>"));
    db.rewardOffer.findMany.mockResolvedValueOnce([]);
    db.wechatOfferSubscription.findFirst.mockResolvedValue({ id: 2 });
    db.card.findMany.mockResolvedValue([{ bankName: '中信银行' }]);
    browser.read.mockResolvedValue({ url, title: '公众号活动', text: '中信银行海底捞消费满200元减50元' });

    await expect(refreshWereadCollection(true, at(8))).resolves.toMatchObject({ discovered: 1, updated: 1, missing: 0 });
    expect(browser.read).toHaveBeenCalledWith(url);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(saveDraft).toHaveBeenCalledWith(db, expect.objectContaining({ sourceUrl: url }), 'draft', undefined,
      expect.objectContaining({ sourceKey: expect.stringContaining(wechatArticleKey(url)) }));

    await expect(refreshWereadCollection(true, at(8, 5))).resolves.toMatchObject({ skipped: 1 });
    expect(browser.read).toHaveBeenCalledTimes(1);
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it('从微信读书返回的图文生成草稿而无需启动浏览器', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(Response.json({ reviews: [] }))
      .mockResolvedValueOnce(Response.json({ title: '中信活动', reviewId: bookId + '_example_offer_A' }))
      .mockResolvedValueOnce(new Response(imagePost));
    db.rewardOffer.findMany.mockResolvedValueOnce([]);
    db.wechatOfferSubscription.findFirst.mockResolvedValue({ id: 2 });
    db.card.findMany.mockResolvedValue([{ bankName: '中信银行' }]);
    browser.read.mockRejectedValue(new Error('NAS 浏览器沙箱不可用'));

    await expect(refreshWereadCollection(false, at(8))).resolves.toMatchObject({
      discovered: 1, updated: 1, missing: 0, latestOnly: true,
    });
    expect(browser.read).not.toHaveBeenCalled();
    expect(saveDraft).toHaveBeenCalledWith(db, expect.objectContaining({
      sourceUrl: url, threshold: 200, discount: { type: 'fixed', amount: 50 },
    }), 'draft', undefined, expect.anything());
  });

  it('跨页获取多篇，同一批次和已入库文章按原文去重', async () => {
    const review = (token: string) => ({ reviewId: `${bookId}_${token}` });
    const fetch = vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(Response.json({ reviews: [{ review: review('example_offer_A'),
        subReviews: [{ review: review('example_offer_B') }] }], hasMore: true }))
      .mockResolvedValueOnce(Response.json({ reviews: [{ review: review('example_offer_B') },
        { review: review('example_offer_C') }], hasMore: false }))
      .mockResolvedValueOnce(new Response(imagePost))
      .mockResolvedValueOnce(new Response(imagePost));
    db.wechatOfferSubscription.findFirst.mockResolvedValue({ id: 2 });
    db.card.findMany.mockResolvedValue([{ bankName: '中信银行' }]);

    await expect(refreshWereadCollection(true, at(8))).resolves.toMatchObject({
      discovered: 3, updated: 2, skipped: 1, missing: 0, latestOnly: false,
    });
    const requests = fetch.mock.calls.map(([input]) => new URL(String(input)));
    expect(requests.map((request) => request.searchParams.get('offset') ?? request.searchParams.get('reviewId')))
      .toEqual(['0', '1', `${bookId}_example_offer_B`, `${bookId}_example_offer_C`]);
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(db.wechatSyncRun.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({
      source: 'weread', accountName: '卡羊腿', report: expect.objectContaining({ status: 'completed', articles: [
        expect.objectContaining({ url, state: 'duplicate' }),
        expect.objectContaining({ state: 'drafted', title: '中信活动' }),
        expect.objectContaining({ state: 'drafted', title: '中信活动' }),
      ] }),
    }) });
  });

  it.each(['同一公众号', '其他公众号', '限频中'])('单篇兜底时检查补充来源（%s）', async (scenario) => {
    const weread = await db.wechatOfferSubscription.findUnique();
    const platformId = Buffer.from('3209006872').toString('base64');
    const platform = { ...weread, accountId: scenario === '其他公众号' ? 'MzE=' : platformId,
      retryAfter: scenario === '限频中' ? new Date(Date.now() + 120_000) : null,
      credential: encrypt(Buffer.from('21'.repeat(32), 'hex'), JSON.stringify({ token: '123', cookies: [] })) };
    db.wechatOfferSubscription.findUnique.mockImplementation(async ({ where }) => where.id === 1 ? platform : weread);
    db.wechatOfferSubscription.update.mockImplementation(async ({ where, data }) => Object.assign(where.id === 1 ? platform : weread, data));
    db.wechatOfferSubscription.findFirst.mockResolvedValue({ id: 1 });
    db.card.findMany.mockResolvedValue([{ bankName: '中信银行' }]);
    const otherUrl = 'https://mp.weixin.qq.com/s/example_offer_B';
    const fetch = vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(Response.json({ errCode: -2041 }))
      .mockResolvedValueOnce(Response.json({ reviewId: bookId + '_example_offer_A' }))
      .mockResolvedValueOnce(Response.json({ base_resp: { ret: 0 }, publish_page: JSON.stringify({
        publish_list: [{ publish_info: JSON.stringify({ appmsgex: [{ link: url + '?from=share' }, { link: otherUrl }] }) }],
      }) }))
      .mockResolvedValueOnce(new Response(imagePost));

    const result = await refreshWereadCollection(true, at(8));
    expect(result).toMatchObject({ discovered: 1, skipped: 1, latestOnly: true });
    if (scenario === '同一公众号') {
      expect(result.supplement).toEqual({ discovered: 2, updated: 1, skipped: 1, missing: 0 });
      expect(saveDraft).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[3][0])).toBe(otherUrl);
    } else {
      expect(result.supplement).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(saveDraft).not.toHaveBeenCalled();
    }
  });
});

it('同步历史支持按来源向前翻页', async () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({ id: 50 - index }));
  db.wechatSyncRun.findMany.mockResolvedValue(rows);
  await expect(listWechatSyncRuns({ source: 'weread', before: 51 })).resolves.toEqual({ runs: rows.slice(0, 10), nextBefore: 41 });
  expect(db.wechatSyncRun.findMany).toHaveBeenLastCalledWith({ where: { source: 'weread', id: { lt: 51 } },
    orderBy: { id: 'desc' }, take: 11 });
});
