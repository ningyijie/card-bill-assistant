import type { Prisma, WechatOfferSubscription } from '../../generated/prisma/client';
import { ApiError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { withTransactionRetry } from '../../parsers/pipeline';

export const wechatSources = { platform: 1, weread: 2 } as const;
export type SyncTrigger = 'manual' | 'scheduled' | 'supplement';
export type SyncCounts = { discovered: number; updated: number; skipped: number; missing: number };
export const emptySync: SyncCounts = { discovered: 0, updated: 0, skipped: 0, missing: 0 };

export function wechatAuthorized(source: WechatOfferSubscription | null, now = Date.now()) {
  return Boolean(source?.credential && (!source.expiresAt || source.expiresAt.getTime() > now));
}

export function wechatRetryTime(source: WechatOfferSubscription | null, now = Date.now()) {
  return source?.retryAfter && source.retryAfter.getTime() > now ? source.retryAfter : null;
}

export function subscriptionKey(sourceId: number, accountId: string) {
  return { sourceId_accountId: { sourceId, accountId } };
}

export function listWechatSubscriptions(sourceId: number) {
  return prisma.wechatSubscribedAccount.findMany({
    where: { sourceId },
    orderBy: [{ name: 'asc' }, { accountId: 'asc' }],
  });
}

export async function saveWechatSubscription(sourceId: number, accountId: string, update: {
  name?: string; enabled: boolean; syncHours?: number;
}) {
  const where = subscriptionKey(sourceId, accountId);
  await withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const existing = await tx.wechatSubscribedAccount.findUnique({ where, select: { accountId: true } });
    if (!existing) {
      const source = await tx.wechatOfferSubscription.findUnique({ where: { id: sourceId } });
      if (!wechatAuthorized(source)) throw new ApiError(409, '请先授权该采集来源');
    }
    await tx.wechatSubscribedAccount.upsert({
      where, update, create: { ...update, sourceId, accountId, name: update.name ?? accountId },
    });
  }, { isolationLevel: 'Serializable' }));
}

export async function removeWechatSubscription(sourceId: number, accountId: string) {
  await prisma.wechatSubscribedAccount.deleteMany({ where: { sourceId, accountId } });
}

type AccountWithSource = Prisma.WechatSubscribedAccountGetPayload<{ include: { source: true } }>;

export function claimWechatSubscription(
  sourceId: number, accountId: string, trigger: SyncTrigger, startedAt: Date,
  isDue: (account: AccountWithSource) => boolean,
  rateError: (time: Date) => Error,
) {
  const where = subscriptionKey(sourceId, accountId);
  return withTransactionRetry(() => prisma.$transaction(async (tx) => {
    const account = await tx.wechatSubscribedAccount.findUnique({ where, include: { source: true } });
    if (!account || !wechatAuthorized(account.source, startedAt.getTime())) {
      if (trigger === 'manual') throw new ApiError(409, '请先授权该采集来源并添加公众号');
      return;
    }
    if (trigger !== 'manual' && (!account.enabled || !isDue(account))) return;
    const retryAt = wechatRetryTime(account.source, startedAt.getTime());
    if (retryAt) {
      if (trigger === 'manual') throw rateError(retryAt);
      return;
    }
    await tx.wechatSubscribedAccount.update({ where, data: { lastAttempt: startedAt } });
    return account;
  }, { isolationLevel: 'Serializable' }));
}

export function subscriptionRunMatch(account: AccountWithSource, startedAt: Date): Prisma.WechatSubscribedAccountWhereInput {
  return { sourceId: account.sourceId, accountId: account.accountId, lastAttempt: startedAt,
    source: { authorizedAt: account.source.authorizedAt, credential: { not: null } } };
}

export function createWechatSyncRunner<T extends SyncCounts>(
  sourceId: number, empty: T, collect: (accountId: string, trigger: SyncTrigger, startedAt: Date) => Promise<T>,
) {
  let active: { accountId: string; done: Promise<T> } | undefined;

  function run(accountId: string, trigger: SyncTrigger, time: Date) {
    if (active) {
      if (trigger !== 'manual') return Promise.resolve(empty);
      if (active.accountId !== accountId) throw new ApiError(409, '另一个公众号正在同步，请稍后重试');
      return active.done;
    }
    const done = collect(accountId, trigger, time).finally(() => { active = undefined; });
    active = { accountId, done };
    return done;
  }

  async function refresh(trigger: SyncTrigger, time: Date, accountId?: string) {
    if (accountId) return run(accountId, trigger, time);
    const accounts = await prisma.wechatSubscribedAccount.findMany({
      where: { sourceId, ...(trigger === 'manual' ? {} : { enabled: true }) },
      select: { accountId: true }, orderBy: { accountId: 'asc' },
    });
    if (trigger === 'manual') {
      if (accounts.length !== 1) throw new ApiError(409, accounts.length ? '请选择要同步的公众号' : '请先添加公众号');
      return run(accounts[0].accountId, trigger, time);
    }
    let total = empty;
    for (const account of accounts) {
      const report = await run(account.accountId, trigger, time);
      total = { ...report, discovered: total.discovered + report.discovered, updated: total.updated + report.updated,
        skipped: total.skipped + report.skipped, missing: total.missing + report.missing };
    }
    return total;
  }

  return { refresh, activeAccount: () => active?.accountId ?? null };
}
