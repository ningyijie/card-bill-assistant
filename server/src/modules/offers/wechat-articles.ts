import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { parseExpressionAt } from 'acorn';
import { DomUtils, parseDocument } from 'htmlparser2';
import { z } from 'zod';
import { normalizedName } from './compare';
import { offerSchema } from './rules';

export const feedUrlSchema = z.string().trim().max(191).url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const { protocol, hostname, pathname, username, password, search, hash } = new URL(value);
  const [first, second] = hostname.split('.').map(Number);
  const local = isIPv4(hostname) && (first === 10 || first === 172 && second >= 16 && second <= 31
    || first === 192 && second === 168);
  return local && ['http:', 'https:'].includes(protocol) && !username && !password && !search && !hash
    && /^\/(?:feed\/MP_WXS_\d+\.(?:rss|atom|xml)|rss\/MP_WXS_\d+)$/.test(pathname);
}, '请填写 NAS 局域网 IP 上单个公众号的 WeRSS 订阅地址');

function wechatUrl(value: string) {
  if (value.length > 600) return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'mp.weixin.qq.com'
      || url.port || url.username || url.password) return;
    const canonical = new URL(url.pathname, 'https://mp.weixin.qq.com');
    if (/^\/s\/[\w-]+$/.test(url.pathname)) return canonical.href;
    if (url.pathname !== '/s') return;
    for (const field of ['__biz', 'mid', 'idx', 'sn']) {
      const part = url.searchParams.get(field);
      if (!part || !/^[\w=+-]+$/.test(part)) return;
      canonical.searchParams.set(field, part);
    }
    return canonical.href;
  } catch { return; }
}

export const articleUrlSchema = z.string().trim().max(600).transform((value, ctx) => {
  const url = wechatUrl(value);
  if (url) return url;
  ctx.addIssue({ code: 'custom', message: '请输入 mp.weixin.qq.com 的公众号文章链接' });
  return z.NEVER;
});

export interface WechatArticle { url: string; title: string; text: string }

