import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ApiError } from '../../lib/errors';
import { boundedOfferDocument } from './sources';
import { articleUrlSchema, parseWechatPage } from './wechat-articles';

// Request shapes follow the WeRSS implementation noted in THIRD-PARTY-NOTICES.md.
const origin = 'https://weread.qq.com';
const cookieValue = z.string().regex(/^[\x21-\x2B\x2D-\x3A\x3C-\x7E]{1,4096}$/);
const cookieNames = ['wr_vid', 'wr_skey', 'wr_rt'] as const;
type Cookies = Partial<Record<typeof cookieNames[number], string>>;
export const wereadCredentialSchema = z.object({
  wr_vid: z.string().regex(/^\d{1,32}$/),
  wr_skey: cookieValue,
  wr_rt: cookieValue.optional(),
});
export type WereadCredential = z.infer<typeof wereadCredentialSchema>;
export const wereadBookIdSchema = z.string().trim().regex(/^MP_WXS_\d{1,20}$/, '请输入 MP_WXS_ 开头的公众号编号');

const object = z.looseObject({});
function record(value: unknown) {
  return object.safeParse(value).data ?? {};
}
function firstText(...values: unknown[]) {
  return values.find((value) => typeof value === 'string' && value.length > 0) as string | undefined;
}
function errorCode(data: Record<string, unknown>) {
  return Number(data.errCode ?? data.errcode ?? 0);
}

export class WereadAuthorizationExpired extends ApiError {
  constructor() { super(409, '微信读书授权已失效，请重新扫码'); }
}

export class WereadRateLimited extends ApiError {
  constructor(readonly retryAt: Date) { super(429, '微信读书暂时限制了请求频率，请稍后重试'); }

  static fromResponse(response: Response) {
    const now = Date.now();
    const header = response.headers.get('retry-after')?.trim() ?? '';
    const deadline = /^\d+$/.test(header) ? now + Number(header) * 1_000 : Date.parse(header);
    const retryAt = deadline > now && deadline < Date.UTC(9999, 0) ? deadline : now + 15 * 60_000;
    return new WereadRateLimited(new Date(retryAt));
  }
}

async function request(cookies: Cookies, path: string, params: Record<string, string> = {},
  options: { body?: Record<string, unknown>; timeout?: number } = {}) {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const header = cookieNames.flatMap((key) => cookies[key] ? [key + '=' + cookies[key]] : []).join('; ');
  const response = await fetch(url, {
    method: options.body ? 'POST' : 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeout ?? 10_000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'application/json, text/html, */*', Origin: origin, Referer: origin + '/',
      ...(header ? { Cookie: header } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body && JSON.stringify(options.body),
  }).catch((error: unknown) => {
    if (options.timeout && error instanceof Error && error.name === 'TimeoutError') return undefined;
    throw new ApiError(502, '无法连接微信读书，请检查 NAS 网络后重试');
  });
  if (!response) return;
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    throw WereadRateLimited.fromResponse(response);
  }
  for (const item of response.headers.getSetCookie()) {
    const [pair] = item.split(';', 1);
    const i = pair.indexOf('=');
    const key = cookieNames.find((name) => name === pair.slice(0, i).trim());
    if (!key) continue;
    const value = pair.slice(i + 1).trim();
    const maxAge = item.match(/;\s*max-age=(-?\d+)/i)?.[1];
    const expiry = Date.parse(item.match(/;\s*expires=([^;]+)/i)?.[1] ?? '');
    if (!value || (maxAge == null ? expiry <= Date.now() : Number(maxAge) <= 0)) delete cookies[key];
    else if (cookieValue.safeParse(value).success) cookies[key] = value;
  }
  return response;
}

async function readJson(response: Response | undefined) {
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => {});
    throw new ApiError(502, '微信读书请求失败，请稍后再试');
  }
  try { return object.parse(JSON.parse(await boundedOfferDocument(response, 900_000))); }
  catch { throw new ApiError(502, '微信读书没有返回可用数据'); }
}

