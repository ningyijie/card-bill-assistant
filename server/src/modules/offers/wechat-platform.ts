import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../../lib/errors';
import { boundedOfferBytes, boundedOfferDocument } from './sources';
import { articleUrlSchema } from './wechat-articles';

// 微信公众平台的扫码、搜索和列表流程参考 WeRSS v1.5.3，见 THIRD-PARTY-NOTICES.md。
const origin = 'https://mp.weixin.qq.com';
const jsonParams = { lang: 'zh_CN', f: 'json', ajax: '1' };
const cookieName = /^[A-Za-z0-9_!#$%&'*+.^`|~-]{1,80}$/;
const cookieValue = /^[\x21-\x2B\x2D-\x3A\x3C-\x7E]{0,4096}$/;
export const wechatCredentialSchema = z.object({ token: z.string().regex(/^\d{1,32}$/),
  cookies: z.array(z.tuple([z.string().regex(cookieName), z.string().regex(cookieValue)])).max(60) });
export type WechatCredential = z.infer<typeof wechatCredentialSchema>;
export const wechatAccountSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_+/=-]{1,80}$/), name: z.string().trim().min(1).max(120) });

type Session = { cookies: Map<string, string>; expiresAt?: Date };
const responseSchema = z.looseObject({ base_resp: z.object({ ret: z.coerce.number(), err_msg: z.string().optional() }).optional() });
const wxResponseError = new ApiError(502, '微信公众平台暂时未返回可用数据，请稍后重试');

function updateCookies(session: Session, response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0];
    const equal = pair.indexOf('=');
    if (equal < 1) continue;
    const name = pair.slice(0, equal).trim();
    const value = pair.slice(equal + 1).trim();
    if (!cookieName.test(name) || !cookieValue.test(value)) continue;
    const maxAge = header.match(/;\s*max-age=(-?\d+)/i)?.[1];
    const expiry = maxAge != null ? Date.now() + Number(maxAge) * 1000 : Date.parse(header.match(/;\s*expires=([^;]+)/i)?.[1] ?? '');
    if (expiry <= Date.now()) session.cookies.delete(name);
    else if (session.cookies.size < 60 || session.cookies.has(name)) session.cookies.set(name, value);
    if (name === 'slave_sid' && Number.isFinite(expiry)) session.expiresAt = new Date(expiry);
  }
}

async function platformRequest(session: Session, path: string, query: Record<string, string> = {}, form?: Record<string, string>) {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const cookies = [...session.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  let response: Response;
  try {
    response = await fetch(url, {
      method: form ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: `${origin}/`, 'Accept-Language': 'zh-CN',
        ...(cookies ? { Cookie: cookies } : {}), ...(form ? { Origin: origin } : {}) },
      body: form ? new URLSearchParams(form) : undefined,
    });
  } catch { throw new ApiError(502, '暂时无法连接微信公众平台'); }
  updateCookies(session, response);
  return response;
}

export class WechatAuthorizationExpired extends ApiError {
  constructor() { super(409, '公众号授权已失效，请重新用微信扫码'); }
}

const DEFAULT_RATE_LIMIT_PAUSE_MS = 15 * 60_000;

export class WechatRateLimited extends ApiError {
  constructor(readonly retryAt: Date) { super(429, '微信公众平台暂时限制了请求频率'); }

  static fromResponse(response: Response, now = Date.now()) {
    const header = response.headers.get('retry-after')?.trim() ?? '';
    const deadline = /^\d+$/.test(header) ? now + Number(header) * 1_000 : Date.parse(header);
    const retryAt = deadline > now && deadline < Date.UTC(9999, 0)
      ? deadline : now + DEFAULT_RATE_LIMIT_PAUSE_MS;
    return new WechatRateLimited(new Date(retryAt));
  }
}

async function readJson(response: Response) {
  if (!response.ok) throw wxResponseError;
  try { return responseSchema.parse(JSON.parse(await boundedOfferDocument(response, 500_000))); }
  catch { throw wxResponseError; }
}

async function authorizedRequest(credential: WechatCredential, path: string, query: Record<string, string>) {
  const session = { cookies: new Map(credential.cookies) };
  const response = await platformRequest(session, path, { ...query, ...jsonParams, token: credential.token });
  if (response.status === 401) throw new WechatAuthorizationExpired();
  if (response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    throw WechatRateLimited.fromResponse(response);
  }
  const result = await readJson(response);
  const info = result.base_resp;
  if (info?.ret === 200003 || /invalid session|not logged in|invalid token/i.test(info?.err_msg ?? '')) throw new WechatAuthorizationExpired();
  if (info?.ret === 200013) throw WechatRateLimited.fromResponse(response);
  if (info?.ret !== 0) throw wxResponseError;
  return result;
}

