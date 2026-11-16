import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';
import {
  encryptAuthPassword,
  syncAccount,
  testConnection,
  testMailboxes,
  dryRunParse,
  fetchMailBody,
  resyncAccount,
  getHistorySyncState,
  startHistorySync,
  type EmailAccountParams,
} from '../modules/email/email.service';
import { listParsers } from '../parsers/registry';
import { config } from '../config';
import { decrypt } from '../lib/crypto';

const router = Router();
router.use(requireAuth);

const mailboxSchema = z.string().trim().min(1, '请输入 IMAP 文件夹路径').max(191)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), '文件夹路径不能包含控制字符')
  .transform(value => /^inbox$/i.test(value) ? 'INBOX' : value);

const mailboxPathsSchema = z.string().max(4000)
  .transform(value => value.split(/\r?\n/).map(path => path.trim()).filter(Boolean))
  .pipe(z.array(mailboxSchema).max(20, '一次最多添加 20 个文件夹'))
  .transform(paths => Array.from(new Set(paths)));

const accountSchema = z.object({
  email: z.string().trim().email('邮箱地址格式错误'),
  mailbox: mailboxSchema.default('INBOX'),
  imapHost: z.string().trim().min(1, 'IMAP 服务器不能为空'),
  imapPort: z.number().int().min(1).max(65535).default(993),
  tls: z.boolean().default(true),
  authUser: z.string().trim().min(1, '登录账号不能为空'),
  authPassword: z.string().min(1, '授权码不能为空'),
});
// 编辑只处理实际提交的字段。可选字段内的默认值仍会生效，不能直接 partial 后重置旧连接参数。
const accountUpdateSchema = accountSchema.partial().extend({
  mailbox: mailboxSchema.optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  tls: z.boolean().optional(),
});

// ===== 邮箱账户 CRUD =====

router.get(
  '/accounts',
  asyncHandler(async (_req, res) => {
    const accounts = await prisma.emailAccount.findMany({ orderBy: { id: 'asc' } });
    res.json(
      accounts.map((a) => ({
        id: a.id,
        email: a.email,
        mailbox: a.mailbox,
        imapHost: a.imapHost,
        imapPort: a.imapPort,
        tls: a.tls,
        authUser: a.authUser,
        enabled: a.enabled,
        lastUid: a.lastUid,
        lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
        syncDaysBack: a.syncDaysBack,
      })),
    );
  }),
);

// 新增（可选 ?test=1 先测试连接再落库）
router.post(
  '/accounts',
  asyncHandler(async (req, res) => {
    const { mailboxes, authPassword, ...input } = accountSchema.extend({ mailboxes: mailboxPathsSchema.optional() }).parse(req.body);
    const paths = mailboxes?.length ? mailboxes : [input.mailbox];
    if (req.query.test === '1' || mailboxes?.length) await testMailboxes({ ...input, authPassword }, paths);
    const ids = await prisma.$transaction(async tx => {
      const exists = await tx.emailAccount.findFirst({ where: { email: input.email, mailbox: { in: paths } } });
      if (exists) throw new ApiError(409, `该邮箱已配置文件夹「${exists.mailbox}」`);
      const created = [];
      const authPasswordEnc = encryptAuthPassword(authPassword);
      for (const mailbox of paths) {
        created.push((await tx.emailAccount.create({ data: { ...input, mailbox, authPasswordEnc } })).id);
      }
      return created;
    }, { isolationLevel: 'Serializable' });
    res.status(201).json({ id: ids[0], ids });
  }),
);