export async function startWereadLogin() {
  const cookies: Cookies = {};
  const data = await readJson(await request(cookies, '/api/auth/getLoginUid'));
  const uid = firstText(data.uid, record(data.data).uid);
  if (!uid || !/^[A-Za-z0-9_-]{6,128}$/.test(uid)) throw new ApiError(502, '微信读书暂未返回登录二维码');
  const url = new URL('/web/confirm', origin);
  url.searchParams.set('uid', uid);
  return { qrUrl: url.href, cookies, uid };
}
export type WereadLogin = Omit<Awaited<ReturnType<typeof startWereadLogin>>, 'qrUrl'>;

async function renew(cookies: Cookies) {
  if (!cookies.wr_rt) return;
  const response = await request(cookies, '/web/login/renewal', { }, { body: { rq: '%2Fweb%2Fbook%2Fread', ql: true } });
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => {});
    return;
  }
  const data = await readJson(response);
  const value = cookieValue.safeParse(firstText(data.wr_skey, data.skey, data.token));
  if (value.success) cookies.wr_skey = value.data;
}

async function validLogin(cookies: Cookies) {
  const response = await request(cookies, '/web/shelf/sync', { userVid: '', synckey: '0' });
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => {});
    return false;
  }
  const data = await readJson(response);
  return errorCode(data) === 0 && ('books' in data || 'bookCount' in data || 'synckey' in data);
}

export async function checkWereadLogin({ uid, cookies }: WereadLogin, otp = '') {
  const response = await request(cookies, '/api/auth/getLoginInfo', { uid, otp }, { timeout: 42_000 });
  if (!response) return { status: 'waiting' } as const;
  const data = await readJson(response);
  const inner = record(data.data);
  const code = String(data.logicCode ?? inner.logicCode ?? '').toUpperCase();
  if (data.succeed !== true && inner.succeed !== true) {
    if (/OTP/.test(code)) return { status: 'otp', rejected: Boolean(otp) } as const;
    if (['EXPIRED', 'INVALID_UID', 'LOGIN_EXPIRED'].includes(code)) return { status: 'expired' } as const;
    return { status: code === '1' || code === 'SCANNED' ? 'scanned' : 'waiting' } as const;
  }
  const vid = data.webLoginVid ?? data.vid ?? data.userVid ?? inner.webLoginVid ?? inner.vid ?? inner.userVid;
  if (!cookies.wr_vid && /^\d{1,32}$/.test(String(vid))) cookies.wr_vid = String(vid);
  const access = cookieValue.safeParse(firstText(data.accessToken, inner.accessToken, data.access_token, inner.access_token));
  if (!cookies.wr_skey && access.success) cookies.wr_skey = access.data;
  const refresh = firstText(data.refreshToken, inner.refreshToken, data.refresh_token, inner.refresh_token);
  const token = cookieValue.safeParse(refresh && encodeURIComponent(refresh));
  if (!cookies.wr_rt && token.success) cookies.wr_rt = token.data;
  if (!await validLogin(cookies)) {
    await renew(cookies);
    if (!await validLogin(cookies)) throw new ApiError(409, '微信已确认扫码，但微信读书登录校验未通过。请重新扫码');
  }
  const credential = wereadCredentialSchema.safeParse(cookies);
  if (!credential.success) throw new ApiError(409, '微信读书没有下发完整授权，请重新扫码');
  return { status: 'authorized', credential: credential.data } as const;
}

interface ArticleLink { url: string; reviewId: string; title?: string }
function articleLink(bookId: string, reviewId: unknown, originalId?: unknown, title?: unknown): ArticleLink | undefined {
  const original = firstText(originalId);
  const id = firstText(reviewId) || (original && `${bookId}_${original}`);
  if (!id || !/^[\w~-]{1,180}$/.test(id) || !id.startsWith(bookId + '_')) return;
  const token = original || id.slice(bookId.length + 1);
  const url = articleUrlSchema.safeParse('https://mp.weixin.qq.com/s/' + token.replaceAll('~', '_'));
  if (url.success) return { url: url.data, reviewId: id, title: firstText(title) };
}

