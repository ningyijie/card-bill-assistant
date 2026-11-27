import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { articleUrlSchema } from './wechat-articles';
import type { SyncTrigger } from './wechat-subscriptions';

const sources = z.enum(['weread', 'platform', 'werss']);
export const wechatSyncRunQuery = z.object({
  source: sources.optional(),
  account: z.string().trim().min(1).max(120).optional(),
  accountId: z.string().regex(/^[A-Za-z0-9_+/=-]{1,80}$/).optional(),
  before: z.coerce.number().int().positive().max(2_147_483_647).optional(),
});

export type WechatSyncArticle = {
  url?: string;
  title?: string;
  state: 'drafted' | 'duplicate' | 'unmatched' | 'missing' | 'unprocessed';
  drafts?: number;
  method?: 'ollama' | 'rules';
};

export interface WechatSyncRunContext {
  source: z.infer<typeof sources>;
  accountId?: string;
  accountName?: string | null;
  trigger: SyncTrigger;
  startedAt: Date;
}

export async function recordWechatSyncRun(context: WechatSyncRunContext, report: {
  status: 'completed' | 'partial' | 'limited' | 'failed';
  message?: string | null;
  retryAfter?: string;
  discovered: number;
  updated: number;
  skipped: number;
  missing: number;
  articles: WechatSyncArticle[];
}) {
  try {
    const articles = report.articles.slice(0, 60).map(({ url, title, state, drafts, method }) => ({
      url: articleUrlSchema.safeParse(url).data ?? null,
      title: title ? Array.from(title).slice(0, 120).join('') : null,
      state,
      drafts: drafts ?? 0,
      ...(method ? { method } : {}),
    }));
    await prisma.wechatSyncRun.create({ data: { ...context, report: { ...report, message: report.message ?? null, articles } } });
  } catch {
    console.error('[wechat] 无法保存公众号同步记录');
  }
}

export async function listWechatSyncRuns({ source, account, accountId, before }: z.infer<typeof wechatSyncRunQuery>) {
  const pageSize = 10;
  const rows = await prisma.wechatSyncRun.findMany({
    where: {
      source,
      ...(accountId && account ? { OR: [{ accountId }, { accountId: null, accountName: account }] }
        : { accountId, accountName: account }),
      ...(before ? { id: { lt: before } } : {}),
    },
    orderBy: { id: 'desc' },
    take: pageSize + 1,
  });
  const runs = rows.slice(0, pageSize);
  return { runs, nextBefore: rows.length > pageSize ? runs[pageSize - 1].id : null };
}
