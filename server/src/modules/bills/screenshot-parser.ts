import { fromYmd, ymd } from '../../lib/dates';

export interface ScreenshotTransaction {
  date: string;
  description: string;
  amount: number;
}

export interface ScreenshotFields {
  bankName?: string;
  tail?: string;
  period?: string;
  statementDate?: string;
  dueDate?: string;
  amount?: number;
  minAmount?: number;
  currency?: string;
}

const datePattern = String.raw`(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?`;
// OCR 偶尔把千位逗号识别成小数点。只接受完整数字，末尾的分隔符才是小数点。
const moneyPattern = String.raw`([-+−]?\s*(?:[¥￥$]\s*)?(?:\d{1,3}(?:\s*[.,]\s*\d{3})+|\d+)\s*[.,]\s*\d{2})(?![\d.,]|\s*[.,]\s*\d)`;
const shortDatePattern = String.raw`(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?!\d|\s*[-/.年月])\s*日?`;

function dateValue(value?: string): string | undefined {
  const m = value?.match(new RegExp(datePattern));
  if (!m) return undefined;
  const result = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return Number.isFinite(fromYmd(result).getTime()) && ymd(fromYmd(result)) === result ? result : undefined;
}

function moneyValue(value: string): number {
  const numberText = value.replace(/−/g, '-').replace(/[¥￥$\s]/g, '');
  const point = Math.max(numberText.lastIndexOf('.'), numberText.lastIndexOf(','));
  return Number(numberText.slice(0, point).replace(/[.,]/g, '') + '.' + numberText.slice(point + 1));
}

function unique<T>(values: (T | undefined)[]): T | undefined {
  const found = [...new Set(values.filter((item): item is T => item !== undefined))];
  return found.length === 1 ? found[0] : undefined;
}

export function parseScreenshotText(raw: string, bankNames: readonly string[] = []): {
  fields: ScreenshotFields; transactions: ScreenshotTransaction[];
} {
  const text = raw.normalize('NFKC').replace(/([\p{Script=Han}])[^\S\n]+(?=[\p{Script=Han}])/gu, '$1');
  const afterLabel = (label: string, expression: string) =>
    new RegExp(`(?:${label})[：:\\s]{0,12}(${expression})`, 'gi');
  const dateAfter = (label: string) =>
    unique([...text.matchAll(afterLabel(label, datePattern))].map((match) => dateValue(match[1])));
  const shortDateAfter = (label: string, year: number, after?: string) => unique(
    [...text.matchAll(afterLabel(label, shortDatePattern))].map((match) => {
      const date = dateValue(`${year}-${match[2]}-${match[3]}`);
      return date && after && date < after ? dateValue(`${year + 1}-${match[2]}-${match[3]}`) : date;
    }),
  );
  const amountAfter = (label: string) =>
    unique([...text.matchAll(afterLabel(label, `(?:\\(?(?:CNY|RMB|USD|HKD|人民币|美元|港币)\\)?)?\\s*${moneyPattern}`))]
      .map((match) => moneyValue(match[2])).filter(Number.isFinite));
  const explicitPeriod = unique(
    [...text.matchAll(/(20\d{2})\s*年\s*(1[0-2]|0?[1-9])\s*月(?:份)?(?:信用卡)?(?:电子)?账单/g)]
      .map((match) => `${match[1]}-${match[2].padStart(2, '0')}`),
  );
  const statementLabel = '出账日(?:期)?|账单日(?:期)?|statement date';
  const projectedStatement = explicitPeriod && shortDateAfter(statementLabel, Number(explicitPeriod.slice(0, 4)));
  const statementDate = dateAfter(statementLabel)
    ?? (projectedStatement?.slice(0, 7) === explicitPeriod ? projectedStatement : undefined);
  const period = statementDate?.slice(0, 7) ?? explicitPeriod;
  const dueLabel = '最后还款日(?:期)?|到期还款日(?:期)?|最迟还款日(?:期)?|还款截止日(?:期)?|还款日(?:期)?|(?:payment )?due date';
  const projectedDue = statementDate && shortDateAfter(dueLabel, Number(statementDate.slice(0, 4)), statementDate);
  const dueDate = dateAfter(dueLabel) ?? (projectedDue && statementDate &&
    fromYmd(projectedDue).getTime() - fromYmd(statementDate).getTime() <= 90 * 86400_000 ? projectedDue : undefined);
  const tail = unique([...text.matchAll(/(?:尾号|卡片尾号|卡号后[四4]位|后[四4]位|[*•·]{2,})[\s:(]{0,8}(\d{4})(?!\d)/g)].map((match) => match[1]));
  const heading = text.split('\n', 5).join('\n');
  const bankName = unique(bankNames.filter((name) => heading.includes(name)));
  const currencies = [
    ['CNY', /人民币|\b(?:CNY|RMB)\b|¥/i],
    ['USD', /美元|\bUSD\b|US\$/i],
    ['HKD', /港[币元]|\bHKD\b|HK\$/i],
    ['JPY', /日[元圆]|\bJPY\b/i],
    ['EUR', /欧元|\bEUR\b|€/i],
    ['GBP', /英镑|\bGBP\b|£/i],
  ] as const;
  const currency = unique(currencies.filter(([, pattern]) => pattern.test(text)).map(([code]) => code));
  const transactions: ScreenshotTransaction[] = [];
  const transactionLine = new RegExp(`^\\s*(${datePattern}|(?:0?[1-9]|1[0-2])[-/.](?:[0-2]?\\d|3[01]))\\s+(.+?)\\s+${moneyPattern}\\s*(?:CNY|RMB|USD|HKD|元)?\\s*$`, 'i');
  for (const line of text.split('\n')) {
    const m = line.match(transactionLine);
    if (!m || /还款日|账单日|出账日|到期日|应还金额|最低还款/.test(m[5])) continue;
    const date = dateValue(m[1]) ?? m[1].replace(/[/.]/g, '-');
    const amount = moneyValue(m[6]);
    if (Number.isFinite(amount) && m[5].trim()) transactions.push({ date, description: m[5].trim().slice(0, 512), amount });
    if (transactions.length >= 200) break;
  }
  return {
    fields: {
      bankName, tail, period, statementDate, currency, dueDate,
      amount: amountAfter('本期应还(?:总额|金额|款项)?|本期账单金额|应还总额|(?<!最低)应还金额|账单总额|Total Amount Due|(?<!Minimum )Amount Due'),
      minAmount: amountAfter('最低还款(?:金额|额)?|Minimum (?:Payment|Amount Due)'),
    },
    transactions,
  };
}

export function screenshotTransactionKey(transaction: ScreenshotTransaction): string {
  return JSON.stringify([
    transaction.date,
    transaction.description.normalize('NFKC').replace(/\s/g, '').toLowerCase(),
    Math.round(transaction.amount * 100),
  ]);
}

/** 不因日期和金额偶然相同而跨商户去重；同页出现的重复笔数完整保留。 */
export function combineScreenshotTransactions(pages: ScreenshotTransaction[][]): ScreenshotTransaction[] {
  const result: ScreenshotTransaction[] = [];
  const counts = new Map<string, number>();
  for (const page of pages) {
    const pageCounts = new Map<string, number>();
    for (const row of page) {
      const key = screenshotTransactionKey(row);
      const count = (pageCounts.get(key) ?? 0) + 1;
      pageCounts.set(key, count);
      if (count <= (counts.get(key) ?? 0)) continue;
      counts.set(key, count);
      result.push(row);
    }
  }
  return result;
}