const tidy = (text: string) => text.replace(/[\t\p{Zs}]+/gu, ' ').trim();
const heading = /^(?:#{1,6}\s*)?(?:[0-9]{1,2}\s*[、.．)）]|[（(][0-9]{1,2}[）)]|[一二三四五六七八九十]+、|[①②③④⑤⑥⑦⑧⑨⑩])|^#{1,6}\s+/;
const promo = /优惠|立减|满减|满\s*\d+(?:\.\d+)?\s*元?\s*减|返现|打折|\d折|兑换|抢兑|领券|优惠券|代金券|消费达标|报名|立减金|积分|团办|抽奖|返刷卡金|支付有礼/;

function textFromHtml(html: string) {
  const document = parseDocument(html);
  const parts: string[] = [];
  const visit = (node: (typeof document.children)[number]) => {
    if (DomUtils.isText(node)) parts.push(node.data);
    if (!DomUtils.isTag(node) || /^(?:script|style|noscript|svg|iframe|template|video|audio)$/.test(node.name)) return;
    const block = /^(?:div|p|section|br|article|tr|li|h[1-6]|blockquote)$/.test(node.name);
    if (block) parts.push('\n');
    if (/^(?:li|h[1-6])$/.test(node.name)) parts.push('# ');
    node.children.forEach(visit);
    if (block) parts.push('\n');
  };
  document.children.forEach(visit);
  return parts.join('').split('\n').map(tidy).filter(Boolean).join('\n');
}

const imagePostAssignment = /\bwindow\.cgiDataNew\s*=\s*(?=\{)/;

function readImageCaption(children: ReturnType<typeof parseDocument>['children']) {
  const script = DomUtils.findOne((node) => node.name === 'script'
    && imagePostAssignment.test(DomUtils.textContent(node)), children);
  if (!script) return;
  const source = DomUtils.textContent(script);
  const marker = imagePostAssignment.exec(source);
  if (!marker) return;
  try {
    // Read literal page data without executing the WeChat scripts.
    const data = parseExpressionAt(source, marker.index + marker[0].length, { ecmaVersion: 'latest' });
    if (data.type !== 'ObjectExpression') return;
    const fields = new Map(data.properties.flatMap((field) => {
      if (field.type !== 'Property' || field.computed || field.kind !== 'init') return [];
      const key = field.key.type === 'Identifier' ? field.key.name : field.key.type === 'Literal' ? field.key.value : null;
      return typeof key === 'string' ? [[key, field.value] as const] : [];
    }));
    const showType = fields.get('item_show_type');
    const type = showType?.type === 'BinaryExpression' && showType.operator === '*'
      && showType.right.type === 'Literal' && showType.right.value === 1 ? showType.left : showType;
    const pictures = fields.get('picture_page_info_list');
    if (type?.type !== 'Literal' || (type.value !== 8 && type.value !== '8')
      || pictures?.type !== 'ArrayExpression' || !pictures.elements.length) return;

    const literal = (key: string) => {
      const field = fields.get(key);
      return field?.type === 'Literal' && typeof field.value === 'string' ? field.value : '';
    };
    // The image post renders its caption from content or desc. Other page types use desc for previews.
    const content = fields.get('content');
    if (content && content.type !== 'Literal') return;
    const text = textFromHtml(literal('content') || literal('desc'));
    if (text) return { title: tidy(literal('title')), text };
  } catch { /* Invalid or unfamiliar bootstrap data is not article content. */ }
}

export function parseWechatPage(url: string, html: string): WechatArticle | undefined {
  const { children } = parseDocument(html);
  const body = DomUtils.findOne((node) => node.attribs.id === 'js_content', children);
  const text = body && textFromHtml(DomUtils.getInnerHTML(body));
  if (!text) {
    const caption = readImageCaption(children);
    if (caption) return { url, text: caption.text, title: caption.title || '公众号活动' };
    return;
  }
  const title = DomUtils.findOne((node) => node.attribs.id === 'activity-name' || node.attribs.id === 'js_article_title', children);
  return { url, title: tidy(title ? DomUtils.textContent(title) : '') || '公众号活动', text };
}

export function parseWechatFeed(xml: string) {
  const document = parseDocument(xml, { xmlMode: true });
  const root = document.children.find(DomUtils.isTag);
  const channel = root?.name === 'rss' ? root.children.filter(DomUtils.isTag).find((tag) => tag.name === 'channel') : root;
  if (!channel || !['channel', 'feed'].includes(channel.name)) throw new Error('该地址没有返回有效的 RSS 或 Atom 订阅');

  const articles: WechatArticle[] = [];
  let missing = 0;
  for (const item of channel.children.filter(DomUtils.isTag)) {
    if (!['item', 'entry'].includes(item.name)) continue;
    const fields = item.children.filter(DomUtils.isTag);
    const field = (name: string) => {
      const node = fields.find((tag) => tag.name === name);
      return node ? DomUtils.textContent(node).trim() : '';
    };
    const url = [field('link'), ...fields.filter((tag) => tag.name === 'link').map((tag) => tag.attribs.href ?? ''),
      field('guid'), field('id')].map(wechatUrl).find(Boolean);
    const title = tidy(field('title'));
    // WeRSS 的 description/summary 只含摘要。正文补抓完成后再入库。
    const body = field('content:encoded') || field('content');
    const text = textFromHtml(body.startsWith('<![CDATA[') && body.endsWith(']]>') ? body.slice(9, -3) : body);
    if (url && title && text) articles.push({ url, title, text });
    else missing++;
  }
  return { articles, missing };
}

const bankAliases: Record<string, string> = {
  工商银行: '工商银行|工行', 建设银行: '建设银行|建行', 农业银行: '农业银行|农行', 中国银行: '中国银行|中行',
  交通银行: '交通银行|交行', 邮储银行: '邮储银行|邮政储蓄|邮储', 招商银行: '招商银行|招行|掌上生活',
  华夏银行: '华夏银行|华夏信用卡|华夏卡|华夏UP|华夏白', 中信银行: '中信银行|中信信用卡|中信卡|中信精彩|动卡空间',
  兴业银行: '兴业银行|兴业信用卡|兴业团办|兴业卡|好兴动', 浙商银行: '浙商银行|浙商信用卡|浙商卡|浙商文旅',
  广发银行: '广发银行|广发信用卡|广发卡|发现精彩', 平安银行: '平安银行|平安信用卡|平安卡',
  光大银行: '光大银行|光大信用卡|光大卡', 浦发银行: '浦发银行|浦发信用卡|浦发卡',
  民生银行: '民生银行|民生信用卡|民生卡', 北京银行: '北京银行', 上海银行: '上海银行',
};

export function articleDrafts(article: WechatArticle, ownedBanks: string[], knownMerchants: string[], automatic = false) {
  const banks = [...new Set([...Object.keys(bankAliases), ...ownedBanks])];
  const patterns = banks.map((bank) => [bank, (bankAliases[bank] ?? bank).split('|').map(normalizedName)] as const);
  const normalizedOwned = new Set(ownedBanks.map((name) => normalizedName(name).replace(/^中国/, '')));
  const lines = article.text.split(/\r?\n/).map(tidy).filter(Boolean).slice(0, 400);
  const sections: string[][] = [];
  for (const line of lines) {
    const startsWithBank = line.length < 65 && promo.test(line) && patterns.some(([, names]) =>
      names.some((name) => normalizedName(line).startsWith(name)));
    if (!sections.length || heading.test(line) || startsWithBank) sections.push([]);
    sections.at(-1)!.push(line);
  }

  const candidates = sections.filter((section) => promo.test(section.join(' ')));
  if (automatic && !candidates.length && !promo.test(article.title)) return [];
  const chosen = candidates.length ? candidates : [lines];
  const unique = new Set<string>();
  return chosen.slice(0, 25).flatMap((section) => {
    const text = section.join('\n').slice(0, 8000);
    if (!text || unique.has(text)) return [];
    unique.add(text);
    const content = normalizedName(chosen.length === 1 ? `${article.title} ${text}` : text);
    const matchedBanks = patterns.filter(([, names]) => names.some((name) => content.includes(name))).map(([bank]) => bank);
    const own = matchedBanks.filter((name) => normalizedOwned.has(normalizedName(name).replace(/^中国/, '')));
    if (ownedBanks.length && matchedBanks.length && !own.length) return [];
    const banksToUse = own.length ? own : matchedBanks;
    const bankName = banksToUse.length === 1 ? banksToUse[0] : undefined;
    const title = section.length && (chosen.length > 1 || heading.test(section[0]))
      ? section[0].replace(heading, '').trim() || article.title : article.title;
    const merchants = knownMerchants.filter((name) => content.includes(normalizedName(name))).slice(0, 16);
    const compact = text.normalize('NFKC').replace(/\s+/g, '');
    const fixed = compact.match(/满(\d{1,6}(?:\.\d{1,2})?)元?(?:立减|减)(\d{1,6}(?:\.\d{1,2})?)元/);
    const random = compact.match(/满(\d{1,6}(?:\.\d{1,2})?)元?随机(?:立)?减(?:最高|至多)(\d{1,6}(?:\.\d{1,2})?)元/);
    const match = random ?? fixed;
    const amount = match ? Number(match[2]) : 0;
    const common = { title: title.slice(0, 120), kind: 'activity', bankName, merchants,
      sourceUrl: article.url, sourceText: text, needsEligibility: true };
    const parsed = offerSchema.safeParse({ ...common, threshold: amount > 0 ? Number(match![1]) : undefined,
      discount: amount > 0 ? (random ? { type: 'random', max: amount } : { type: 'fixed', amount }) : { type: 'service' } });
    return parsed.success ? [{ rule: parsed.data, fingerprint: createHash('sha256').update(text).digest('hex') }] : [];
  });
}
