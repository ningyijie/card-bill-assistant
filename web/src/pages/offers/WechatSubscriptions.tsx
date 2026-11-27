import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Empty, Flex, Form, Input, Modal, Popconfirm, Select, Space, Spin,
  Switch, Tag, Typography } from 'antd';
import { api } from '../../api/client';
import { displayDate } from '../../lib/displayDate';
import { useResource } from '../../lib/useResource';
import { WechatArticleImport } from './WechatOfferSources';
import { WechatReadingScan } from './WechatReadingScan';

const path = '/api/offers/weread-collection';
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

function useWereadStatus() {
  const resource = useResource<SourceStatus>(path);
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
  onHistory: (account: string, accountId: string) => void;
}) {
  const { message } = App.useApp();
  const { data, error, loading, coolingDown, refresh } = useWereadStatus();
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState<string>();
  const onAuthorized = useCallback(() => {
    setScanning(false);
    void refresh();
    message.success('授权成功');
  }, [message, refresh]);

  async function save(account: AccountOption, enabled: boolean, syncHours?: number, close = false) {
    setBusy(account.id);
    try {
      await api.put(path, { bookId: account.id, name: account.name, enabled, syncHours });
      await refresh();
      if (close) {
        setAdding(false);
        message.success(`已订阅${account.name}`);
      }
    } catch (error) { message.error(notice(error)); }
    finally { setBusy(undefined); }
  }

  async function sync(accountId: string) {
    setBusy(accountId + ':sync');
    try {
      const result = await api.post<Counts>(path + '/refresh', { accountId });
      message.success(countsText(result));
      if (result.updated) onImported();
    } catch (error) { message.error(notice(error)); }
    finally {
      await refresh();
      setBusy(undefined);
    }
  }

  async function remove(accountId: string) {
    setBusy(accountId);
    try {
      await api.delete(path + '/subscriptions/' + encodeURIComponent(accountId));
      await refresh();
      message.success('已移除订阅');
    } catch (error) { message.error(notice(error)); }
    finally { setBusy(undefined); }
  }

  async function revoke() {
    setBusy('revoke');
    try {
      await api.delete(path + '/authorization');
      await refresh();
      message.success('已解除授权');
    } catch (error) { message.error(notice(error)); }
    finally { setBusy(undefined); }
  }

  const accounts = data?.accounts ?? [];
  const suggested = data?.suggestedAccount;
  const status = coolingDown ? 'gold' : data?.authorized ? 'green' : 'default';

  return <Card className="offers-subscriptions-panel" size="small" title="公众号订阅" extra={<Space wrap>
    <Button size="small" onClick={() => setImporting(true)}>导入公众号文章</Button>
    <Button size="small" type="primary" onClick={() => setAdding(true)}>添加公众号</Button>
  </Space>}>
    <Flex vertical gap={12}>
      <Flex className="offers-source-connection" vertical gap={6}>
        <Flex wrap justify="space-between" align="center" gap={8}>
          <Space wrap><Typography.Text strong>微信读书</Typography.Text>
            <Tag color={status}>{coolingDown ? '限频' : data?.authorized ? '已授权' : '待授权'}</Tag></Space>
          <Space wrap>
            <Button size="small" disabled={Boolean(busy)} onClick={() => setScanning(true)}>{data?.authorized ? '重新扫码' : '扫码授权'}</Button>
            {data?.authorized && <Popconfirm title="解除微信读书授权？" description="订阅会保留，重新授权后可继续同步。"
              onConfirm={() => void revoke()} okText="解除授权" cancelText="取消">
              <Button size="small" type="link" disabled={Boolean(busy)}>解除授权</Button>
            </Popconfirm>}
          </Space>
        </Flex>
        {coolingDown && <Typography.Text type="warning">{date(data?.retryAfter)} 后可重试</Typography.Text>}
        {(error || data?.error) && <Typography.Text type="danger">{error || data?.error}</Typography.Text>}
      </Flex>
      {accounts.length === 0 && (loading ? <Spin /> : <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有订阅公众号" />)}
      {accounts.map((account) => {
        const active = busy === account.accountId + ':sync' || data?.activeAccountId === account.accountId;
        const option = { id: account.accountId, name: account.name };
        return <div key={account.accountId} className="offers-subscription">
          <Flex wrap justify="space-between" align="start" gap={8}>
            <Flex vertical gap={6}>
              <Space wrap>
                <Typography.Text strong>{account.name}</Typography.Text>
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
                aria-label={`${account.name} · 微信读书自动同步`}
                onChange={(enabled) => void save(option, enabled)} />
              <Select size="small" style={{ minWidth: 108 }} value={account.syncHours} options={frequencies}
                disabled={Boolean(busy) || active} aria-label={`${account.name}同步频率`}
                onChange={(hours) => void save(option, account.enabled, hours)} />
              <Button size="small" loading={active} disabled={!data?.authorized || coolingDown || Boolean(busy || data?.activeAccountId)}
                onClick={() => void sync(account.accountId)}>立即同步</Button>
              <Button size="small" onClick={() => onHistory(account.name, account.accountId)}>查看记录</Button>
              <Popconfirm title={`移除「${account.name}」？`} description="已导入的活动和历史记录会保留。"
                onConfirm={() => void remove(account.accountId)} okText="移除" cancelText="取消">
                <Button size="small" type="text" disabled={Boolean(busy) || active}>移除</Button>
              </Popconfirm>
            </Space>
          </Flex>
          {account.error && <Typography.Text type="warning">{account.error}</Typography.Text>}
        </div>;
      })}
    </Flex>
    {adding && <Modal open title="添加公众号" footer={null} onCancel={() => setAdding(false)}>
      <Flex vertical gap={12}>
        {!data?.authorized ? <Button onClick={() => setScanning(true)}>扫码授权微信读书</Button>
          : <>
            {suggested && !accounts.some((account) => account.accountId === suggested.id) &&
              <Button disabled={Boolean(busy)} onClick={() => void save(suggested, true, undefined, true)}>订阅{suggested.name}</Button>}
            <Form<{ name: string; identifier: string }> layout="vertical" onFinish={({ name, identifier }) => {
              const id = wereadBookId(identifier);
              if (id) void save({ id, name }, true, undefined, true);
            }}>
              <Form.Item name="name" label="公众号名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={120} /></Form.Item>
              <Form.Item name="identifier" label="微信读书编号或公众号文章长链接" rules={[{ validator: (_, value) => value && wereadBookId(value)
                ? Promise.resolve() : Promise.reject(new Error('请输入 MP_WXS_ 编号或含 __biz 的文章长链接')) }]}>
                <Input placeholder="MP_WXS_… 或含 __biz 的文章长链接" maxLength={1200} />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={Boolean(busy)} disabled={Boolean(busy)}>添加订阅</Button>
            </Form>
          </>}
      </Flex>
    </Modal>}
    {scanning && <WechatReadingScan close={() => setScanning(false)} onAuthorized={onAuthorized} />}
    {importing && <WechatArticleImport close={() => setImporting(false)} onImported={onImported} />}
  </Card>;
}
