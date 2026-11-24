import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Flex, Input, Modal, Space, Spin, Switch, Typography } from 'antd';
import { api } from '../../api/client';
import { displayDate } from '../../lib/displayDate';
import { useResource } from '../../lib/useResource';
import { WechatArticleImport } from './WechatOfferSources';

const path = '/api/offers/wechat-collection';
interface Account { id: string; name: string }
interface CollectionState {
  account: Account | null; authorized: boolean; enabled: boolean;
  expiresAt: string | null; lastSuccess: string | null; error: string | null; retryAfter: string | null;
}
interface Scan { id: string; image: string; expiresAt: number }
const notice = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';

function WechatScan({ onAuthorized, close }: { onAuthorized: () => void; close: () => void }) {
  const [scan, setScan] = useState<Scan>();
  const [waiting, setWaiting] = useState(false);
  const [status, setStatus] = useState('waiting');
  const [error, setError] = useState('');

  async function generate() {
    setWaiting(true);
    setError('');
    setScan(undefined);
    setStatus('waiting');
    try { setScan(await api.post<Scan>(`${path}/scan`)); }
    catch (error) { setError(notice(error)); }
    finally { setWaiting(false); }
  }

  useEffect(() => {
    if (!scan) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const response = scan.expiresAt <= Date.now() ? { status: 'expired' }
          : await api.post<{ status: 'waiting' | 'scanned' | 'authorized' | 'expired' }>(`${path}/scan/${scan.id}`);
        if (!active) return;
        setStatus(response.status);
        if (response.status === 'authorized') onAuthorized();
        else if (response.status !== 'expired') timer = setTimeout(() => void check(), 3000);
      } catch (error) { if (active) setError(notice(error)); }
    };
    timer = setTimeout(() => void check(), 3000);
    return () => { active = false; clearTimeout(timer); };
  }, [scan, onAuthorized]);

  return <Modal open title="微信公众平台扫码授权" onCancel={close} footer={null}>
    <Flex vertical align="center" gap={12}>
      <Typography.Text>请用有公众号管理权限的微信扫码，登录你自己的公众号后台。授权后可在小管家里搜索并订阅其他公众号。</Typography.Text>
      {error && <Alert type="error" title={error} showIcon />}
      {scan && status !== 'expired' && !error && <>
        <img src={scan.image} alt="微信公众平台授权二维码" width={220} height={220} />
        <Typography.Text type="secondary">{status === 'scanned' ? '请在手机微信确认登录' : '等待扫码'}</Typography.Text>
      </>}
      {status === 'expired' && <Alert type="warning" title="二维码已过期，请重新获取" />}
      <Button onClick={() => void generate()} loading={waiting}>{scan || error ? '重新获取二维码' : '获取二维码'}</Button>
    </Flex>
  </Modal>;
}

