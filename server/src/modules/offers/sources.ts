import { createHash } from 'node:crypto';
import { DomUtils, parseDocument } from 'htmlparser2';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../lib/errors';
import { ymd } from '../../lib/dates';
import { withTransactionRetry } from '../../parsers/pipeline';
import { normalizedName } from './compare';
import { offerSchema, readOfferRule } from './rules';
import type { RewardOfferInput } from './rules';
import { saveOfferInTransaction } from './service';

interface OfficialEntry { key: string; review: 'ready' | 'draft'; rule: RewardOfferInput }

export const offerSources = [
  { key: 'citic-365', name: '中信精彩365 · 支付立减', bank: '中信银行',
    url: 'https://creditcard.ecitic.com/h5/youhui/250530/index.html', initialMerchants: ['海底捞'] },
  { key: 'citic-365-redeem', name: '中信精彩365 · 优惠券兑换', bank: '中信银行',
    url: 'https://creditcard.ecitic.com/jieshao/jieshao09.html', initialMerchants: ['海底捞', '奈雪', '百果园', '朴朴超市'] },
  { key: 'citic-9-points', name: '中信9分享兑', bank: '中信银行',
    url: 'https://creditcard.ecitic.com/jieshao/jieshao06.html', initialMerchants: ['奈雪', '喜茶', '星巴克', '霸王茶姬', '古茗', '蜜雪冰城'] },
  { key: 'cib', name: '兴业缤纷优惠', bank: '兴业银行', url: 'https://creditcard.cib.com.cn/promotion/' },
  { key: 'cgb', name: '广发福利专区', bank: '广发银行', url: 'https://www.cgbchina.com.cn/Channel/23158038' },
] as const;
type Source = typeof offerSources[number];

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();
const bankDate = (value: string[]) => `${value[0]}-${value[1].padStart(2, '0')}-${value[2].padStart(2, '0')}`;
const chineseDate = '(20[0-9]{2})年\\s*(\\d{1,2})月\\s*(\\d{1,2})日';

function parseCiticCouponPage(source: Extract<Source, { key: 'citic-365-redeem' | 'citic-9-points' }>, document: ReturnType<typeof parseDocument>): OfficialEntry[] {
  const rows = new Map(DomUtils.getElementsByTagName('tr', document.children, true).map((row) => {
    const cells = DomUtils.getElementsByTagName('td', row.children, false).map((cell) => tidy(DomUtils.textContent(cell)));
    return [cells[0], cells.slice(1).join(' ')] as const;
  }));
  const range = rows.get('活动时间')?.match(new RegExp(`${chineseDate}\\s*至\\s*${chineseDate}`));
  const rules = rows.get('活动规则') ?? '';
  const audience = rows.get('活动对象') ?? '';
  const isPoints = source.key === 'citic-9-points';
  const rewards = rows.get(isPoints ? '咖啡奶茶场景' : '活动奖励') ?? '';
  const merchants = source.initialMerchants.filter((merchant) => rewards.includes(merchant));
  const tiers = [...new Set(rules.match(/\d{3,6}(?=\s*元)/g))];
  if (!range || !merchants.length || !tiers.length || !audience.includes('主卡') || !rewards.includes('券')) {
    throw new Error('页面缺少适用商户、活动日期或达标规则，请在银行 App 核对');
  }
  const time = rules.match(/每日\s*(\d{1,2}:\d{2})/)?.[1]?.padStart(5, '0');
  const cost = isPoints ? rewards.match(/权益\s*\+\s*(\d+)\s*积分/)?.[1] : undefined;
  if (isPoints && !cost) throw new Error('官网页面缺少积分兑换条件，请在银行 App 核对');
  const entry = [
    `在动卡空间 App 搜索「${isPoints ? '9分享兑' : '精彩365'}」，核对本期是否有该品牌、所需档位及库存。`,
    `按主卡客户每自然月累计交易计算，达标档位 ${tiers.join(' / ')} 元。`,
    isPoints ? `主卡资格及持卡时长以活动页为准。兑换需对应档位权益和 ${cost} 积分。`
      : /0元档/.test(rows.get('活动内容') ?? '') ? '也可查看 0 元档购券专区，券种与价格以 App 为准。' : '',
  ].join(' ').trim();
  return [{ key: source.key, review: 'ready', rule: offerSchema.parse({
    title: source.name, kind: 'activity', bankName: source.bank, merchants, discount: { type: 'service' },
    startsOn: bankDate(range.slice(1, 4)), endsOn: bankDate(range.slice(4, 7)), claimAt: time,
    needsEligibility: true, requiresClaim: true, limited: true,
    entry, sourceUrl: source.url, sourceText: [rewards, rules].join('\n'),
  }) }];
}

