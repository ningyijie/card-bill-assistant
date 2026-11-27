import { useState } from 'react';
import { Alert, Button, Card, Collapse, Empty, Flex, Input, Select, Space, Spin, Tag, Typography } from 'antd';
import { displayDate } from '../../lib/displayDate';
import { useResource } from '../../lib/useResource';
import { WechatArticleImport } from './WechatOfferSources';

const sources = { weread: '微信读书', platform: '公众号平台', werss: '外部 WeRSS' };
const triggers = { manual: '手动刷新', scheduled: '定时同步', supplement: '补充同步' };
const runStates = {
  completed: { label: '已完成', color: 'green' }, partial: { label: '部分完成', color: 'gold' },
  limited: { label: '限频', color: 'gold' }, failed: { label: '同步失败', color: 'red' },
};
const articleStates = {
  drafted: { label: '已生成草稿', color: 'green' }, duplicate: { label: '已入库', color: 'blue' },
  unmatched: { label: '未提取到持卡优惠', color: 'default' }, missing: { label: '正文未取得', color: 'gold' },
  unprocessed: { label: '结果待确认', color: 'default' },
};
type ArticleState = keyof typeof articleStates;
export interface WechatRunFilter { source?: keyof typeof sources; account?: string; accountId?: string }

interface SyncArticle {
  url: string | null;
  title: string | null;
  state: ArticleState;
  drafts: number;
  method?: 'ollama' | 'rules';
}

interface SyncRun {
  id: number;
  source: keyof typeof sources;
  accountName: string | null;
  trigger: keyof typeof triggers;
  startedAt: string;
  report: {
    status: keyof typeof runStates;
    message: string | null;
    retryAfter?: string;
    discovered: number;
    updated: number;
    missing: number;
    articles: SyncArticle[];
  };
}

