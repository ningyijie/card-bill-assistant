import { z } from 'zod';
import { fromYmd, ymd } from '../../lib/dates';
import { ApiError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { detectAnnualFeeAmount } from '../../parsers/_util';
import { normalizeTransactionDate, withTransactionRetry } from '../../parsers/pipeline';
import { combineScreenshotTransactions } from './screenshot-parser';
import { billedScreenshotMatchFilter, reconcileUnbilledScreenshots, screenshotOverlapKey, unbilledScreenshotFilter } from './screenshot-reconcile';

const amountSchema = z.number().min(-99_999_999.99).max(99_999_999.99)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001, '金额最多两位小数');
const cardIdSchema = z.number().int().positive();
const currencySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const transactionFields = { description: z.string().trim().min(1).max(512), amount: amountSchema };

export const screenshotBillSchema = z.object({
  cardId: cardIdSchema,
  currency: currencySchema,
  statementDate: z.iso.date(),
  dueDate: z.iso.date(),
  amount: amountSchema,
  minAmount: amountSchema.refine((amount) => amount >= 0, '最低还款额不能为负').nullable(),
  transactions: z.array(z.object({
    date: z.string().trim().regex(/^(?:\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2})$/),
    ...transactionFields,
    cardId: cardIdSchema.optional(),
  }).strict()).max(500),
}).strict().refine(({ statementDate, dueDate }) => statementDate <= dueDate, '还款日不能早于出账日');

type ScreenshotBill = z.infer<typeof screenshotBillSchema>;

export const unbilledScreenshotSchema = z.strictObject({
  currency: currencySchema,
  transactions: z.array(z.strictObject({ ...transactionFields, date: z.iso.date(), cardId: cardIdSchema })).min(1).max(500),
});

/** 截图暂存交易与正式账单共用交易查询。没有账单日期，也不创建还款记录。 */
export async function saveUnbilledScreenshot(input: z.infer<typeof unbilledScreenshotSchema>) {
  const { currency } = input;
  const rows = input.transactions.map(({ date, ...row }) => ({ ...row, transactionDate: fromYmd(date), dateText: date, currency }));
  const cardIds = [...new Set(rows.map((row) => row.cardId))];
  return withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const cards = await tx.card.findMany({ where: { id: { in: cardIds }, hidden: false },
      select: { id: true, cardLast4: true, bankName: true } });
    if (cards.length !== cardIds.length) throw new ApiError(404, '有交易未找到对应的卡片');
    const byId = new Map(cards.map((card) => [card.id, card]));
    const previous = await tx.billTransaction.findMany({
      where: {
        cardId: { in: cardIds }, currency,
        transactionDate: { in: [...new Set(rows.map((row) => row.dateText))].map(fromYmd) },
        OR: [unbilledScreenshotFilter, ...billedScreenshotMatchFilter.OR],
      },
      select: { billId: true, statementMailLogId: true, cardId: true, currency: true, transactionDate: true,
        description: true, amount: true, sequence: true },
    });
    const pending = new Map<string, number>();
    const billed = new Map<string, number>();
    for (const row of previous) {
      const key = screenshotOverlapKey(row);
      if (row.billId == null && row.statementMailLogId == null) {
        pending.set(key, Math.max(pending.get(key) ?? 0, row.sequence + 1));
      } else billed.set(key, (billed.get(key) ?? 0) + 1);
    }
    const occurrences = new Map<string, number>();
    const additions = rows.flatMap((row) => {
      const key = screenshotOverlapKey(row);
      const sequence = occurrences.get(key) ?? 0;
      occurrences.set(key, sequence + 1);
      if (sequence < Math.max(billed.get(key) ?? 0, pending.get(key) ?? 0)) return [];
      const card = byId.get(row.cardId)!;
      return [{ ...row, sequence, screenshot: true, bankName: card.bankName, cardLast4: card.cardLast4 }];
    });
    if (additions.length) await tx.billTransaction.createMany({ data: additions });
    return { added: additions.length, duplicates: rows.length - additions.length };
  }, { isolationLevel: 'Serializable' }));
}

