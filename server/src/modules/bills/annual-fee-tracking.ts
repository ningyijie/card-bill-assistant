import { prisma } from '../../lib/prisma';
import { daysBetween, ymd } from '../../lib/dates';
import { isAnnualFeeCharge, isAnnualFeeCredit } from '../../parsers/_util';

export const annualFeeSettlementModes = ['automatic', 'automaticRefund', 'apply', 'none'] as const;
export const annualFeeReviewStatuses = ['pending', 'requested', 'refunded', 'closed'] as const;
type ReviewStatus = typeof annualFeeReviewStatuses[number];
type Settlement = typeof annualFeeSettlementModes[number];

export const annualFeeTransactions = {
  where: { description: { contains: '年费' } },
  select: {
    cardId: true,
    cardLast4: true,
    bankName: true,
    description: true,
    amount: true,
    currency: true,
    transactionDate: true,
  },
} as const;

interface TrackingCard {
  id: number;
  bankName: string;
  cardLast4: string;
  displayLast4?: string | null;
  hidden?: boolean;
  annualFeePolicy?: unknown;
}

interface TrackingBill {
  id: number;
  cardId: number;
  period: string;
  statementDate: Date;
  annualFeeAmount: unknown;
  currency: string;
  cards?: { cardId: number }[];
  transactions?: {
    cardId: number | null;
    cardLast4: string | null;
    bankName: string;
    description: string;
    amount: unknown;
    currency: string;
    transactionDate?: Date | null;
  }[];
}

interface ReviewKey {
  cardId: number;
  period: string;
  currency: string;
}

interface Fee extends ReviewKey {
  billId: number;
  date: Date;
  cents: number;
}

const feeKey = ({ cardId, period, currency }: ReviewKey) => `${cardId}:${period}:${currency}`;
const accountKey = ({ cardId, currency }: Fee) => `${cardId}:${currency}`;

function settlementOf(policy: unknown): Settlement | null {
  if (!policy || typeof policy !== 'object' || !('settlement' in policy)) return null;
  return annualFeeSettlementModes.find((mode) => mode === policy.settlement) ?? null;
}

function defaultStatus(settlement: Settlement | null) {
  if (settlement === 'apply') return 'apply';
  if (settlement === 'automaticRefund') return 'waiting';
  if (settlement === 'none') return 'closed';
  return 'review';
}

/** 同卡同币、优先等额。每笔入账需能唯一匹配，累计金额不能超过原扣费。 */
function matchRefunds(charges: Fee[], refunds: Fee[]) {
  const chargesByAccount = new Map<string, Fee[]>();
  for (const charge of charges) {
    const key = accountKey(charge);
    const group = chargesByAccount.get(key) ?? [];
    group.push(charge);
    chargesByAccount.set(key, group);
  }
  const candidates = new Map<Fee, Array<{ refund: Fee; uniqueCharge: boolean }>>();
  for (const refund of refunds) {
    const eligible = (chargesByAccount.get(accountKey(refund)) ?? []).filter((charge) => {
      const elapsed = daysBetween(charge.date, refund.date);
      return elapsed >= 0 && elapsed < 365 && refund.cents <= charge.cents;
    });
    const exact = eligible.filter((charge) => refund.cents === charge.cents);
    const matches = exact.length > 0 ? exact : eligible;
    for (const charge of matches) {
      const options = candidates.get(charge) ?? [];
      options.push({ refund, uniqueCharge: matches.length === 1 });
      candidates.set(charge, options);
    }
  }
  const matches = new Map<Fee, Pick<Fee, 'cents' | 'date'>>();
  for (const [charge, options] of candidates) {
    if (options.some((option) => !option.uniqueCharge)) continue;
    const cents = options.reduce((total, { refund }) => total + refund.cents, 0);
    if (cents > charge.cents) continue;
    const date = options.reduce((latest, { refund }) => refund.date > latest ? refund.date : latest, options[0].refund.date);
    matches.set(charge, { cents, date });
  }
  return matches;
}

