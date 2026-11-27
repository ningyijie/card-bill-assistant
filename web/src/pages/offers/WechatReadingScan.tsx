import { useEffect, useState } from 'react';
import { Alert, Button, Flex, Input, Modal, QRCode, Space, Typography } from 'antd';
import { api } from '../../api/client';

const path = '/api/offers/weread-collection';
const notice = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
interface Scan { id: string; qrUrl: string; expiresAt: number }
interface ScanResult { status: 'waiting' | 'scanned' | 'otp' | 'expired' | 'authorized'; rejected?: boolean }
export function WechatReadingScan({ close, onAuthorized }: { close: () => void; onAuthorized: () => void }) {
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