export async function saveScreenshotBill(input: ScreenshotBill) {
  const statementDate = fromYmd(input.statementDate);
  const period = input.statementDate.slice(0, 7);
  const dueDate = fromYmd(input.dueDate);
  const { currency } = input;
  const transactions = input.transactions.map((row) => {
    const date = normalizeTransactionDate(row.date, statementDate);
    if (!date || (row.date.length === 10 && ymd(date) !== row.date)) {
      throw new ApiError(400, '有交易日期无法确认，请填写 YYYY-MM-DD');
    }
    if (date > statementDate) throw new ApiError(400, '交易日期不能晚于出账日');
    return { ...row, date: ymd(date) };
  });

  return withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const card = await tx.card.findUnique({
      where: { id: input.cardId },
      select: { id: true, hidden: true, cardLast4: true, bankName: true, businessPrimaryId: true },
    });
    if (!card || card.hidden) throw new ApiError(404, '未找到该卡片');
    const transactionCardIds = [...new Set(transactions.map((row) => row.cardId ?? card.id))];
    const otherIds = transactionCardIds.filter((id) => id !== card.id);
    const otherCards = otherIds.length ? await tx.card.findMany({
      where: { id: { in: otherIds }, bankName: card.bankName, hidden: false }, select: { id: true, cardLast4: true },
    }) : [];
    if (otherCards.length !== otherIds.length) throw new ApiError(400, '合并账单的明细须选择同一家银行的卡片');
    const cardById = new Map([card, ...otherCards].map((row) => [row.id, row]));
    const cardId = card.businessPrimaryId ?? card.id;
    const exact = { cardId, period, currency };
    const latest = await tx.bill.findFirst({
      where: {
        period, currency, source: 'email',
        OR: [{ cardId }, { cardId: card.id }, { cards: { some: { cardId: card.id } } }],
      },
      select: { id: true },
    });
    if (latest) return { id: latest.id, status: 'official' as const };

    const existing = await tx.bill.findUnique({
      where: { cardId_period_currency: exact }, select: { id: true, source: true },
    });
    const amounts = { statementDate, dueDate, amount: input.amount, minAmount: input.minAmount, source: 'screenshot' };
    const payment = input.amount <= 0
      ? { paidStatus: 'paid', paidAmount: 0, paidAt: dueDate }
      : { paidStatus: 'unpaid', paidAmount: null, paidAt: null };
    const bill = await tx.bill.upsert({
      where: { cardId_period_currency: exact },
      create: { ...exact, ...amounts, ...payment },
      update: { ...amounts, ...(existing?.source === 'auto-none' ? payment : {}) },
      select: { id: true },
    });
    const existingRows = await tx.billTransaction.findMany({
      where: { billId: bill.id },
      orderBy: { sequence: 'asc' },
      select: { cardId: true, transactionDate: true, dateText: true, description: true, amount: true, sequence: true },
    });
    const additions = transactionCardIds.flatMap((id) => {
      const previous = existingRows.filter((row) => row.cardId === id && (row.transactionDate || row.dateText))
        .map((row) => ({ date: row.transactionDate ? ymd(row.transactionDate) : row.dateText!,
          description: row.description, amount: Number(row.amount) }));
      return combineScreenshotTransactions([previous, transactions.filter((row) => (row.cardId ?? card.id) === id)])
        .slice(previous.length).map((row) => ({ ...row, cardId: id }));
    });
    const sequenceStart = (existingRows[existingRows.length - 1]?.sequence ?? -1) + 1;
    if (additions.length) {
      await tx.billTransaction.createMany({ data: additions.map((row, index) => ({
        billId: bill.id, cardId: row.cardId, bankName: card.bankName, cardLast4: cardById.get(row.cardId)!.cardLast4,
        transactionDate: fromYmd(row.date), dateText: row.date, description: row.description,
        amount: row.amount, currency, sequence: sequenceStart + index, screenshot: true,
      })) });
    }
    for (const linkedCardId of new Set([cardId, card.id, ...transactionCardIds])) {
      await tx.billCard.upsert({
        where: { billId_cardId: { billId: bill.id, cardId: linkedCardId } },
        create: { billId: bill.id, cardId: linkedCardId },
        update: {},
      });
    }
    if (additions.length) await reconcileUnbilledScreenshots(tx, additions.map((row) => ({
      ...row, transactionDate: fromYmd(row.date), currency,
    })));
    const allRows = [...existingRows.map((row) => ({ description: row.description, amount: Number(row.amount) })), ...additions];
    await tx.bill.update({
      where: { id: bill.id },
      data: { hasDetails: allRows.length > 0, annualFeeAmount: detectAnnualFeeAmount(allRows) },
    });
    return { id: bill.id, status: existing ? 'merged' as const : 'created' as const, duplicateTransactions: transactions.length - additions.length };
  }, { isolationLevel: 'Serializable' }));
}
