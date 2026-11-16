import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  emailAccount: { findUnique: vi.fn(), update: vi.fn() },
  bill: { findFirst: vi.fn() },
  mailLog: { findUnique: vi.fn(), create: vi.fn() },
}));
const imap = vi.hoisted(() => ({ connect: vi.fn(), getMailboxLock: vi.fn(), search: vi.fn(), fetchAll: vi.fn(), fetchOne: vi.fn(), logout: vi.fn(), close: vi.fn(), release: vi.fn() }));
const parsed = vi.hoisted(() => ({ tryParse: vi.fn(), applyParsedBills: vi.fn() }));
vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/config', () => ({ config: { encryptionKey: Buffer.alloc(32, 3) } }));
vi.mock('../src/lib/crypto', () => ({ decrypt: () => 'synthetic-password', encrypt: vi.fn() }));
vi.mock('../src/lib/card-groups', () => ({ recomputePrimary: vi.fn() }));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn(function () { return imap; }) }));
vi.mock('../src/parsers/registry', () => ({
  matchParser: (from: string) => from === 'bill@bank.test' ? { parser: { id: 'test2026', bankName: '招商银行' } } : null,
  tryParse: parsed.tryParse, getParserById: vi.fn(),
}));
vi.mock('../src/parsers/pipeline', () => ({ applyParsedBills: parsed.applyParsedBills, applyCurrentCycleTransactions: vi.fn() }));
import { dryRunParse, openAccountMailReader, syncAccount, testConnection, testMailboxes } from '../src/modules/email/email.service';
import { MAX_MAIL_SOURCE_BYTES } from '../src/modules/email/mail-source';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.emailAccount.findUnique.mockResolvedValue({ id: 1, enabled: true, lastUid: 100, imapHost: 'mail.test', imapPort: 993, tls: true, authUser: 'synthetic', authPasswordEnc: Buffer.from('test') });
  db.bill.findFirst.mockResolvedValue(null);
  db.mailLog.findUnique.mockResolvedValue(null);
  db.mailLog.create.mockResolvedValue({ id: 1 });
  imap.getMailboxLock.mockResolvedValue({ release: imap.release });
  imap.search.mockResolvedValue([101, 102]);
  imap.fetchAll.mockResolvedValue([101, 102].map(uid => ({ uid, envelope: { from: [{ address: uid === 101 ? 'bill@bank.test' : 'marketing@example.test' }], subject: '合成邮件', date: new Date('2026-09-01') } })));
  imap.fetchOne.mockResolvedValue({ size: MAX_MAIL_SOURCE_BYTES + 1, source: Buffer.from('truncated') });
  imap.logout.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('IMAP 文件夹', () => {
  const mailbox = '广发信用卡对账单';

  it('测试连接以只读方式打开指定文件夹', async () => {
    await testConnection({
      mailbox, email: 'synthetic@example.test', imapHost: 'mail.test', imapPort: 993,
      tls: true, authUser: 'synthetic', authPassword: 'test',
    });
    expect(imap.getMailboxLock).toHaveBeenCalledWith(mailbox, { readOnly: true });
  });

  it('正式同步、试解析和原文读取使用同一文件夹', async () => {
    db.emailAccount.findUnique.mockResolvedValue({
      id: 1, enabled: true, lastUid: 100, mailbox, imapHost: 'mail.test',
      imapPort: 993, tls: true, authUser: 'synthetic', authPasswordEnc: Buffer.from('test'),
    });
    imap.search.mockResolvedValue([]);
    await syncAccount(1);
    await dryRunParse(1);
    const reader = await openAccountMailReader(1);
    await reader.close();
    expect(imap.getMailboxLock.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [mailbox, { readOnly: true }]),
    );
  });

  it('一次登录逐个只读测试所有指定路径', async () => {
    const paths = ['INBOX', mailbox, '中信信用卡对账单'];
    const result = await testMailboxes({
      email: 'synthetic@example.test', imapHost: 'mail.test', imapPort: 993,
      tls: true, authUser: 'synthetic', authPassword: 'test',
    }, paths);
    expect(imap.connect).toHaveBeenCalledOnce();
    expect(imap.getMailboxLock.mock.calls).toEqual(paths.map(path => [path, { readOnly: true }]));
    expect(imap.release).toHaveBeenCalledTimes(3);
    expect(result.folders.map(folder => folder.mailbox)).toEqual(paths);
  });
});

describe('超大邮件不能阻断同步', () => {
  it('出账预读跳过超限邮件，正式同步保留错误元数据并继续后续邮件', async () => {
    expect(await syncAccount(1)).toMatchObject({ synced: 2, errors: 1, unmatched: 1 });
    expect(db.mailLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ uid: 101, status: 'error', error: expect.stringContaining('32 MiB') }) });
    expect(db.mailLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ uid: 102, status: 'unmatched' }) });
    expect(parsed.tryParse).not.toHaveBeenCalled();
    expect(parsed.applyParsedBills).not.toHaveBeenCalled();
    expect(db.emailAccount.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { lastUid: 102, lastSyncAt: expect.any(Date) } });
    expect(imap.release).toHaveBeenCalledOnce();
    expect(imap.logout).toHaveBeenCalledOnce();
    expect(JSON.stringify(db.mailLog.create.mock.calls)).not.toContain('truncated');
  });
});