export function buildAnnualFeeTracking(
  cards: TrackingCard[],
  bills: TrackingBill[],
  reviews: (ReviewKey & { status: string })[],
) {
  const cardsById = new Map(cards.filter((card) => !card.hidden).map((card) => [card.id, card]));
  const reviewsByKey = new Map(reviews.map((review) => [feeKey(review), review.status]));
  const chargesByPeriod = new Map<string, Fee>();
  const refunds: Fee[] = [];

  for (const bill of bills) {
    const linked = [...new Set([bill.cardId, ...(bill.cards ?? []).map((card) => card.cardId)])];
    const transactions = bill.transactions ?? [];
    const chargeLines = transactions.filter((line) => isAnnualFeeCharge({ ...line, amount: Number(line.amount) }));
    const annualFee = Number(bill.annualFeeAmount);
    const addCharge = (charge: Fee) => {
      const key = feeKey(charge);
      const existing = chargesByPeriod.get(key);
      if (existing) {
        existing.cents += charge.cents;
        if (charge.date > existing.date) {
          existing.date = charge.date;
          existing.billId = charge.billId;
        }
      } else {
        chargesByPeriod.set(key, charge);
      }
    };
    if (!chargeLines.length && linked.length === 1 && cardsById.has(bill.cardId) && annualFee > 0) {
      addCharge({
        cardId: bill.cardId, period: bill.period, currency: bill.currency,
        date: bill.statementDate, billId: bill.id, cents: Math.round(annualFee * 100),
      });
    }
    for (const line of transactions) {
      const amount = Number(line.amount);
      const isCharge = isAnnualFeeCharge({ ...line, amount });
      const isRefund = isAnnualFeeCredit({ ...line, amount });
      if (!isCharge && !isRefund) continue;
      let cardId = line.cardId;
      if (cardId == null && line.cardLast4) {
        const matches = linked.filter((id) => {
          const card = cardsById.get(id);
          return card?.bankName === line.bankName
            && (card.cardLast4 === line.cardLast4 || card.displayLast4 === line.cardLast4);
        });
        cardId = matches.length === 1 ? matches[0] : null;
      } else if (cardId == null && linked.length === 1) {
        cardId = bill.cardId;
      }
      if (cardId == null || !cardsById.has(cardId)) continue;
      const fee = {
        cardId, period: bill.period, currency: line.currency,
        date: line.transactionDate ?? bill.statementDate, billId: bill.id, cents: Math.round(Math.abs(amount) * 100),
      };
      if (isCharge) addCharge(fee);
      else refunds.push(fee);
    }
  }

  const charges = [...chargesByPeriod.values()];
  const matches = matchRefunds(charges, refunds);
  return charges.sort((a, b) => b.date.getTime() - a.date.getTime() || b.billId - a.billId).map((charge) => {
    const { cardId, period, currency, billId } = charge;
    const card = cardsById.get(cardId)!;
    const settlement = settlementOf(card.annualFeePolicy);
    const manualStatus = annualFeeReviewStatuses.find((status) => status === reviewsByKey.get(feeKey(charge))) ?? null;
    const refund = matches.get(charge);
    const refundCents = refund?.cents ?? 0;
    // 已申请之后，导入明确匹配到退款的账单即可自动结案。
    const status = manualStatus === 'pending' ? defaultStatus(settlement === 'none' ? null : settlement)
      : manualStatus === 'refunded' || (refundCents === charge.cents && refund && manualStatus !== 'closed') ? 'refunded'
      : manualStatus ?? defaultStatus(settlement);
    return {
      cardId, period, currency, billId,
      bankName: card.bankName,
      cardLast4: card.displayLast4 || card.cardLast4,
      amount: charge.cents / 100,
      refundAmount: refundCents / 100,
      remainingAmount: (charge.cents - refundCents) / 100,
      date: ymd(charge.date),
      settlement,
      manualStatus,
      status,
      refundDate: refund && manualStatus !== 'pending' && manualStatus !== 'closed' ? ymd(refund.date) : null,
    };
  });
}

export async function loadAnnualFeeTracking(cards?: TrackingCard[], bills?: TrackingBill[]) {
  const [cardRows, billRows, reviews] = await Promise.all([
    cards ?? prisma.card.findMany({
      where: { hidden: false },
      select: { id: true, bankName: true, cardLast4: true, displayLast4: true, annualFeePolicy: true },
    }),
    bills ?? prisma.bill.findMany({
      where: {
        OR: [{ annualFeeAmount: { gt: 0 } }, { transactions: { some: annualFeeTransactions.where } }],
      },
      select: {
        id: true, cardId: true, period: true, statementDate: true, annualFeeAmount: true, currency: true,
        cards: { select: { cardId: true } }, transactions: annualFeeTransactions,
      },
    }),
    prisma.annualFeeReview.findMany(),
  ]);
  return buildAnnualFeeTracking(cardRows, billRows, reviews);
}

export function needsAnnualFeeAction(row: ReturnType<typeof buildAnnualFeeTracking>[number]) {
  return row.status === 'apply' || row.status === 'review';
}