export async function createPlatformLogin() {
  const fingerprint = randomUUID().replaceAll('-', '');
  const session: Session = { cookies: new Map([['uuid', randomUUID().replaceAll('-', '')]]) };
  const home = await platformRequest(session, '/');
  await home.body?.cancel();
  const initial = await platformRequest(session, '/cgi-bin/bizlogin', { action: 'startlogin' }, {
    ...jsonParams, fingerprint, token: session.cookies.get('token') ?? '', login_type: '3', redirect_url: '/cgi-bin/home',
  });
  const state = await readJson(initial);
  if (state.base_resp?.ret) throw wxResponseError;
  const uuid = typeof state.uuid === 'string' ? state.uuid : initial.headers.get('x-uuid') || session.cookies.get('uuid');
  if (uuid && /^[\w-]{1,100}$/.test(uuid)) session.cookies.set('uuid', uuid);
  const image = await platformRequest(session, '/cgi-bin/scanloginqrcode', {
    action: 'getqrcode', uuid: session.cookies.get('uuid') ?? '', random: String(Date.now()),
  });
  const rawType = image.headers.get('content-type')?.split(';')[0];
  const type = rawType === 'image/jpg' ? 'image/jpeg' : rawType;
  if (!image.ok || !type || !['image/png', 'image/jpeg', 'image/gif'].includes(type)) throw new ApiError(502, '微信未返回扫码二维码，请稍后重试');
  const data = await boundedOfferBytes(image, 250_000);
  if (!data.length) throw wxResponseError;
  return { session, fingerprint, image: `data:${type};base64,${data.toString('base64')}` };
}

export type PlatformLogin = Omit<Awaited<ReturnType<typeof createPlatformLogin>>, 'image'>;
export async function checkPlatformLogin({ session, fingerprint }: PlatformLogin) {
  const scan = await readJson(await platformRequest(session, '/cgi-bin/scanloginqrcode', { ...jsonParams, action: 'ask', fingerprint }));
  if (scan.base_resp?.ret === 200003 || /invalid session/i.test(scan.base_resp?.err_msg ?? '')) return { status: 'expired' } as const;
  const status = Number(scan.status);
  if ([2, 4].includes(status)) return { status: 'scanned' } as const;
  if (![1, 3].includes(status)) return { status: 'waiting' } as const;
  const response = await platformRequest(session, '/cgi-bin/bizlogin', { action: 'login' }, {
    ...jsonParams, fingerprint, token: '', login_type: '3', userlang: 'zh_CN', redirect_url: '',
    cookie_forbidden: '0', cookie_cleaned: '0', plugin_used: '0',
  });
  const result = response.ok ? await readJson(response) : undefined;
  const location = response.headers.get('location') ?? result?.redirect_url;
  const path = typeof location === 'string' && URL.canParse(location, origin) ? new URL(location, origin) : undefined;
  const token = path?.origin === origin ? path.searchParams.get('token') : undefined;
  if (!token) return { status: 'scanned' } as const;
  const credential = wechatCredentialSchema.parse({ token, cookies: [...session.cookies] });
  return { status: 'authorized', credential, expiresAt: session.expiresAt } as const;
}

export async function findWechatAccounts(credential: WechatCredential, query: string) {
  const result = await authorizedRequest(credential, '/cgi-bin/searchbiz', { action: 'search_biz', begin: '0', count: '10', query });
  if (result.list == null && Number(result.total) === 0) return [];
  if (!Array.isArray(result.list)) throw wxResponseError;
  return result.list.slice(0, 10).flatMap((row: { fakeid?: string; nickname?: string }) => {
    const parsed = wechatAccountSchema.safeParse({ id: row?.fakeid, name: row?.nickname });
    return parsed.success ? [parsed.data] : [];
  });
}

function unwrap(value: unknown) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

export function wechatArticleLinks(value: unknown) {
  const page = z.object({ publish_list: z.array(z.object({ publish_info: z.unknown() })).optional(), total_count: z.coerce.number().optional() })
    .safeParse(unwrap(value));
  if (!page.success || !page.data.publish_list && page.data.total_count !== 0) throw wxResponseError;
  const list = page.data.publish_list ?? [];
  const articleLinks = new Set<string>();
  for (const item of list.slice(0, 5)) {
    const entry = z.object({ appmsgex: z.array(z.object({ link: z.string() })).optional() }).safeParse(unwrap(item.publish_info));
    for (const article of entry.success ? entry.data.appmsgex ?? [] : []) {
      const url = articleUrlSchema.safeParse(article.link);
      if (url.success) articleLinks.add(url.data);
    }
  }
  return [...articleLinks].slice(0, 12);
}

export async function listWechatArticleLinks(credential: WechatCredential, accountId: string) {
  const result = await authorizedRequest(credential, '/cgi-bin/appmsgpublish', {
    sub: 'list', sub_action: 'list_ex', begin: '0', count: '5', fakeid: accountId,
  });
  return wechatArticleLinks(result.publish_page);
}