export function parseOfficialOfferPage(source: Source, html: string): OfficialEntry[] {
  const document = parseDocument(html);
  DomUtils.findAll((element) => element.name === 'style' || element.name === 'script', document.children).forEach(DomUtils.removeElement);
  if (source.key === 'citic-365-redeem' || source.key === 'citic-9-points') return parseCiticCouponPage(source, document);
  if (source.key === 'citic-365') {
    const page = tidy(DomUtils.innerText(document.children));
    const range = page.match(new RegExp(`活动时间\\s*[:：]\\s*${chineseDate}\\s*至\\s*(?:(20[0-9]{2})年)?\\s*(\\d{1,2})月\\s*(\\d{1,2})日`));
    const detailRange = page.match(new RegExp(`${chineseDate}\\s*至\\s*(?:(20[0-9]{2})年)?\\s*(\\d{1,2})月\\s*(\\d{1,2})日\\s*期间每日\\s*\\d{1,2}点起`));
    const promotion = page.split('支付宝满立减')[0];
    const prepared = promotion.match(/满\s*(\d+)\s*元随机立?减最高\s*(\d+)\s*元\s*海底捞火锅/);
    if (!range || !prepared || !/微信满立减/.test(promotion) || !/海底捞火锅.{0,45}线下.{0,40}微信支付/.test(page)) {
      throw new Error('页面结构已变，请在银行 App 核对后录入');
    }
    const startsAt = page.match(/每日\s*(\d{1,2})点起/)?.[1];
    const startOf = (hit: RegExpMatchArray) => bankDate(hit.slice(1, 4));
    const endOf = (hit: RegExpMatchArray) => bankDate([hit[4] ?? hit[1], hit[5], hit[6]]);
    const startsOn = [startOf(range), ...(detailRange ? [startOf(detailRange)] : [])].sort().at(-1)!;
    const endsOn = [endOf(range), ...(detailRange ? [endOf(detailRange)] : [])].sort()[0];
    const totalUses = page.match(/每自然月(?:可参与|限)\s*(\d{1,3})\s*次/)?.[1];
    return [{
      key: 'citic-365:haidilao:wechat', review: 'ready',
      rule: offerSchema.parse({
        title: '中信精彩365 · 海底捞微信支付', kind: 'activity', merchants: ['海底捞'],
        bankName: source.bank, startsOn, endsOn,
        startsAt: startsAt ? `${startsAt.padStart(2, '0')}:00` : undefined,
        channels: ['wechat'], threshold: Number(prepared[1]), discount: { type: 'random', max: Number(prepared[2]) },
        entry: '动卡空间 → 优惠·积分 → 美食优惠 → 搜索海底捞。到店微信绑中信信用卡支付时核对名额和实减。',
        cycle: totalUses ? 'month' : undefined, totalUses: totalUses ? Number(totalUses) : undefined,
        stacking: /不可叠加多个立减优惠/.test(page) ? '规则注明单笔仅可使用一种优惠' : undefined,
        limited: true, sourceUrl: source.url, sourceText: tidy(prepared[0]),
      }),
    }];
  }

  // 公告目录只提供标题和入口。确认商户、卡种、期限和金额后，草稿才能进入查询。
  const urls = new Set<string>();
  const links = DomUtils.getElementsByTagName('a', document.children, true);
  return links.flatMap((link): OfficialEntry[] => {
    const title = tidy(DomUtils.textContent(link));
    if (title.length < 9 || /消费者接待|消费者权益保护/.test(title)
      || !/优惠|立减|满减|返现|达标|领取|消费|抢兑|券包|礼包|新户|有礼|积分|权益金/.test(title)) return [];
    let target: URL;
    try { target = new URL(link.attribs.href ?? '', source.url); } catch { return []; }
    if (target.origin !== new URL(source.url).origin || target.username || target.password) return [];
    if (source.key === 'cib' ? !/\/promotion\/(?:national|area|global|overseas)\/(?!index)/.test(target.pathname)
      : !/^\/Info\/\d+$/i.test(target.pathname)) return [];
    target.hash = '';
    if (urls.has(target.href)) return [];
    urls.add(target.href);
    const key = createHash('sha256').update(target.href).digest('hex');
    return [{
      key: `${source.key}:${key}`, review: 'draft',
      rule: offerSchema.parse({ title: title.slice(0, 120), kind: 'activity', bankName: source.bank,
        discount: { type: 'service' }, sourceUrl: target.href }),
    }];
  }).slice(0, 20);
}

