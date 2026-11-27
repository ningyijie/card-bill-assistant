import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Empty, Flex, Form, Input, Modal, Popconfirm, Segmented, Select, Space, Spin,
  Switch, Tag, Typography } from 'antd';
import { api } from '../../api/client';
import { displayDate } from '../../lib/displayDate';
import { useResource } from '../../lib/useResource';
import { WechatArticleImport } from './WechatOfferSources';
import { WechatPlatformScan } from './WechatPlatformScan';
import { WechatReadingScan } from './WechatReadingScan';

export type WechatSubscriptionSource = 'weread' | 'platform';
const sources = {
  weread: { label: '微信读书', path: '/api/offers/weread-collection' },
  platform: { label: '公众号平台', path: '/api/offers/wechat-collection' },
} as const;
const sourceTypes = Object.keys(sources) as WechatSubscriptionSource[];
const frequencies = [24, 12, 6, 3, 1].map((value) => ({ value,
  label: value === 24 ? '每天一次' : value === 1 ? '每小时' : `每 ${value} 小时`,
}));
const date = (time: string | null | undefined) => displayDate(time, { time: true });
const notice = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';

interface AccountOption { id: string; name: string }
interface Account {
  accountId: string; name: string; enabled: boolean; syncHours: number;
  lastAttempt: string | null; lastSuccess: string | null; error: string | null;
}
interface SourceStatus {
  authorized: boolean;
  accounts: Account[];
  activeAccountId: string | null;
  suggestedAccount?: AccountOption;
  retryAfter?: string | null;
  error?: string | null;
}
interface Counts { discovered: number; updated: number; missing: number }
const countsText = ({ discovered, updated, missing }: Counts) =>
  `发现 ${discovered} 篇，生成 ${updated} 条草稿${missing ? `，${missing} 篇正文未取得` : ''}`;

