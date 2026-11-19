import { z } from 'zod';
import { fromYmd, ymd } from '../../lib/dates';
import { ApiError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { detectAnnualFeeAmount } from '../../parsers/_util';
import { normalizeTransactionDate, withTransactionRetry } from '../../parsers/pipeline';
import { combineScreenshotTransactions } from './screenshot-parser';

const amountSchema = z.number().min(-99_999_999.99).max(99_999_999.99)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001, '金额最多两位小数');
export const screenshotBillSchema = z.object({
  cardId: z.number().int().positive(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  statementDate: z.iso.date(),
  dueDate: z.iso.date(),
  amount: amountSchema,
  minAmount: amountSchema.refine((amount) => amount >= 0, '最低还款额不能为负').nullable(),
  transactions: z.array(z.object({
    date: z.string().trim().regex(/^(?:\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2})$/),
    description: z.string().trim().min(1).max(512),
    amount: amountSchema,
  }).strict()).max(500),
}).strict().refine(({ statementDate, dueDate }) => statementDate <= dueDate, '还款日不能早于出账日');

type ScreenshotBill = z.infer<typeof screenshotBillSchema>;

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
    const previous = existingRows.filter((row) => row.cardId === card.id && (row.transactionDate || row.dateText))
      .map((row) => ({
        date: row.transactionDate ? ymd(row.transactionDate) : row.dateText!,
        description: row.description,
        amount: Number(row.amount),
      }));
    const additions = combineScreenshotTransactions([previous, transactions]).slice(previous.length);
    const sequenceStart = (existingRows[existingRows.length - 1]?.sequence ?? -1) + 1;
    if (additions.length) {
      await tx.billTransaction.createMany({ data: additions.map((row, index) => ({
        billId: bill.id, cardId: card.id, bankName: card.bankName, cardLast4: card.cardLast4,
        transactionDate: fromYmd(row.date), dateText: row.date, description: row.description,
        amount: row.amount, currency, sequence: sequenceStart + index, screenshot: true,
      })) });
    }
    for (const linkedCardId of new Set([cardId, card.id])) {
      await tx.billCard.upsert({
        where: { billId_cardId: { billId: bill.id, cardId: linkedCardId } },
        create: { billId: bill.id, cardId: linkedCardId },
        update: {},
      });
    }
    const allRows = [...existingRows.map((row) => ({ description: row.description, amount: Number(row.amount) })), ...additions];
    await tx.bill.update({
      where: { id: bill.id },
      data: { hasDetails: allRows.length > 0, annualFeeAmount: detectAnnualFeeAmount(allRows) },
    });
    return { id: bill.id, status: existing ? 'merged' as const : 'created' as const, duplicateTransactions: transactions.length - additions.length };
  }, { isolationLevel: 'Serializable' }));
}