export function WechatSyncRuns({ initialFilter, onImported, onReview }: {
  initialFilter?: WechatRunFilter;
  onImported: () => void;
  onReview: (url: string) => void;
}) {
  const [source, setSource] = useState(initialFilter?.source);
  const [account, setAccount] = useState(initialFilter?.account ?? '');
  const [accountId, setAccountId] = useState(initialFilter?.accountId);
  const [articleState, setArticleState] = useState<ArticleState | ''>('');
  const [pages, setPages] = useState<number[]>([]);
  const [importing, setImporting] = useState<{ url: string; title?: string }>();
  const before = pages.at(-1);
  const query = new URLSearchParams();
  if (source) query.set('source', source);
  if (account) query.set('account', account);
  if (accountId) query.set('accountId', accountId);
  if (before) query.set('before', String(before));
  const { data, loading, error, refresh } = useResource<{ runs: SyncRun[]; nextBefore: number | null }>(
    '/api/offers/wechat-sync-runs' + (query.size ? `?${query}` : ''),
  );
  const nextBefore = data?.nextBefore;

  return <Flex vertical gap={12}>
    <Flex wrap align="center" justify="space-between" gap={8}>
      <Space wrap size={[8, 8]}>
        <Select<keyof typeof sources | ''> aria-label="同步来源" value={source ?? ''} style={{ minWidth: 135 }}
          options={[{ value: '', label: '全部来源' }, ...Object.entries(sources).map(([value, label]) => ({ value, label }))]}
          onChange={(value) => { setSource(value || undefined); setAccountId(undefined); setPages([]); }} />
        <Input.Search aria-label="公众号名称筛选" placeholder="输入完整公众号名称" allowClear maxLength={120}
          defaultValue={account} enterButton="筛选"
          onSearch={(name) => { setAccount(name.trim()); setAccountId(undefined); setPages([]); }} />
        <Select<ArticleState | ''> aria-label="文章处理结果" value={articleState} style={{ minWidth: 146 }}
          options={[{ value: '', label: '全部处理结果' }, ...Object.entries(articleStates).map(([value, { label }]) => ({ value, label }))]}
          onChange={setArticleState} />
      </Space>
      <Button size="small" loading={loading} onClick={() => void refresh()}>刷新记录</Button>
    </Flex>
    {error && <Alert type="error" showIcon title={error} />}
    {loading && !data && <Spin />}
    {data?.runs.length === 0 && <Card size="small"><Empty description={source || account ? '暂无符合条件的同步记录'
      : '暂无公众号同步记录，可在「活动来源」立即同步'} /></Card>}
    {data && data.runs.length > 0 && <Collapse accordion key={`${source ?? ''}:${account}:${before ?? 0}:${data.runs[0].id}`}
      defaultActiveKey={data.runs[0].id} items={data.runs.map(({ id, source, trigger, accountName, startedAt, report }) => ({
        key: id,
        label: <Flex wrap align="center" justify="space-between" gap={8}>
          <Space wrap size={8}>
            <Typography.Text strong>{accountName || sources[source]}</Typography.Text>
            <Typography.Text type="secondary">{accountName ? `${sources[source]} · ` : ''}{triggers[trigger]} · {displayDate(startedAt, { time: true })}</Typography.Text>
          </Space>
          <Space wrap size={6}>
            <Typography.Text type="secondary">发现 {report.discovered} 篇 · 草稿 {report.updated} 条</Typography.Text>
            <Tag color={runStates[report.status].color}>{runStates[report.status].label}</Tag>
          </Space>
        </Flex>,
        children: <Flex vertical gap={10}>
          <Space size={[14, 6]} wrap aria-label="本批同步结果">
            <Typography.Text>已入库 {report.articles.filter(({ state }) => state === 'duplicate').length} 篇</Typography.Text>
            <Typography.Text>未提取到持卡优惠 {report.articles.filter(({ state }) => state === 'unmatched').length} 篇</Typography.Text>
            <Typography.Text>正文未取得 {report.missing} 篇</Typography.Text>
          </Space>
          {report.message && <Alert type={report.status === 'failed' ? 'error' : 'warning'} showIcon title={report.message}
            description={report.retryAfter ? `可重试时间 ${displayDate(report.retryAfter, { time: true })}` : undefined} />}
          {articleState && !report.articles.some(({ state }) => state === articleState) &&
            <Typography.Text type="secondary">本批没有这种处理结果</Typography.Text>}
          {report.articles.filter(({ state }) => !articleState || state === articleState).map((article, index) => (
            <Flex key={index} className="offers-sync-article" wrap justify="space-between" align="center" gap={8}>
              <Space size={8} wrap>
                <Typography.Text>{article.title || '未取得标题'}</Typography.Text>
                <Tag color={articleStates[article.state].color}>{articleStates[article.state].label}{article.drafts > 0 ? ` · ${article.drafts} 条` : ''}</Tag>
                {article.method && <Typography.Text type="secondary">{article.method === 'ollama' ? '本地 AI 整理' : '规则提取'}</Typography.Text>}
              </Space>
              {article.url && <Space size={10} wrap>
                <a href={article.url} target="_blank" rel="noreferrer">查看原文</a>
                {(article.state === 'drafted' || article.state === 'duplicate') &&
                  <Button size="small" onClick={() => onReview(article.url!)}>查看活动</Button>}
                {article.state === 'missing' && <Button size="small" onClick={() => setImporting({ url: article.url!, title: article.title ?? undefined })}>补录正文</Button>}
              </Space>}
            </Flex>
          ))}
          {report.discovered > report.articles.length && <Typography.Text type="secondary">本批仅展示前 {report.articles.length} 篇明细。</Typography.Text>}
        </Flex>,
      }))} />}
    {Boolean(before || nextBefore) && <Flex justify="end" gap={8}>
      <Button size="small" disabled={!before || loading} onClick={() => setPages(pages.slice(0, -1))}>上一页</Button>
      <Button size="small" disabled={!nextBefore || loading} onClick={() => { if (nextBefore) setPages([...pages, nextBefore]); }}>下一页</Button>
    </Flex>}
    {importing && <WechatArticleImport initial={importing} close={() => setImporting(undefined)} onImported={onImported} />}
  </Flex>;
}
