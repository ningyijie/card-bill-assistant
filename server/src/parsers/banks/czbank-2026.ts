import type { BankParser, ParsedTransaction } from '../types';
import { applyTransactionTails, buildBill, parseAmount, parseDate, pickHolder, UNKNOWN_CARD_TAIL } from '../_util';
import { statementTable } from '../statement-rows';

const bankName = '浙商银行';
const sender = '95527@message.czbank.com';
const subject = /^浙商银行信用卡\s*电子对?账单$/;
const compactDate = /^\d{8}$/;

function yuanAmount(raw: string): number | null {
  const value = raw.replace(/\s/g, '').replace(/−/g, '-');
  const match = /^(?:([+-]?)[￥¥]?|[￥¥]([+-]))(\d+(?:[,，]\d{3})*(?:\.\d{2})?)$/.exec(value);
  if (!match) return null;
  return parseAmount(`${match[1] === '-' || match[2] === '-' ? '-' : ''}${match[3]}`);
}

export const czbank2026Parser: BankParser = {
  id: 'czbank2026',
  bankName,
  senderPatterns: [sender],
  subjectPatterns: [subject],
  requireSender: true,

  parse(mail) {
    // 当前样本为人民币 HTML 正文账单。指定解析器时也校验真实发件地址和主题。
    if (!mail.html || mail.from.split(',')[0]?.trim().toLowerCase() !== sender || !subject.test(mail.subject)) return [];
    const { rows, text } = statementTable(mail.html);
    const accountHeader = rows.findIndex(({ cells }) =>
      ['信用额度', '最低还款额', '账单日', '到期还款日'].every((label, index) => cells[index]?.startsWith(label)));
    const balanceHeader = rows.findIndex(({ cells }) =>
      cells[0]?.startsWith('本期应还金额') && cells.some((cell) => cell.includes('上期账单金额')));
    const detailHeader = rows.findIndex(({ cells }) =>
      ['交易日', '记账日', '交易摘要', '交易金额', '卡号末四位'].every((label, index) => cells[index]?.startsWith(label)));
    if (accountHeader < 0 || balanceHeader <= accountHeader || detailHeader <= balanceHeader) return [];

    const account = rows.slice(accountHeader + 1, balanceHeader)
      .map(({ cells }) => cells)
      .find((cells) => compactDate.test(cells[2]) && compactDate.test(cells[3]));
    if (!account) return [];
    const minAmount = yuanAmount(account[1]);
    const statementDate = parseDate(account[2]);
    const dueDate = parseDate(account[3]);

    // 摘要以「本期应还金额 = 上期账单金额 − 上期还款金额 + …」展示。
    // 只取等号左侧，避免将上期金额或交易加总误作本期应还。
    const balances = rows.slice(balanceHeader + 1, detailHeader).flatMap(({ cells }) => {
      const [current, equation] = cells.join(' ').split(/[=＝]/, 2);
      const amount = equation && /[￥¥]/.test(current) ? yuanAmount(current) : null;
      return amount == null ? [] : [amount];
    });
    if (balances.length !== 1 || minAmount == null || !statementDate || !dueDate) return [];

    const salutation = text.match(/尊敬的\s*[\p{Script=Han}·*]{2,10}\s*(?:先生|女士)/u)?.[0];
    const bill = buildBill({
      bankName,
      cardLast4: UNKNOWN_CARD_TAIL,
      holderName: salutation ? pickHolder(salutation) : null,
      amount: balances[0]!,
      minAmount,
      currency: 'CNY',
      statementDate,
      dueDate,
    });
    if (!bill) return [];

    const transactions: ParsedTransaction[] = [];
    for (const { cells } of rows.slice(detailHeader + 1)) {
      const [date, postingDate, description, amountText, tail] = cells;
      if (!compactDate.test(date) && !compactDate.test(postingDate)) continue;
      const amount = yuanAmount(amountText ?? '');
      if (!compactDate.test(date) || !compactDate.test(postingDate) || !parseDate(date) || !parseDate(postingDate)
        || !description || amount == null || !/^\d{4}$/.test(tail)) {
        throw new Error('浙商银行交易表存在未完整读取的记录');
      }
      transactions.push({ date, description, amount, currency: 'CNY', cardLast4: tail === '0000' ? null : tail });
    }
    // 截图只有一份应还总额，交易卡尾用于合账及明细归属。邮件没有标注银行主副卡关系。
    applyTransactionTails(bill, transactions);
    return [bill];
  },
};
