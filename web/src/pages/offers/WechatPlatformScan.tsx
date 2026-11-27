import { useEffect, useState } from 'react';
import { Alert, Button, Flex, Modal, Typography } from 'antd';
import { api } from '../../api/client';

const path = '/api/offers/wechat-collection';
interface Scan { id: string; image: string; expiresAt: number }
const notice = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';

export function WechatPlatformScan({ onAuthorized, close }: { onAuthorized: () => void; close: () => void }) {
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
