import { describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { combineScreenshotTransactions, parseScreenshotText } from '../src/modules/bills/screenshot-parser';
import { createScreenshotCapture, getScreenshotCapture, readScreenshotUpload } from '../src/modules/bills/screenshot-upload';

const recognize = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: recognize }));

describe('截图识别', () => {
  const sample = [
    '华夏银行信用卡 尾号 1083',
    '2026年11月账单',
    '账单日 2026年11月19日',
    '最后还款日',
    '2026-12-08',
    '本期应还金额 人民币 1,203.85',
    '最低还款额 56.80',
    '2026-11-14 超市消费 123.85',
    '11/15 商户返还 -52.10',
  ].join('\n');

  it('识别汇总和明细，保留退款金额的符号', () => {
    expect(parseScreenshotText(sample)).toEqual({
      fields: {
        tail: '1083', period: '2026-11', statementDate: '2026-11-19', dueDate: '2026-12-08',
        currency: 'CNY', amount: 1203.85, minAmount: 56.8,
      },
      transactions: [
        { date: '2026-11-14', description: '超市消费', amount: 123.85 },
        { date: '11-15', description: '商户返还', amount: -52.1 },
      ],
    });
  });

  it('字段互相矛盾时留给用户填写，不把不同币种猜成一张账单', () => {
    const result = parseScreenshotText('人民币 本期应还金额 88.01\n美元 本期应还金额 12.20\n账单日 2026-02-30');
    expect(result.fields).toMatchObject({ currency: undefined, amount: undefined, statementDate: undefined });
  });

  it('有明确账单年月时，补全截图中只写月日的跨年还款日', () => {
    const result = parseScreenshotText('2026年12月账单\n账单日 12月19日\n最后还款日 1月7日\n本期应还金额（人民币） 12.34');
    expect(result.fields).toMatchObject({ statementDate: '2026-12-19', dueDate: '2027-01-07', amount: 12.34 });
  });

  it('识别未出账 App 的两行式交易，保留每笔卡尾和负号，略过未拍全的一笔', () => {
    const result = parseScreenshotText([
      '我的账单', '未 出 账单 已 出 账单',
      '财 付 通 - 商 户 11.25', '2026–11–19 尾 号 1111',
      '财 付 通 - 商 户 −2.30', '2026-11-18 尾 号 2222',
      '2026-11-17 示例商户 5.20 尾号 2222',
      '未拍全商户 0.99',
    ].join('\n'));
    expect(result.unbilled).toBe(true);
    expect(result.fields).toMatchObject({ statementDate: undefined, dueDate: undefined, tail: undefined });
    expect(result.transactions).toEqual([
      { date: '2026-11-19', description: '财付通 - 商户', amount: 11.25, tail: '1111' },
      { date: '2026-11-18', description: '财付通 - 商户', amount: -2.30, tail: '2222' },
      { date: '2026-11-17', description: '示例商户', amount: 5.20, tail: '2222' },
    ]);
  });

  it('千位逗号被 OCR 读成点时按完整金额识别，无法判断时不截取金额前缀', () => {
    expect(parseScreenshotText('本期应还金额 人民币 1.203.85').fields.amount).toBe(1203.85);
    expect(parseScreenshotText('本期应还金额 人民币 1.20.85').fields.amount).toBeUndefined();
  });

  it('重叠截图不重复计数，保留同页中的相同交易和不同商户的同额交易', () => {
    const cafe = { date: '2026-11-14', description: '咖啡 店', amount: 10 };
    const store = { ...cafe, description: '便利店' };
    expect(combineScreenshotTransactions([[cafe, cafe], [{ ...cafe, description: '咖啡店' }, store]])).toEqual([cafe, cafe, store]);
  });

  it('网页多选上传保留同一个请求里的所有图片', async () => {
    const form = new FormData();
    form.append('images', new Blob(['first']), 'a.png');
    form.append('images', new Blob(['second']), 'b.jpg');
    const request = new Request('http://localhost', { method: 'POST', body: form });
    const files = await readScreenshotUpload(request.headers.get('Content-Type')!, Buffer.from(await request.arrayBuffer()));
    expect(files.map((file) => [file.name, file.data.toString()])).toEqual([['a.png', 'first'], ['b.jpg', 'second']]);
  });

  it('一次读取快捷指令 ZIP，跳过完全相同的图，个别失败不阻塞，批次按账号隔离', async () => {
    recognize.mockImplementation((_bin, _args, _options, done) => ({
      stdin: { on: () => undefined, end: () => queueMicrotask(() => done(null, sample)) },
    }));
    const pngHeader = Buffer.from('89504e470d0a1a0a0000000d494844520000000a0000000a', 'hex');
    const zip = new ZipFile();
    zip.addBuffer(pngHeader, 'overview.png');
    zip.addBuffer(pngHeader, 'duplicate.png');
    zip.addBuffer(Buffer.from('invalid'), 'damaged.png');
    const chunks: Buffer[] = [];
    zip.end();
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    const files = await readScreenshotUpload('application/zip', Buffer.concat(chunks));
    const id = createScreenshotCapture(7, files);
    expect(() => getScreenshotCapture(8, id)).toThrow();
    await vi.waitFor(() => expect(getScreenshotCapture(7, id).status).toBe('ready'));
    expect(getScreenshotCapture(7, id).pages).toMatchObject([
      { index: 1, fields: { amount: 1203.85 } },
      { index: 2, duplicateOf: 1 },
      { index: 3, error: '请使用 PNG 或 JPEG 截图' },
    ]);
    expect(recognize).toHaveBeenCalledTimes(1);
  });
});
