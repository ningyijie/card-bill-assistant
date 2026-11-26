import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Flex, Input, Modal, QRCode, Select, Space, Switch, Typography } from 'antd';
import { api } from '../../api/client';
import { displayDate } from '../../lib/displayDate';
import { useResource } from '../../lib/useResource';

const path = '/api/offers/weread-collection';
const notice = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const frequencies = [
  { value: 24, label: '每天一次' },
  { value: 12, label: '每 12 小时' },
  { value: 6, label: '每 6 小时' },
  { value: 3, label: '每 3 小时' },
  { value: 1, label: '每小时' },
];

interface Scan { id: string; qrUrl: string; expiresAt: number }
interface ScanResult { status: 'waiting' | 'scanned' | 'otp' | 'expired' | 'authorized'; rejected?: boolean }
interface Account { id: string; name: string }
interface CollectionState {
  authorized: boolean; account: Account | null; suggestedAccount: Account; enabled: boolean; syncHours: number;
  lastSuccess: string | null; retryAfter: string | null; error: string | null;
}
interface SyncCounts { discovered: number; updated: number; skipped: number; missing: number }
interface SyncResult extends SyncCounts { supplement?: SyncCounts }

function WereadScan({ close, onAuthorized }: { close: () => void; onAuthorized: () => void }) {
  const [scan, setScan] = useState<Scan>();
  const [result, setResult] = useState<ScanResult>({ status: 'waiting' });
  const [busy, setBusy] = useState(false);
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');

  async function generate() {
    setBusy(true);
    setError('');
    setOtp('');
    setScan(undefined);
    setResult({ status: 'waiting' });
    try { setScan(await api.post<Scan>(path + '/scan')); }
    catch (error) { setError(notice(error)); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!scan || !['waiting', 'scanned'].includes(result.status)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const next = scan.expiresAt <= Date.now() ? { status: 'expired' } as const
          : await api.post<ScanResult>(path + '/scan/' + scan.id, undefined, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setResult(next);
        if (next.status === 'authorized') onAuthorized();
        if (next.status === result.status) timer = setTimeout(() => void check(), 3000);
      } catch (error) {
        if (!controller.signal.aborted) setError(notice(error));
      }
    };
    timer = setTimeout(() => void check(), 3000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [scan, result.status, onAuthorized]);

  async function submitOtp() {
    if (!scan || !/^\d{4,8}$/.test(otp) || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.post<ScanResult>(path + '/scan/' + scan.id, { otp });
      setResult(next);
      if (next.status === 'authorized') onAuthorized();
    } catch (error) { setError(notice(error)); }
    finally { setBusy(false); }
  }

  return <Modal open title="微信读书扫码授权" footer={null} onCancel={close}>
    <Flex vertical align="center" gap={12}>
      <Typography.Text>用手机微信扫一扫，在手机上确认登录微信读书。</Typography.Text>
      {error && <Alert type="error" showIcon title={error} />}
      {scan && result.status !== 'expired' && !error && <QRCode value={scan.qrUrl} size={220} />}
      {result.status === 'scanned' && <Typography.Text type="secondary">请在手机微信确认登录</Typography.Text>}
      {result.status === 'expired' && <Alert type="warning" showIcon title="二维码已过期，请重新获取" />}
      {result.status === 'otp' && <Flex vertical gap={8}>
        <Typography.Text>微信要求二次验证，请输入手机微信显示的验证码。</Typography.Text>
        <Space>
          <Input aria-label="微信读书验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={8}
            value={otp} status={result.rejected ? 'error' : undefined}
            onChange={(event) => setOtp(event.target.value.replace(/\D/g, ''))} onPressEnter={() => void submitOtp()} />
          <Button type="primary" loading={busy} disabled={!/^\d{4,8}$/.test(otp)} onClick={() => void submitOtp()}>提交验证码</Button>
        </Space>
        {result.rejected && <Typography.Text type="danger">验证未通过，请核对手机上显示的验证码。</Typography.Text>}
      </Flex>}
      <Button disabled={busy} loading={busy && result.status !== 'otp'} onClick={() => void generate()}>
        {scan || error ? '重新获取二维码' : '获取二维码'}
      </Button>
    </Flex>
  </Modal>;
}

export function WechatReadingSource({ onImported }: { onImported: () => void }) {
  const { message } = App.useApp();
  const { data, error, refresh } = useResource<CollectionState>(path);
  const [scanning, setScanning] = useState(false);
  const [bookId, setBookId] = useState('');
  const [busy, setBusy] = useState<'save' | 'refresh' | 'revoke'>();
  const [result, setResult] = useState<SyncResult>();
  const retryAt = data?.retryAfter ? Date.parse(data.retryAfter) : 0;
  const coolingDown = retryAt > Date.now();
  const onAuthorized = useCallback(() => {
    setScanning(false);
    void refresh();
    message.success('微信读书授权成功');
  }, [message, refresh]);

  useEffect(() => {
    const delay = retryAt - Date.now();
    if (!(delay > 0)) return;
    const timer = setTimeout(() => void refresh(), Math.min(delay + 100, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [retryAt, refresh]);

  async function save(id: string, enabled: boolean, syncHours?: number) {
    setBusy('save');
    try {
      await api.put(path, { bookId: id, enabled, syncHours });
      if (id !== data?.account?.id) setResult(undefined);
      setBookId('');
      await refresh();
      message.success('已保存');
    } catch (error) { message.error(notice(error)); }
    finally { setBusy(undefined); }
  }

  async function sync() {
    setBusy('refresh');
    setResult(undefined);
    try {
      const next = await api.post<SyncResult>(path + '/refresh');
      setResult(next);
      if (next.updated || next.supplement?.updated) onImported();
    } catch (error) { message.error(notice(error)); }
    finally { await refresh(); setBusy(undefined); }
  }

  async function revoke() {
    setBusy('revoke');
    try { await api.delete(path + '/authorization'); await refresh(); }
    catch (error) { message.error(notice(error)); }
    finally { setBusy(undefined); }
  }

  return <Card size="small" title="微信读书（试用）">
    <Flex vertical gap={12}>
      {error && <Alert type="error" title={error} showIcon />}
      {data?.error && <Alert type="warning" showIcon title={data.error}
        description={coolingDown ? '可在 ' + displayDate(data.retryAfter, { time: true }) + ' 后再试。' : undefined} />}
      <Space wrap>
        <Button type={data?.authorized ? 'default' : 'primary'} disabled={Boolean(busy)} onClick={() => setScanning(true)}>
          {data?.authorized ? '重新扫码' : '扫码授权'}
        </Button>
        {data?.authorized && <>
          <Typography.Text type="success">微信读书已授权</Typography.Text>
          <Button type="link" loading={busy === 'revoke'} disabled={Boolean(busy)} onClick={() => void revoke()}>解除授权</Button>
        </>}
      </Space>
      {data?.authorized && <Space wrap>
        {data.account?.id !== data.suggestedAccount.id &&
          <Button disabled={Boolean(busy)} onClick={() => void save(data.suggestedAccount.id, data.account ? data.enabled : true)}>
            订阅{data.suggestedAccount.name}
          </Button>}
        <Input.Search aria-label="微信读书公众号编号" placeholder="其他公众号编号 MP_WXS_…" enterButton="保存" maxLength={27}
          value={bookId} onChange={(event) => setBookId(event.target.value)} disabled={Boolean(busy)}
          onSearch={(value) => { if (value.trim()) void save(value.trim(), data.account ? data.enabled : true); }} />
      </Space>}
      {data?.account && <Flex vertical gap={6}>
        <Space wrap>
          <Typography.Text strong>{data.account.name}</Typography.Text>
          <Switch aria-label="微信读书自动同步" checked={data.enabled} disabled={Boolean(busy) || !data.authorized}
            onChange={(enabled) => void save(data.account!.id, enabled)} />
          <Typography.Text>自动同步</Typography.Text>
          <Select aria-label="微信读书同步频率" value={data.syncHours ?? 24} options={frequencies}
            disabled={Boolean(busy) || !data.authorized} style={{ minWidth: 122 }}
            onChange={(syncHours) => void save(data.account!.id, data.enabled, syncHours)} />
          <Button size="small" disabled={Boolean(busy) || !data.authorized || coolingDown}
            loading={busy === 'refresh'} onClick={() => void sync()}>立即刷新</Button>
        </Space>
        <Typography.Text type="secondary">
          {data.lastSuccess ? '最近成功 ' + displayDate(data.lastSuccess, { time: true }) : '尚未同步'}
        </Typography.Text>
      </Flex>}
      {result && <Typography.Text>
        发现 {result.discovered} 篇文章，生成 {result.updated} 条草稿，跳过 {result.skipped} 篇，{result.missing} 篇正文未取得。
      </Typography.Text>}
      {result?.supplement && <Typography.Text type="secondary">
        公众号来源另外检查了 {result.supplement.discovered} 篇，生成 {result.supplement.updated} 条草稿，
        跳过 {result.supplement.skipped} 篇，{result.supplement.missing} 篇正文未取得。
      </Typography.Text>}
      {scanning && <WereadScan close={() => setScanning(false)} onAuthorized={onAuthorized} />}
    </Flex>
  </Card>;
}
