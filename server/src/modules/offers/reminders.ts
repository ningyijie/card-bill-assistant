import { prisma } from '../../lib/prisma';
import { addDays, fromYmd, lastDayOfMonth, monthParts, today, ymd } from '../../lib/dates';
import { loadCardSpendProgress } from '../bills/card-spend-service';
import { activeOn } from './compare';
import { readOfferRecord, readOfferRule } from './rules';

export async function collectOfferReminderEvents(now = today()) {
  const date = ymd(now);
  const soon = ymd(addDays(now, 3));
  const { year, month } = monthParts(now);
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${lastDayOfMonth(year, month)}`;
  const rows = await prisma.cardOfferRecord.findMany({
    where: { card: { hidden: false, status: 'active' }, offer: { review: 'ready' } },
    select: { id: true, cardId: true, state: true, offer: { select: { rule: true } },
      card: { select: { bankName: true, nickname: true } } },
  });
  const events: { type: string; refId: number; title: string; body: string; fireDate: Date; channelType: 'bark' }[] = [];
  const spend = new Map<number, Awaited<ReturnType<typeof loadCardSpendProgress>>>();
  for (const row of rows) {
    const state = readOfferRecord(row.state);
    const rule = readOfferRule(row.offer.rule);
    if (!rule || !state.favorite || !state.reminder || state.status === 'used' || state.remaining === 0 || state.eligible === false) continue;
    let anchor: string;
    let text: string;
    if (state.reminder === 'claim') {
      const claimToday = rule.claimOn ? rule.claimOn === date
        : (rule.weekdays.length > 0 || rule.startsOn === date) && activeOn(rule, date);
      if (!claimToday || state.status === 'claimed' || (rule.endsOn && rule.endsOn < date)) continue;
      anchor = date;
      text = rule.claimAt ? `今天 ${rule.claimAt} 开始领取` : '今天可查看领取入口';
    } else if (state.reminder === 'expiry') {
      const deadline = state.voucherEndsOn ?? rule.endsOn;
      if (!deadline || deadline < date || deadline > soon) continue;
      anchor = deadline;
      text = `有效期至 ${deadline}`;
    } else {
      if (!rule.spendRuleId || state.eligible === true || date > monthEnd || monthEnd > soon
        || rule.endsOn && rule.endsOn < date || rule.startsOn && rule.startsOn > date) continue;
      if (!spend.has(row.cardId)) spend.set(row.cardId, await loadCardSpendProgress(row.cardId));
      const period = spend.get(row.cardId)?.tracks.find((track) => track.rule.id === rule.spendRuleId)?.periods.at(-1);
      if (!period || period.startsOn > date || period.endsOn < date || (period.bankCount != null || period.bankAmount != null) && period.remaining === 0) continue;
      anchor = monthEnd;
      text = '月底前请核对本期达标进度';
    }
    events.push({ type: `offer_${state.reminder}`, refId: row.id, title: rule.title,
      body: [row.card.nickname ?? row.card.bankName, text, rule.entry].filter(Boolean).join('\n'),
      fireDate: fromYmd(anchor), channelType: 'bark' });
  }
  return events;
}