// 更新（authPassword 可选；syncDaysBack / enabled 可改）
// 多邮箱设置与单邮箱编辑共用同一字段校验、IMAP 验证和授权码加密；不启动任何迁移。
router.put('/accounts/configurations', asyncHandler(async (req, res) => {
  const { accounts } = z.object({ accounts: z.array(accountUpdateSchema.extend({ id: z.number().int().positive() })).min(1)
    .refine(rows => new Set(rows.map(row => row.id)).size === rows.length, '邮箱配置重复') }).parse(req.body);
  const existing = await prisma.emailAccount.findMany({ where: { id: { in: accounts.map(row => row.id) } } });
  if (existing.length !== accounts.length) throw new ApiError(409, '邮箱账户已变化，请刷新后重新设置');
  const prepared = accounts.map(input => {
    const account = existing.find(row => row.id === input.id)!;
    if (input.mailbox !== undefined && input.mailbox !== account.mailbox) {
      throw new ApiError(400, '请为其他文件夹新增同步配置');
    }
    return { id: input.id, params: {
      mailbox: account.mailbox,
      email: input.email ?? account.email, imapHost: input.imapHost ?? account.imapHost,
      imapPort: input.imapPort ?? account.imapPort, tls: input.tls ?? account.tls,
      authUser: input.authUser ?? account.authUser,
      authPassword: input.authPassword ?? decrypt(config.encryptionKey, Buffer.from(account.authPasswordEnc)),
    } };
  });
  const tested = await Promise.allSettled(prepared.map(row => testConnection(row.params)));
  const failed = prepared.filter((_row, i) => tested[i].status === 'rejected');
  if (failed.length) throw new ApiError(400, `以下邮箱无法连接：${failed.map(row => row.params.email).join('、')}。请检查连接信息及授权码。`);
  // 所有邮箱均验证通过才原子保存；任一项失败时保留原配置，授权码不返回前端。
  await prisma.$transaction(async tx => {
    for (const { id, params } of prepared) {
      const { authPassword, ...fields } = params;
      await tx.emailAccount.update({ where: { id }, data: { ...fields, authPasswordEnc: encryptAuthPassword(authPassword) } });
    }
  });
  res.json({ ok: true });
}));

router.put(
  '/accounts/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const account = await prisma.emailAccount.findUnique({ where: { id } });
    if (!account) throw new ApiError(404, '邮箱账户不存在');
    const { mailboxes, ...input } = accountUpdateSchema.extend({ mailboxes: mailboxPathsSchema.optional() }).parse(req.body);

    if (input.mailbox !== undefined && input.mailbox !== account.mailbox) {
      throw new ApiError(400, '请为其他文件夹新增同步配置');
    }
    if (input.email && input.email !== account.email) {
      const dup = await prisma.emailAccount.findFirst({ where: { email: input.email, mailbox: account.mailbox } });
      if (dup) throw new ApiError(409, '该邮箱已被其他账户使用');
    }
    const connection = {
      email: input.email ?? account.email,
      imapHost: input.imapHost ?? account.imapHost,
      imapPort: input.imapPort ?? account.imapPort,
      tls: input.tls ?? account.tls,
      authUser: input.authUser ?? account.authUser,
    };
    const paths = (mailboxes ?? []).filter(path => path !== account.mailbox);
    if (paths.length && !input.authPassword && (
      connection.imapHost !== account.imapHost || connection.imapPort !== account.imapPort ||
      connection.tls !== account.tls || connection.authUser !== account.authUser
    )) throw new ApiError(400, '连接信息已变更，请输入授权码');
    const authPassword = input.authPassword ?? (paths.length
      ? decrypt(config.encryptionKey, Buffer.from(account.authPasswordEnc))
      : undefined);
    if (paths.length && authPassword) await testMailboxes({ ...connection, authPassword }, paths);
    await prisma.$transaction(async tx => {
      await tx.emailAccount.update({
        where: { id },
        data: {
          ...connection,
          ...(input.authPassword !== undefined ? { authPasswordEnc: encryptAuthPassword(input.authPassword) } : {}),
        },
      });
      if (paths.length) {
        const existing = await tx.emailAccount.findMany({
          where: { email: connection.email, mailbox: { in: paths } },
          select: { mailbox: true },
        });
        const missing = paths.filter(mailbox => !existing.some(row => row.mailbox === mailbox));
        if (missing.length) await tx.emailAccount.createMany({
          data: missing.map(mailbox => ({
            ...connection, mailbox,
            authPasswordEnc: authPassword ? encryptAuthPassword(authPassword) : account.authPasswordEnc,
          })),
        });
      }
    }, { isolationLevel: 'Serializable' });
    res.json({ ok: true });
  }),
);

router.delete(
  '/accounts/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const account = await prisma.emailAccount.findUnique({ where: { id } });
    if (!account) throw new ApiError(404, '邮箱账户不存在');
    await prisma.emailAccount.delete({ where: { id } });
    res.json({ ok: true });
  }),
);

// 启用/停用
router.put(
  '/accounts/:id/enabled',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const account = await prisma.emailAccount.findUnique({ where: { id } });
    if (!account) throw new ApiError(404, '邮箱账户不存在');
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await prisma.emailAccount.update({ where: { id }, data: { enabled } });
    res.json({ ok: true });
  }),
);