export async function boundedOfferDocument(response: Response, max = 1_500_000) {
  if (!response.body || Number(response.headers.get('content-length') ?? 0) > max) throw new Error('来源内容体积超过限制');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error('来源内容体积超过限制');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const buffer = Buffer.concat(chunks);
  const charset = response.headers.get('content-type') + buffer.subarray(0, 4000).toString('latin1');
  return new TextDecoder(/charset\s*=\s*["']?(?:gbk|gb2312|gb18030)/i.test(charset) ? 'gb18030' : 'utf-8').decode(buffer);
}

export function initialOfferSources(merchant: string) {
  const name = normalizedName(merchant);
  return offerSources.filter((source) => 'initialMerchants' in source
    && source.initialMerchants.some((item) => normalizedName(item) === name));
}

const refreshing = new Map<string, Promise<{ updated: number }>>();
export async function refreshOfferSource(key: string, mode: 'daily' | 'manual' | 'initial' = 'daily') {
  const source = offerSources.find((item) => item.key === key);
  if (!source) throw new ApiError(404, '找不到活动来源');
  let job = refreshing.get(key);
  try {
    if (!job) {
      const state = await prisma.rewardSource.findUnique({ where: { key } });
      job = refreshing.get(key);
      if (!job) {
        if (mode !== 'manual' && (state?.enabled === false
          || state?.lastAttempt && (mode === 'initial' || ymd(state.lastAttempt) === ymd()))) return { updated: 0 };
        job = syncOfferSource(source, state);
        refreshing.set(key, job);
      }
    }
    return await job;
  } catch (error) {
    if (mode === 'daily') return { updated: 0 };
    throw error;
  } finally {
    if (job && refreshing.get(key) === job) refreshing.delete(key);
  }
}

async function syncOfferSource(source: Source, state: Awaited<ReturnType<typeof prisma.rewardSource.findUnique>>) {
  const { key } = source;
  const lastAttempt = new Date();
  await prisma.rewardSource.upsert({ where: { key }, create: { key, enabled: true, lastAttempt }, update: { lastAttempt } });
  try {
    const response = await fetch(source.url, { redirect: 'error', signal: AbortSignal.timeout(7500), headers: {
      Accept: 'text/html', 'User-Agent': 'Mozilla/5.0',
      ...(state?.etag ? { 'If-None-Match': state.etag } : {}),
      ...(state?.lastModified ? { 'If-Modified-Since': state.lastModified } : {}),
    } });
    let updated = 0;
    if (response.status !== 304) {
      if (!response.ok) throw new Error(`官方页面返回 HTTP ${response.status}`);
      const records = parseOfficialOfferPage(source, await boundedOfferDocument(response));
      if (records.length === 0) throw new Error('公开目录没有可识别的活动');
      updated = await withTransactionRetry(() => prisma.$transaction(async (tx) => {
        let count = 0;
        for (const record of records) {
          const fingerprint = createHash('sha256').update(JSON.stringify(record.rule)).digest('hex');
          const stored = await tx.rewardOffer.findUnique({ where: { sourceKey: record.key } });
          if (stored?.review === 'archived') continue;
          if (stored?.fingerprint === fingerprint) {
            if (stored.review === 'ready' && record.review === 'ready') {
              await tx.rewardOffer.update({ where: { id: stored.id }, data: { verifiedAt: new Date() } });
            }
            continue;
          }
          const priorRule = stored ? readOfferRule(stored.rule) : undefined;
          const rule = record.review === 'draft' && priorRule
            ? { ...priorRule, title: record.rule.title, sourceUrl: record.rule.sourceUrl }
            : record.rule;
          await saveOfferInTransaction(tx, rule, record.review, stored?.id, { sourceKey: record.key, fingerprint });
          count++;
        }
        return count;
      }, { isolationLevel: 'Serializable' }));
    }
    await prisma.rewardSource.update({ where: { key }, data: {
      lastSuccess: new Date(), error: null,
      ...(response.status !== 304 ? {
        etag: response.headers.get('etag')?.slice(0, 255) ?? null,
        lastModified: response.headers.get('last-modified')?.slice(0, 100) ?? null,
      } : {}),
    } });
    return { updated };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : '公开来源暂时无法读取';
    await prisma.rewardSource.update({ where: { key }, data: { error: detail } });
    throw new ApiError(502, `同步失败，已保留之前的活动。 ${detail}`);
  }
}

export async function refreshEnabledOfferSources() {
  for (const { key } of offerSources) await refreshOfferSource(key);
}

export async function offerSourceStatus() {
  const states = new Map((await prisma.rewardSource.findMany()).map((state) => [state.key, state]));
  return offerSources.map(({ key, name, url }) => ({
    key, name, url, enabled: states.get(key)?.enabled ?? true,
    lastSuccess: states.get(key)?.lastSuccess ?? null, error: states.get(key)?.error ?? null,
  }));
}