async function listOnce(credential: WereadCredential, bookId: string) {
  const found = new Map<string, ArticleLink>();
  const maxArticles = 16;
  const maxPages = 3;
  let offset = 0;
  let listProblem: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await delay(1_000);
    const response = await request(credential, '/web/mp/articles', { bookId, offset: String(offset) });
    const data = await readJson(response).catch(() => undefined);
    if (!data) {
      listProblem = response && !response.ok ? `微信读书文章列表请求失败（HTTP ${response.status}）` : '微信读书文章列表响应不可读';
      break;
    }
    const code = errorCode(data);
    if (code !== 0) {
      listProblem = Number.isSafeInteger(code) ? `微信读书文章列表返回错误（${code}）` : '微信读书文章列表返回错误';
      break;
    }
    if (!Array.isArray(data.reviews)) {
      listProblem = '微信读书返回的文章列表格式无法识别';
      break;
    }
    if (!data.reviews.length) {
      if (!found.size) listProblem = '微信读书返回的文章列表为空';
      break;
    }
    const priorCount = found.size;
    for (const group of data.reviews.map(record)) {
      const reviews = Array.isArray(group.subReviews) ? group.subReviews.map(record) : [];
      if (group.review) reviews.unshift({ review: group.review });
      for (const item of reviews) {
        const review = record(item.review ?? item);
        const info = record(review.mpInfo);
        const link = articleLink(bookId, review.reviewId ?? item.reviewId, info.originalId, info.title ?? review.title);
        if (link && !found.has(link.url)) found.set(link.url, link);
        if (found.size === maxArticles) break;
      }
      if (found.size === maxArticles) break;
    }
    if (found.size === maxArticles) {
      listProblem = '本次已达到文章读取上限';
      break;
    }
    if (data.hasMore === false || data.hasMore === 0) break;
    if (found.size === priorCount) {
      listProblem = found.size ? '微信读书没有返回更多可识别的文章' : '微信读书文章列表没有可识别的条目';
      break;
    }
    if (page === maxPages - 1) listProblem = '本次已达到文章列表的翻页上限';
    // The offset counts publication groups. Each group can contain several articles.
    offset += data.reviews.length;
  }
  if (found.size) return { articles: [...found.values()], latestOnly: false,
    listWarning: listProblem && `${listProblem}，后续文章可能漏同步。` };
  const coverResponse = await request(credential, '/api/mp/cover', { bookId });
  if ([401, 403].includes(coverResponse?.status ?? 0)) {
    await coverResponse?.body?.cancel().catch(() => {});
    throw new WereadAuthorizationExpired();
  }
  const cover = await readJson(coverResponse);
  const code = errorCode(cover);
  if ([-2012, -2013].includes(code)) throw new WereadAuthorizationExpired();
  if (code === -2010 || code === -2041) throw new ApiError(409, '微信读书无法访问该公众号，可以在微信读书中关注后重试');
  const link = articleLink(bookId, cover.reviewId, cover.originalId, cover.title);
  if (code || !link) throw new ApiError(422, '微信读书没有返回该公众号的文章，请核对公众号编号');
  return { articles: [link], latestOnly: true,
    listWarning: `${listProblem ?? '微信读书文章列表没有可识别的条目'}，本次只检查最新一篇。` };
}

export async function listWereadArticles(credential: WereadCredential, bookId: string) {
  try { return await listOnce(credential, bookId); }
  catch (error) {
    if (!(error instanceof WereadAuthorizationExpired) || !credential.wr_rt) throw error;
    await renew(credential);
    return listOnce(credential, bookId);
  }
}

export async function readWereadArticle(credential: WereadCredential, link: ArticleLink) {
  const response = await request(credential, '/web/mp/content', { reviewId: link.reviewId });
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => {});
    if ([401, 403].includes(response?.status ?? 0)) throw new WereadAuthorizationExpired();
    return;
  }
  const html = await boundedOfferDocument(response, 6_000_000);
  return parseWechatPage(link.url, html);
}
