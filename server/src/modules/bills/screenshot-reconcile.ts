import type { Prisma } from '../../generated/prisma/client';
import { ymd } from '../../lib/dates';
import { screenshotTransactionKey } from './screenshot-parser';

interface TransactionIdentity {
  cardId: number | null;
  currency: string;
  transactionDate: Date | null;
  description: string;
  amount: number | Prisma.Decimal;
}

export function screenshotOverlapKey(row: TransactionIdentity): string {
  // 同一商户在 App 常显示「财付通-商户」，在邮件显示「财付通（商户）」。
  const description = row.description.normalize('NFKC').replace(/\s/g, '')
    .replace(/^(财付通|支付宝)[-–—−](.+)$/, '$1($2)');
  return `${row.cardId}:${row.currency}:${screenshotTransactionKey({
    date: row.transactionDate ? ymd(row.transactionDate) : '', description, amount: Number(row.amount),
  })}`;
}

export const unbilledScreenshotFilter = {
  billId: null, statementMailLogId: null, dailyMailLogId: null, screenshot: true,
} satisfies Prisma.BillTransactionWhereInput;

export const billedScreenshotMatchFilter = {
  OR: [
    { bill: { source: { in: ['email', 'screenshot'] } } },
    { statementMailLog: { bills: { some: { source: 'email' } } } },
  ],
} satisfies Prisma.BillTransactionWhereInput;

export async function reconcileUnbilledScreenshots(tx: Prisma.TransactionClient, incoming: TransactionIdentity[]) {
  const complete = incoming.filter((row) => row.cardId != null && row.transactionDate != null);
  if (!complete.length) return;
  const keys = new Set(complete.map(screenshotOverlapKey));
  const scope = {
    cardId: { in: [...new Set(complete.map((row) => row.cardId!))] },
    transactionDate: { in: [...new Set(complete.map((row) => row.transactionDate!.getTime()))].map((date) => new Date(date)) },
    currency: { in: [...new Set(complete.map((row) => row.currency))] },
  };
  const pending = await tx.billTransaction.findMany({ where: { ...scope, ...unbilledScreenshotFilter } });
  const matches = pending.filter((row) => keys.has(screenshotOverlapKey(row)));
  if (!matches.length) return;
  const billed = await tx.billTransaction.findMany({ where: { ...scope, ...billedScreenshotMatchFilter } });
  const counts = new Map<string, number>();
  for (const row of billed) {
    const key = screenshotOverlapKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // 未出账截图用 sequence 保存同键的笔数序号。重新同步同一份账单时不会再删掉第二笔。
  const ids = matches.filter((row) => row.sequence < (counts.get(screenshotOverlapKey(row)) ?? 0)).map((row) => row.id);
  if (ids.length) await tx.billTransaction.deleteMany({ where: { id: { in: ids }, ...unbilledScreenshotFilter } });
}
