import { useEffect, useState } from 'react';
import { Alert, App, Button, Flex, Form, Input, Modal, Space, Spin, Switch, Typography, Upload } from 'antd';
import { api } from '../../api/client';
import { displayDate } from '../../lib/displayDate';
import { useResource } from '../../lib/useResource';

const feedPath = '/api/offers/werss';
interface FeedSettings { url: string; enabled: boolean }
interface FeedState extends FeedSettings { lastSuccess: string | null; lastAttempt: string | null; error: string | null }
interface ImportForm { url: string; title?: string; text?: string }
interface ImportResult { updated: number; skipped: number; needsContent: boolean }

const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试';

export function WechatArticleImport({ close, onImported, initial }: { close: () => void; onImported: () => void; initial?: ImportForm }) {
  const [form] = Form.useForm<ImportForm>();
  const [busy, setBusy] = useState(false);
  const [ocr, setOcr] = useState(false);
  const [paste, setPaste] = useState(Boolean(initial));
  const [notice, setNotice] = useState('');
  const { message } = App.useApp();

  async function submit() {
    const values = await form.validateFields().catch(() => undefined);
    if (!values) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await api.post<ImportResult>('/api/offers/wechat-article', { ...values, text: values.text?.trim() || undefined });
      if (result.needsContent) {
        setPaste(true);
        setNotice('暂时读不到正文。链接已保留，可以粘贴正文或用截图识别后再导入。');
        return;
      }
      message.success(result.updated ? `已生成 ${result.updated} 条活动草稿` : '这篇文章已处理，或没有可生成的草稿');
      onImported();
      close();
    } catch (error) { setNotice(errorText(error)); }
    finally { setBusy(false); }
  }

  async function readScreenshot(file: File) {
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      setNotice('请选择 PNG 或 JPEG 活动截图');
      return;
    }
    setPaste(true);
    setOcr(true);
    setNotice('');
    try {
      const { sourceText } = await api.upload<{ sourceText: string }>('/api/offers/screenshot-draft', file, file.type);
      const prior = form.getFieldValue('text');
      form.setFieldValue('text', [prior, sourceText].filter(Boolean).join('\n').slice(0, 24000));
    } catch (error) { setNotice(errorText(error)); }
    finally { setOcr(false); }
  }

  return <Modal open title="导入公众号文章" onCancel={close} onOk={() => void submit()}
    okText={paste ? '生成活动草稿' : '读取文章'} confirmLoading={busy} okButtonProps={{ disabled: ocr }} cancelButtonProps={{ disabled: busy || ocr }}
    closable={!busy && !ocr} mask={{ closable: false }}>
    <Form form={form} name="wechatArticle" layout="vertical" initialValues={initial} disabled={busy || ocr}>
      <Form.Item name="url" label="微信文章链接" rules={[{ required: true, whitespace: true, message: '请输入微信文章链接' }]}>
        <Input maxLength={600} placeholder="https://mp.weixin.qq.com/s/…" />
      </Form.Item>
      {notice && <Alert type="warning" showIcon title={notice} style={{ marginBottom: 12 }} />}
      <Space wrap style={{ marginBottom: 12 }}>
        {!paste && <Button onClick={() => setPaste(true)}>粘贴正文</Button>}
        <Upload accept="image/png,image/jpeg" showUploadList={false} disabled={busy || ocr}
          beforeUpload={(file) => { void readScreenshot(file); return Upload.LIST_IGNORE; }}>
          <Button loading={ocr}>识别截图</Button>
        </Upload>
      </Space>
      {paste && <>
        <Form.Item name="title" label="文章标题（可选）"><Input maxLength={120} /></Form.Item>
        <Form.Item name="text" label="文章正文" rules={[{ required: true, whitespace: true, message: '请粘贴正文或上传截图' }]}>
          <Input.TextArea rows={7} maxLength={24000} />
        </Form.Item>
      </>}
    </Form>
  </Modal>;
}

export function WechatOfferSources({ onImported }: { onImported: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<FeedSettings>();
  const { data, loading, error, refresh } = useResource<FeedState>(feedPath);
  const [busy, setBusy] = useState<'save' | 'sync'>();
  useEffect(() => {
    if (data) form.setFieldsValue({ url: data.url, enabled: data.enabled || !data.url });
  }, [data, form]);

  async function save(values: FeedSettings) {
    setBusy('save');
    try {
      await api.put(feedPath, { url: values.url.trim(), enabled: values.enabled });
      await refresh();
      message.success('已保存 WeRSS 订阅设置');
    } catch (error) { message.error(errorText(error)); }
    finally { setBusy(undefined); }
  }

  async function sync() {
    setBusy('sync');
    try {
      const result = await api.post<{ updated: number; skipped: number; missing: number }>(`${feedPath}/refresh`);
      if (result.updated) {
        message.success(`已生成 ${result.updated} 条活动草稿，可在「维护活动」核对`);
        onImported();
      } else if (!result.missing) message.info('没有新的活动草稿');
    } catch (error) { message.error(errorText(error)); }
    finally { await refresh(); setBusy(undefined); }
  }

  return <Flex vertical gap={10}>
      {error && <Alert type="error" title={error} />}
      {data?.error && <Alert type="warning" showIcon title={data.error} />}
      {loading && !data && <Spin />}
      <Form form={form} name="wechatFeed" layout="vertical" initialValues={{ enabled: true }} onFinish={(values) => void save(values)}>
        <Form.Item name="url" label="公众号 RSS 地址" rules={[{ required: true, whitespace: true, message: '请填写公众号的 RSS 地址' }]}
          extra="在 WeRSS 文章列表选中公众号，再点「订阅 → RSS」复制地址。请使用 NAS 局域网 IP。">
          <Input maxLength={191} placeholder="http://NAS局域网IP:8001/feed/MP_WXS_数字.rss" disabled={!data || Boolean(busy)} />
        </Form.Item>
        <Space wrap>
          <Form.Item name="enabled" valuePropName="checked" noStyle><Switch aria-label="WeRSS 每日同步" disabled={!data || Boolean(busy)} /></Form.Item>
          <Typography.Text>每日同步</Typography.Text>
          <Button htmlType="submit" loading={busy === 'save'} disabled={!data || Boolean(busy)}>保存订阅</Button>
          <Button loading={busy === 'sync'} disabled={!data?.url || Boolean(busy)} onClick={() => void sync()}>立即刷新</Button>
        </Space>
      </Form>
      <Typography.Text type="secondary">
        {data?.lastSuccess ? `最近成功 ${displayDate(data.lastSuccess, { time: true })}` : '尚未同步'}
        {data?.url && <> · <a href={new URL(data.url).origin} target="_blank" rel="noreferrer">打开 WeRSS</a></>}
      </Typography.Text>
  </Flex>;
}
