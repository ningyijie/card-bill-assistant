import { prisma } from '../../lib/prisma';
import { ApiError } from '../../lib/errors';
import { today } from '../../lib/dates';
import { buildAnnualFeeSpendEligibility, buildSpendProgress, readSpendRules } from './card-spend-tracking';
import { unbilledScreenshotFilter } from './screenshot-reconcile';

export async function spendCard(id: number) {
  const card = await prisma.card.findUnique({
    where: { id },
    select: { id: true, hidden: true, annualFeePolicy: true, statementDay: true, businessPrimaryId: true,
      businessPrimary: { select: { statementDay: true } } },
  });
  if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');
  return card;
}

export async function spendStatementDates(cardId: number, primaryId: number | null) {
  const ids = primaryId == null ? [cardId] : [cardId, primaryId];
  const bills = await prisma.bill.findMany({
    where: { source: 'email', OR: [{ cardId: { in: ids } }, { cards: { some: { cardId: { in: ids } } } }] },
    select: { period: true, statementDate: true, cardId: true,
      cards: { where: { cardId }, select: { cardId: true } } },
    orderBy: { statementDate: 'asc' },
  });
  const byPeriod = new Map(bills.map((bill) => [bill.period, bill.statementDate]));
  for (const bill of bills) {
    if (bill.cardId === cardId || bill.cards.length > 0) byPeriod.set(bill.period, bill.statementDate);
  }
  return byPeriod;
}

export async function loadCardSpendProgress(id: number) {
  const card = await spendCard(id);
  const rules = readSpendRules(card.annualFeePolicy);
  const now = today();
  if (rules.length === 0) {
    return { tracks: [], annualFee: buildAnnualFeeSpendEligibility(card.annualFeePolicy, [], now) };
  }
  const currencyFilter = rules.some((rule) => rule.metric === 'count')
    ? {} : { currency: { in: [...new Set(rules.map((rule) => rule.currency))] } };
  const [transactions, confirmations, statementDates] = await Promise.all([
    prisma.billTransaction.findMany({
      where: { cardId: id, ...currencyFilter,
        OR: [{ billId: { not: null } }, { statementMailLog: { bills: { some: {} } } },
          ...(rules.some((rule) => rule.basis !== 'statement_month') ? [unbilledScreenshotFilter] : [])] },
      select: { amount: true, currency: true, description: true, transactionDate: true,
        bill: { select: { period: true } },
        statementMailLog: { select: { bills: { select: { period: true, currency: true } } } } },
    }),
    prisma.cardSpendConfirmation.findMany({ where: { cardId: id, ruleId: { in: rules.map((rule) => rule.id) } } }),
    rules.some((rule) => rule.basis === 'statement_month') ? spendStatementDates(id, card.businessPrimaryId) : new Map<string, Date>(),
  ]);
  const tracks = buildSpendProgress(
    rules,
    transactions.map((row) => {
      const sharedPeriods = new Set(row.statementMailLog?.bills.filter((bill) => bill.currency === row.currency).map((bill) => bill.period));
      const sharedPeriod = sharedPeriods.size === 1 ? [...sharedPeriods][0] : null;
      return { ...row, amount: Number(row.amount), statementPeriod: row.bill?.period ?? sharedPeriod };
    }),
    confirmations.map((row) => ({ ...row, amount: Number(row.amount) })),
    now, card.businessPrimary?.statementDay ?? card.statementDay, statementDates,
  );
  return { tracks, annualFee: buildAnnualFeeSpendEligibility(card.annualFeePolicy, tracks, now) };
}