// 连接测试（用请求参数，不落库）
router.post(
  '/accounts/test',
  asyncHandler(async (req, res) => {
    const { accountId, mailboxes, authPassword, ...input } = accountSchema.extend({
      accountId: z.number().int().positive().optional(),
      mailboxes: mailboxPathsSchema.optional(),
      authPassword: z.string().min(1).optional(),
    }).parse(req.body);
    const account = accountId === undefined ? null : await prisma.emailAccount.findUnique({ where: { id: accountId } });
    if (!authPassword && !account) throw new ApiError(400, '请输入授权码');
    if (!authPassword && account && (
      account.imapHost !== input.imapHost || account.imapPort !== input.imapPort ||
      account.tls !== input.tls || account.authUser !== input.authUser
    )) throw new ApiError(400, '连接信息已变更，请输入授权码');
    const password = authPassword ?? decrypt(config.encryptionKey, Buffer.from(account!.authPasswordEnc));
    const result = await testMailboxes({ ...input, authPassword: password },
      mailboxes?.length ? mailboxes : [account?.mailbox ?? input.mailbox]);
    res.json(result);
  }),
);

// 手动同步
router.post(
  '/accounts/:id/sync',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const summary = await syncAccount(id);
    res.json(summary);
  }),
);

// ===== 同步日志 =====

router.get(
  '/logs',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    // 默认排除未匹配，includeUnmatched=1 时才展示
    const includeUnmatched = req.query.includeUnmatched === '1';
    const where = {
      ...(accountId ? { accountId } : {}),
      ...(status ? { status } : includeUnmatched ? {} : { status: { notIn: ['unmatched'] } }),
    };

    const [total, logs] = await Promise.all([
      prisma.mailLog.count({ where }),
      prisma.mailLog.findMany({
        where,
        include: { bills: { select: { id: true }, orderBy: { id: 'asc' } } },
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    res.json({
      total,
      page,
      pageSize,
      items: logs.map((l) => ({
        id: l.id,
        accountId: l.accountId,
        uid: l.uid,
        fromAddress: l.fromAddress,
        subject: l.subject,
        mailDate: l.mailDate.toISOString(),
        status: l.status,
        parserId: l.parserId,
        billIds: l.bills.map((bill) => bill.id),
        error: l.error,
        processedAt: l.processedAt.toISOString(),
      })),
    });
  }),
);

// ===== 解析器中心 =====

// 已注册解析器列表
router.get(
  '/parsers',
  asyncHandler(async (_req, res) => {
    res.json(
      listParsers().map((p) => ({
        id: p.id,
        bankName: p.bankName,
        senderPatterns: p.senderPatterns,
        subjectPatterns: p.subjectPatterns?.map((re) => re.source) ?? [],
      })),
    );
  }),
);

// 解析器干跑：从指定邮箱拉最近 N 封（或近 N 天，limit 上限 1000）邮件实跑解析，不落库
router.post(
  '/dry-run',
  asyncHandler(async (req, res) => {
    const { accountId, limit, parserId, sinceDays } = z
      .object({
        accountId: z.number().int().positive(),
        limit: z.number().int().min(1).max(1000).default(20),
        parserId: z.string().optional(),
        sinceDays: z.number().int().min(1).max(365).optional(),
      })
      .parse(req.body ?? {});
    const result = await dryRunParse(accountId, limit, parserId, sinceDays);
    res.json(result);
  }),
);

// 实时读取单封邮件正文（不落库），供解析器调试
router.get(
  '/accounts/:id/messages/:uid',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid < 1) throw new ApiError(400, '非法 UID');
    res.json(await fetchMailBody(id, uid));
  }),
);

// 重新同步：清除同步日志并重置游标，重新拉取近 N 天邮件（解析器上新后回灌历史）
router.post(
  '/accounts/:id/resync',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const summary = await resyncAccount(id);
    res.json(summary);
  }),
);

// 历史拉取：全量拉取邮箱全部历史邮件（后台任务，前端轮询进度）
router.post(
  '/accounts/:id/history-sync',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const state = await startHistorySync(id);
    res.status(202).json(state);
  }),
);

// 历史拉取进度查询
router.get(
  '/accounts/:id/history-sync',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    res.json(getHistorySyncState(id));
  }),
);

export default router;
