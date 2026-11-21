import { describe, expect, it } from 'vitest';
import { fromYmd } from '../src/lib/dates';
import { matchParser, tryParse } from '../src/parsers/registry';

// 根据邮件截图重建模板，账单数据均为合成示例。
const subject = '浙商银行信用卡电子账单';
const sender = '95527@message.czbank.com';
const html = `
  <p>尊敬的浙商银行信用卡持卡人：</p>
  <p>尊敬的 张小明 先生：</p>
  <table>
    <tr><td colspan="4">账户信息</td></tr>
    <tr><td>信用额度<br>Credit Limit</td><td>最低还款额<br>Min.Payment</td><td>账单日<br>Statement Date</td><td>到期还款日<br>Payment Due Date</td></tr>
    <tr><td>20000</td><td>62.25</td><td>20260201</td><td>20260218</td></tr>
  </table>
  <table>
    <tr><td colspan="7">账单信息</td></tr>
    <tr><td>本期应还金额<br>New Balance</td><td>=</td><td>上期账单金额<br>Balance B/F</td><td>−</td><td>上期还款金额<br>Payment</td><td>+</td><td>本期新增账款<br>New Charges</td></tr>
    <tr><td><font>&yen;&nbsp;1,245.00</font></td><td>=</td><td>￥800.00</td><td>−</td><td>￥800.00</td><td>+</td><td>￥1,245.00</td></tr>
    <tr><td colspan="7">账单说明：+号表示支出，-号表示还款。</td></tr>
  </table>
  <table>
    <tr><td>交易日<br>Trans Date</td><td>记账日<br>Post Date</td><td>交易摘要<br>Description</td><td>交易金额<br>Trans Amount</td><td>卡号末四位<br>Card Number</td></tr>
    <tr><td>20260103</td><td>20260104</td><td>示例超市</td><td>&yen; +100.00</td><td>4321</td></tr>
    <tr><td>20260107</td><td>20260107</td><td>网银还款</td><td>&yen; -800.00</td><td>9876</td></tr>
    <tr><td>20260109</td><td>20260110</td><td>年费</td><td>￥500.00</td><td>9876</td></tr>
    <tr><td>20260111</td><td>20260112</td><td>积分抵扣年费</td><td>-&yen;200.00</td><td>9876</td></tr>
    <tr><td colspan="5">&nbsp;</td></tr>
  </table>`;
const mail = { from: sender, subject, html, date: new Date('2026-02-02T06:00:00+08:00') };

describe('浙商银行邮件账单', () => {
  it('匹配账单邮件，并用正文表格导入一份应还金额和分卡交易', () => {
    expect(matchParser(sender, subject)?.parser.id).toBe('czbank2026');
    expect(tryParse({ ...mail, text: '另外提供的邮件摘要无交易表格' })).toMatchObject({
      matched: true,
      parserId: 'czbank2026',
      bills: [{
        bankName: '浙商银行',
        amount: 1245,
        minAmount: 62.25,
        currency: 'CNY',
        statementDate: fromYmd('2026-02-01'),
        dueDate: fromYmd('2026-02-18'),
        holderName: '张小明',
        period: '2026-02',
        cardLast4s: ['4321', '9876'],
        transactions: [
          { date: '20260103', description: '示例超市', amount: 100, cardLast4: '4321' },
          { date: '20260107', description: '网银还款', amount: -800, cardLast4: '9876' },
          { date: '20260109', description: '年费', amount: 500, cardLast4: '9876' },
          { date: '20260111', description: '积分抵扣年费', amount: -200, cardLast4: '9876' },
        ],
      }],
    });
  });

  it('保留溢缴款金额和零最低还款额', () => {
    const credit = html.replace('1,245.00', '−45.80').replace('62.25', '0.00');
    expect(tryParse({ ...mail, html: credit })).toMatchObject({
      bills: [{ amount: -45.8, minAmount: 0 }],
    });
  });

  it('忽略其他发件人或非账单标题，指定解析器也拒绝假后缀发件人', () => {
    expect(matchParser('shop@example.test', subject)).toBeNull();
    expect(matchParser(sender, '浙商银行信用卡活动通知')).toBeNull();
    expect(tryParse({ ...mail, from: `${sender}.example.test` }, 'czbank2026')).toMatchObject({ bills: [] });
  });

  it('拒绝缺字段和外币摘要，避免把部分数据导入为完整人民币账单', () => {
    const missingTail = html.replace('<td>9876</td>', '<td></td>');
    expect(tryParse({ ...mail, html: missingTail })).toMatchObject({ bills: [], error: expect.stringContaining('未完整读取') });
    expect(tryParse({ ...mail, html: html.replace('&yen;&nbsp;1,245.00', 'USD 1,245.00') })).toMatchObject({ bills: [] });
  });
});