export function WechatAutoSource({ onImported }: { onImported: () => void }) {
  const { message } = App.useApp();
  const { data, error, loading, refresh } = useResource<CollectionState>(path);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<Account[] | null>(null);
  const [busy, setBusy] = useState<'search' | 'sync' | 'save' | 'revoke'>();
  const retryAt = data?.retryAfter ? Date.parse(data.retryAfter) : 0;
  const rateLimited = retryAt > Date.now();

  useEffect(() => {
    const delay = retryAt - Date.now();
    if (!(delay > 0)) return;
    const timer = setTimeout(() => void refresh(), Math.min(delay + 100, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [data, retryAt, refresh]);

  async function search(input: string) {
    const q = input.trim();
    if (!q || busy || rateLimited) return;
    setBusy('search');
    setResults(null);
    try { setResults(await api.get<Account[]>(`${path}/accounts?${new URLSearchParams({ q })}`)); }
    catch (error) { message.error(notice(error)); await refresh(); }
    finally { setBusy(undefined); }
  }

  async function save(account: Account, enabled: boolean) {
    setBusy('save');
    try {
      await api.put(path, { account, enabled });
      setResults(null);
      await refresh();
      message.success('公众号订阅已保存');
    } catch (error) { message.error(notice(error)); }
    finally { setBusy(undefined); }
  }

  async function sync() {
    if (rateLimited) return;
    setBusy('sync');
    try {
      const result = await api.post<{ updated: number; missing: number }>(`${path}/refresh`);
      if (result.updated) {
        message.success(`已生成 ${result.updated} 条活动草稿，可在「维护活动」核对`);
        onImported();
      } else if (!result.missing) message.info('没有新的活动草稿');
    } catch (error) { message.error(notice(error)); }
    finally { await refresh(); setBusy(undefined); }
  }

  async function revoke() {
    setBusy('revoke');
    try {
      await api.delete(`${path}/authorization`);
      setResults(null);
      await refresh();
      message.success('已解除公众号授权');
    } catch (error) { message.error(notice(error)); }
    finally { setBusy(undefined); }
  }

  return <Card size="small" title="公众号自动采集" extra={<Button size="small" onClick={() => setImporting(true)}>导入公众号文章</Button>}>
    <Flex vertical gap={12}>
      {loading && !data && <Spin />}
      {error && <Alert type="error" title={error} />}
      {rateLimited ? <Alert type="warning" showIcon title="微信暂时限制了公众号请求"
        description={`可在 ${displayDate(data?.retryAfter, { time: true })} 后再试。等待期间可以手动导入文章。`} />
        : data?.error && <Alert type="warning" title={data.error} showIcon />}
      <Space wrap>
        <Button type={!data?.authorized ? 'primary' : 'default'} disabled={Boolean(busy)} onClick={() => setScanning(true)}>
          {data?.authorized ? '重新扫码' : '扫码授权'}
        </Button>
        {data?.authorized && <><Typography.Text type="success">已授权</Typography.Text>
          <Button type="link" loading={busy === 'revoke'} disabled={Boolean(busy)} onClick={() => void revoke()}>解除授权</Button>
        </>}
      </Space>
      {data?.authorized && <Input.Search aria-label="搜索公众号" placeholder="输入公众号名称，例如卡羊腿" enterButton="搜索公众号"
        maxLength={60} onSearch={(value) => void search(value)} loading={busy === 'search'}
        disabled={rateLimited || Boolean(busy && busy !== 'search')} />}
      {results && (results.length ? <Flex vertical gap={6}>{results.map((item) => <Flex key={item.id} justify="space-between" align="center" gap={8}>
        <Typography.Text>{item.name}</Typography.Text>
        <Button size="small" aria-label={`订阅 ${item.name}`} loading={busy === 'save'} disabled={Boolean(busy)}
          onClick={() => void save(item, true)}>订阅</Button>
      </Flex>)}</Flex> : <Typography.Text type="secondary">未找到该公众号</Typography.Text>)}
      {data?.account && <Flex vertical gap={6}>
        <Space wrap>
          <Typography.Text strong>{data.account.name}</Typography.Text>
          <Switch aria-label="公众号每日同步" checked={data.enabled} disabled={Boolean(busy)}
            onChange={(enabled) => void save(data.account!, enabled)} />
          <Typography.Text>每日同步</Typography.Text>
          <Button size="small" loading={busy === 'sync'} disabled={!data.authorized || rateLimited || Boolean(busy)} onClick={() => void sync()}>立即刷新</Button>
        </Space>
        <Typography.Text type="secondary">{data.lastSuccess ? `最近成功 ${displayDate(data.lastSuccess, { time: true })}` : '尚未同步'}</Typography.Text>
      </Flex>}
    </Flex>
    {scanning && <WechatScan close={() => setScanning(false)} onAuthorized={() => {
      setScanning(false); setResults(null); void refresh(); message.success('微信授权成功');
    }} />}
    {importing && <WechatArticleImport close={() => setImporting(false)} onImported={onImported} />}
  </Card>;
}