function useWechatSource(source: WechatSubscriptionSource) {
  const resource = useResource<SourceStatus>(sources[source].path);
  const { data, refresh } = resource;
  const retryAt = data?.retryAfter ? Date.parse(data.retryAfter) : 0;
  const coolingDown = retryAt > Date.now();
  useEffect(() => {
    const delay = retryAt - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => void refresh(), Math.min(delay + 100, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [retryAt, refresh]);
  useEffect(() => {
    if (!data?.activeAccountId) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [data?.activeAccountId, refresh]);
  return { ...resource, coolingDown };
}

function wereadBookId(input: string) {
  const value = input.trim();
  if (/^MP_WXS_\d{1,20}$/.test(value)) return value;
  try {
    const link = new URL(value);
    if (link.origin !== 'https://mp.weixin.qq.com' || !/^\/s(?:\/|$)/.test(link.pathname)) return;
    const id = atob(link.searchParams.get('__biz') ?? '');
    if (/^\d{1,20}$/.test(id)) return 'MP_WXS_' + id;
  } catch {
    return undefined;
  }
}

export function WechatSubscriptions({ onImported, onHistory }: {
  onImported: () => void;
  onHistory: (source: WechatSubscriptionSource, account: string, accountId: string) => void;
}) {
  const { message } = App.useApp();
  const weread = useWechatSource('weread');
  const platform = useWechatSource('platform');
  const sourceState = { weread, platform };
  const [scanning, setScanning] = useState<WechatSubscriptionSource>();
  const [adding, setAdding] = useState<WechatSubscriptionSource>();
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [results, setResults] = useState<AccountOption[]>();
  const scanRefresh = scanning === 'platform' ? platform.refresh : weread.refresh;
  const onAuthorized = useCallback(() => {
    setScanning(undefined);
    void scanRefresh();
    message.success('授权成功');
  }, [message, scanRefresh]);

  function add(source: WechatSubscriptionSource) {
    setAdding(source);
    setResults(undefined);
  }

  async function search(input: string) {
    const q = input.trim();
    if (!q || busy || platform.coolingDown) return;
    setBusy('search');
    setResults(undefined);
    try {
      setResults(await api.get<AccountOption[]>(sources.platform.path + '/accounts?' + new URLSearchParams({ q })));
    } catch (error) { message.error(notice(error)); await platform.refresh(); }
    finally { setBusy(undefined); }
  }

  async function save(source: WechatSubscriptionSource, account: AccountOption, enabled: boolean, syncHours?: number, close = false) {
    setBusy(`${source}:${account.id}`);
    try {
      await api.put(sources[source].path, source === 'weread'
        ? { bookId: account.id, name: account.name, enabled, syncHours }
        : { account, enabled });
      await sourceState[source].refresh();
      if (close) {
        setAdding(undefined);
        message.success(`已订阅${account.name}`);
      }
    } catch (error) { message.error(notice(error)); }
    finally { setBusy(undefined); }
  }

  async function sync(source: WechatSubscriptionSource, accountId: string) {
    setBusy(`${source}:${accountId}:sync`);
    try {
      const result = await api.post<Counts & { supplement?: Counts }>(sources[source].path + '/refresh', { accountId });
      message.success(countsText(result) + (result.supplement ? '。公众号平台补查' + countsText(result.supplement) : ''));
      if (result.updated || result.supplement?.updated) onImported();
    } catch (error) { message.error(notice(error)); }
    finally {
      await Promise.all([weread.refresh(), platform.refresh()]);
      setBusy(undefined);
    }
  }

  async function remove(source: WechatSubscriptionSource, accountId: string) {
    setBusy(`${source}:${accountId}`);
    try {
      await api.delete(sources[source].path + '/subscriptions/' + encodeURIComponent(accountId));
      await sourceState[source].refresh();
      message.success('已移除订阅');
    } catch (error) { message.error(notice(error)); }
    finally { setBusy(undefined); }
  }

  async function revoke(source: WechatSubscriptionSource) {
    setBusy('revoke');
    try {
      await api.delete(sources[source].path + '/authorization');
      await sourceState[source].refresh();
      message.success('已解除授权');
    } catch (error) { message.error(notice(error)); }
    finally { setBusy(undefined); }
  }

  const rows = sourceTypes.flatMap((source) => (sourceState[source].data?.accounts ?? []).map((account) => ({ source, account })));
  const suggested = weread.data?.suggestedAccount;
  const addState = adding && sourceState[adding];

  return <Card className="offers-subscriptions-panel" size="small" title="公众号订阅" extra={<Space wrap>
    <Button size="small" onClick={() => setImporting(true)}>导入公众号文章</Button>
    <Button size="small" type="primary" onClick={() => add(weread.data?.authorized || !platform.data?.authorized ? 'weread' : 'platform')}>添加公众号</Button>
  </Space>}>
    <Flex vertical gap={12}>
      <div className="offers-source-connections">
        {sourceTypes.map((source) => {
          const { data, error, coolingDown } = sourceState[source];
          const status = data?.authorized ? (coolingDown ? 'gold' : 'green') : 'default';
          return <Flex key={source} className="offers-source-connection" vertical gap={6}>
            <Flex wrap justify="space-between" align="center" gap={8}>
              <Space wrap><Typography.Text strong>{sources[source].label}</Typography.Text>
                <Tag color={status}>{coolingDown ? '限频' : data?.authorized ? '已授权' : '待授权'}</Tag></Space>
              <Space wrap>
                <Button size="small" disabled={Boolean(busy)} onClick={() => setScanning(source)}>{data?.authorized ? '重新扫码' : '扫码授权'}</Button>
                {data?.authorized && <Popconfirm title={`解除${sources[source].label}授权？`} description="订阅会保留，重新授权后可继续同步。"
                  onConfirm={() => void revoke(source)} okText="解除授权" cancelText="取消">
                  <Button size="small" type="link" disabled={Boolean(busy)}>解除授权</Button>
                </Popconfirm>}
              </Space>
            </Flex>
            {coolingDown && <Typography.Text type="warning">{date(data?.retryAfter)} 后可重试</Typography.Text>}
            {(error || data?.error) && <Typography.Text type="danger">{error || data?.error}</Typography.Text>}
          </Flex>;
        })}
      </div>
      {rows.length === 0 && (weread.loading || platform.loading ? <Spin /> : <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有订阅公众号" />)}
      {rows.map(({ source, account }) => {
        const { data, coolingDown } = sourceState[source];
        const key = `${source}:${account.accountId}`;
        const active = busy === key + ':sync' || data?.activeAccountId === account.accountId;
        const option = { id: account.accountId, name: account.name };
        return <div key={key} className="offers-subscription">
          <Flex wrap justify="space-between" align="start" gap={8}>
            <Flex vertical gap={6}>
              <Space wrap>
                <Typography.Text strong>{account.name}</Typography.Text>
                <Tag>{sources[source].label}</Tag>
                {active ? <Tag color="processing">同步中</Tag>
                  : !account.enabled ? <Tag>已暂停</Tag> : account.error && <Tag color="gold">请查看同步结果</Tag>}
              </Space>
              <Space wrap size={[14, 4]}>
                <Typography.Text type="secondary">{account.lastSuccess ? `上次成功 ${date(account.lastSuccess)}` : '尚未同步成功'}</Typography.Text>
                {account.lastAttempt && <Typography.Text type="secondary">最近尝试 {date(account.lastAttempt)}</Typography.Text>}
              </Space>
            </Flex>
            <Space wrap size={[8, 8]}>
              <Switch size="small" checked={account.enabled} disabled={Boolean(busy) || active}
                aria-label={`${account.name} · ${sources[source].label}自动同步`}
                onChange={(enabled) => void save(source, option, enabled)} />
              {source === 'weread' ? <Select size="small" style={{ minWidth: 108 }} value={account.syncHours} options={frequencies}
                disabled={Boolean(busy) || active} aria-label={`${account.name}同步频率`}
                onChange={(hours) => void save(source, option, account.enabled, hours)} />
                : <Typography.Text type="secondary">每天一次</Typography.Text>}
              <Button size="small" loading={active} disabled={!data?.authorized || coolingDown || Boolean(busy || data?.activeAccountId)}
                onClick={() => void sync(source, account.accountId)}>立即同步</Button>
              <Button size="small" onClick={() => onHistory(source, account.name, account.accountId)}>查看记录</Button>
              <Popconfirm title={`移除「${account.name}」？`} description="已导入的活动和历史记录会保留。"
                onConfirm={() => void remove(source, account.accountId)} okText="移除" cancelText="取消">
                <Button size="small" type="text" disabled={Boolean(busy) || active}>移除</Button>
              </Popconfirm>
            </Space>
          </Flex>
          {account.error && <Typography.Text type="warning">{account.error}</Typography.Text>}
        </div>;
      })}
    </Flex>
    {adding && addState && <Modal open title="添加公众号" footer={null} onCancel={() => setAdding(undefined)}>
      <Flex vertical gap={12}>
        <Segmented block options={sourceTypes.map((value) => ({ value, label: sources[value].label }))}
          value={adding} onChange={add} disabled={Boolean(busy)} />
        {!addState.data?.authorized ? <Button onClick={() => setScanning(adding)}>扫码授权{sources[adding].label}</Button>
          : adding === 'platform' ? <>
            {platform.coolingDown && <Alert type="warning" title={`公众号平台限频，${date(platform.data?.retryAfter)} 后可重试`} />}
            <Input.Search aria-label="搜索公众号" placeholder="输入公众号名称" enterButton="搜索公众号"
              maxLength={60} loading={busy === 'search'} disabled={platform.coolingDown || Boolean(busy && busy !== 'search')}
              onSearch={(value) => void search(value)} />
            {results?.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未找到该公众号" />}
            {results?.map((item) => {
              const subscribed = platform.data?.accounts.some(({ accountId }) => accountId === item.id);
              return <Flex key={item.id} align="center" justify="space-between" gap={8}>
                <Typography.Text>{item.name}</Typography.Text>
                <Button size="small" disabled={subscribed || Boolean(busy)} aria-label={`订阅 ${item.name}`}
                  onClick={() => void save('platform', item, true, undefined, true)}>{subscribed ? '已订阅' : '订阅'}</Button>
              </Flex>;
            })}
          </> : <Flex vertical gap={12}>
            {suggested && !weread.data?.accounts.some((account) => account.accountId === suggested.id) &&
              <Button disabled={Boolean(busy)} onClick={() => void save('weread', suggested, true, undefined, true)}>订阅{suggested.name}</Button>}
            <Form<{ name: string; identifier: string }> layout="vertical" onFinish={({ name, identifier }) => {
              const id = wereadBookId(identifier);
              if (id) void save('weread', { id, name }, true, undefined, true);
            }}>
              <Form.Item name="name" label="公众号名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={120} /></Form.Item>
              <Form.Item name="identifier" label="微信读书编号或公众号文章长链接" rules={[{ validator: (_, value) => value && wereadBookId(value)
                ? Promise.resolve() : Promise.reject(new Error('请输入 MP_WXS_ 编号或含 __biz 的文章长链接')) }]}>
                <Input placeholder="MP_WXS_… 或含 __biz 的文章长链接" maxLength={1200} />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={Boolean(busy)} disabled={Boolean(busy)}>添加订阅</Button>
            </Form>
          </Flex>}
      </Flex>
    </Modal>}
    {scanning === 'platform' && <WechatPlatformScan close={() => setScanning(undefined)} onAuthorized={onAuthorized} />}
    {scanning === 'weread' && <WechatReadingScan close={() => setScanning(undefined)} onAuthorized={onAuthorized} />}
    {importing && <WechatArticleImport close={() => setImporting(false)} onImported={onImported} />}
  </Card>;
}
