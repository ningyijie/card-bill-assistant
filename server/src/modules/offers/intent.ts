import { z } from 'zod';
import { addDays, fromYmd, ymd } from '../../lib/dates';
import { normalizedName } from './compare';
import { offerQuerySchema } from './rules';
import type { OfferQuery } from './rules';

const textChannels = [
  [/微信/, 'wechat'], [/支付宝/, 'alipay'], [/云闪付|银联扫码/, 'unionpay'],
  [/掌银|掌上生活|银行App/i, 'bank_app'], [/刷卡|POS/i, 'pos'], [/商户App/i, 'merchant_app'],
] as const;
const aliases = ['海底捞', '奈雪', '喜茶', '瑞幸', '星巴克', '肯德基', '麦当劳', '山姆'];

export function extractOfferIntent(question: string, merchants: string[], now = new Date()): OfferQuery | null {
  const text = question.normalize('NFKC').trim();
  const key = normalizedName(text);
  const known = [...new Set([...merchants, ...aliases])].sort((a, b) => b.length - a.length);
  const merchant = known.find((name) => key.includes(normalizedName(name)))
    ?? text.match(/(?:吃|喝|买|去)\s*([^ ，。！？,.?]{1,28}?)(?=\s*(?:[,，。！？?]|有什么|怎么|用什么|用哪|哪个|有优惠|有券|$))/)?.[1]
    ?? text.match(/^([^\s，。！?？]{1,30})\s*(?:有[什么]*优惠|用哪张卡|优惠)[?？]?$/)?.[1]
    ?? (/^[\p{Script=Han}a-zA-Z0-9&· ]{1,24}$/u.test(text) && !/优惠|哪张卡|怎么办|今晚|明天|预算/.test(text) ? text : undefined);
  if (!merchant) return null;
  const explicitDate = text.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];
  const weekday = text.match(/(?:周|星期)([一二三四五六日天])/);
  let date = explicitDate && z.iso.date().safeParse(explicitDate).success ? explicitDate : undefined;
  if (!date && /明天|后天/.test(text)) date = ymd(addDays(fromYmd(ymd(now)), text.includes('后天') ? 2 : 1));
  if (!date && weekday) {
    const target = weekday[1] === '天' ? 7 : '一二三四五六日'.indexOf(weekday[1]) + 1;
    const midnight = fromYmd(ymd(now));
    const current = new Date(midnight.getTime() + 8 * 3_600_000).getUTCDay() || 7;
    const days = /下(?:周|星期)/.test(text) ? 7 - current + target : (target - current + 7) % 7;
    date = ymd(addDays(midnight, days));
  }
  const budgetRaw = text.match(/(?:预算(?:约|是)?|打算花|预计花|大概花)\s*[:：]?\s*[¥￥]?\s*(\d{1,6}(?:\.\d{1,2})?)/)?.[1]
    ?? text.match(/(?:[¥￥]\s*)?(\d{1,6}(?:\.\d{1,2})?)\s*元(?:左右|以内|预算)/)?.[1];
  const channel = textChannels.filter(([pattern]) => pattern.test(text));
  const inferredCity = text.match(/(?:在|城市[:：])\s*([\p{Script=Han}]{2,10}?)(?=[，,\s吃喝买去]|$)/u)?.[1];
  const parsed = offerQuerySchema.safeParse({
    merchant, city: inferredCity, date, budget: budgetRaw ? Number(budgetRaw) : undefined,
    channel: channel.length === 1 ? channel[0][1] : undefined,
  });
  return parsed.success ? parsed.data : null;
}

export function ollamaEnabled() {
  return Boolean(process.env.OFFERS_OLLAMA_URL?.trim() && process.env.OFFERS_OLLAMA_MODEL?.trim());
}

/** 只发送问题与商户词表。模型结构化提取商户，报价及适用性由本地规则计算。 */
export async function resolveMerchantWithOllama(question: string, merchants: string[]): Promise<string | null> {
  if (!ollamaEnabled()) return null;
  try {
    const base = new URL(process.env.OFFERS_OLLAMA_URL!.trim());
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return null;
    const response = await fetch(new URL('/api/chat', base), {
      method: 'POST', signal: AbortSignal.timeout(8000), redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OFFERS_OLLAMA_MODEL!.trim(), stream: false,
        format: { type: 'object', properties: { merchant: { type: 'string' } }, required: ['merchant'] },
        options: { temperature: 0, num_predict: 64 },
        messages: [
          { role: 'system', content: '从中文问题里提取商户品牌，只返回 merchant。没有商户时返回空字符串。不可猜测未提及的品牌。' },
          { role: 'user', content: JSON.stringify({ question, knownMerchants: merchants.slice(0, 80) }) },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = z.object({ message: z.object({ content: z.string().max(1000) }) }).parse(await response.json());
    const merchant = z.object({ merchant: z.string().trim().min(1).max(80) }).parse(JSON.parse(data.message.content)).merchant;
    const name = normalizedName(merchant);
    return name && normalizedName(question).includes(name) ? merchant : null;
  } catch { return null; }
}
