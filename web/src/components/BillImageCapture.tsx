import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Collapse, Flex, Form, Input, InputNumber, Modal, Select, Space, Spin, Tag, Typography } from 'antd';
import { api } from '../api/client';
import type { CardRow } from '../api/types';
import { notifyDataChanged } from '../lib/dataChanged';
import { cardDisplayLabel } from '../lib/cardDisplay';
import './bill-image-capture.css';

interface Transaction { date: string; description: string; amount: number }
interface CapturePage {
  index: number;
  name: string;
  fields: Partial<{
    bankName: string; tail: string; period: string; statementDate: string; dueDate: string; currency: string;
    amount: number; minAmount: number;
  }>;
  transactions: Transaction[];
  duplicateOf?: number;
  error?: string;
}
interface Capture { status: 'processing' | 'ready'; total: number; pages: CapturePage[] }
interface DraftValues {
  cardId?: number;
  statementDate?: string;
  dueDate?: string;
  currency?: string;
  amount?: number;
  minAmount?: number | null;
  transactions?: Transaction[];
}

function common<T extends string | number>(values: (T | undefined)[]): T | undefined {
  const known = [...new Set(values.filter((value): value is T => value !== undefined))];
  return known.length === 1 ? known[0] : undefined;
}

function createDrafts(pages: CapturePage[], cards: CardRow[]) {
  const groups = new Map<string, { cardId?: number; pages: CapturePage[] }>();
  for (const page of pages) {
    if (page.duplicateOf !== undefined) continue;
    const tail = page.fields.tail;
    const matches = tail ? cards.filter((card) =>
      (card.cardLast4 === tail || card.displayLast4 === tail)
      && (!page.fields.bankName || card.bankName.replace(/^中国/, '') === page.fields.bankName.replace(/^中国/, '')),
    ) : [];
    const cardId = matches.length === 1 ? matches[0].id : undefined;
    const { period, currency } = page.fields;
    const key = cardId && period && currency ? `${cardId}:${period}:${currency}` : `page:${page.index}`;
    const group = groups.get(key) ?? { cardId, pages: [] };
    group.pages.push(page);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const fields = group.pages.map((page) => page.fields);
    return {
      key, indexes: group.pages.map((page) => page.index),
      fields: {
        cardId: group.cardId,
        statementDate: common(fields.map((row) => row.statementDate)),
        dueDate: common(fields.map((row) => row.dueDate)),
        amount: common(fields.map((row) => row.amount)),
        minAmount: common(fields.map((row) => row.minAmount)),
        currency: common(fields.map((row) => row.currency)),
      },
    };
  });
}

function screenshotDateKey(date: string, statementDate?: string) {
  const shortDate = date.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (!shortDate) return date;
  const suffix = shortDate.slice(1).map((part) => part.padStart(2, '0')).join('-');
  if (!statementDate || !/^\d{4}-\d{2}-\d{2}$/.test(statementDate)) return suffix;
  const year = Number(statementDate.slice(0, 4));
  const candidate = `${year}-${suffix}`;
  return candidate <= statementDate ? candidate : `${year - 1}-${suffix}`;
}

function suggestedTransactions(pages: CapturePage[], statementDate?: string) {
  const transactions: Transaction[] = [];
  const counts = new Map<string, number>();
  let overlaps = 0;
  for (const page of pages) {
    const pageCounts = new Map<string, number>();
    for (const row of page.transactions) {
      const key = JSON.stringify([
        screenshotDateKey(row.date, statementDate),
        row.description.normalize('NFKC').replace(/\s/g, '').toLowerCase(),
        Math.round(row.amount * 100),
      ]);
      const count = (pageCounts.get(key) ?? 0) + 1;
      pageCounts.set(key, count);
      if (count <= (counts.get(key) ?? 0)) { overlaps++; continue; }
      counts.set(key, count);
      transactions.push(row);
    }
  }
  return { transactions, overlaps };
}

function DraftReview({ id, draft, pages, cards }: {
  id: string; draft: ReturnType<typeof createDrafts>[number]; pages: CapturePage[]; cards: CardRow[];
}) {
  const [form] = Form.useForm<DraftValues>();
  const [indexes, setIndexes] = useState(draft.indexes);
  const selected = pages.filter((page) => indexes.includes(page.index));
  const startingRows = suggestedTransactions(selected, draft.fields.statementDate);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string>();
  const [error, setError] = useState('');
  const lock = useRef(false);

  async function save(values: DraftValues) {
    if (lock.current) return;
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await api.post<{ status: 'created' | 'merged' | 'official'; duplicateTransactions?: number }>(
        `/api/bill-images/${id}/bills`, { ...values, minAmount: values.minAmount ?? null, transactions: values.transactions ?? [] },
      );
      setSaved(result.status === 'official' ? '已存在正式账单，跳过这份截图'
        : result.status === 'merged' ? `已合入现有账单，跳过 ${result.duplicateTransactions ?? 0} 笔重复明细` : '已保存截图账单');
      if (result.status !== 'official') notifyDataChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  const dateRules = [{ required: true, message: '请填写日期' }, { pattern: /^\d{4}-\d{2}-\d{2}$/, message: '请用 YYYY-MM-DD' }];
  return (
    <Card size="small" title={`截图 ${draft.indexes.join('、')}`}>
      {saved ? <Alert type="success" title={saved} /> : (
        <Form<DraftValues> form={form} layout="vertical" disabled={saving}
          initialValues={{ ...draft.fields, transactions: startingRows.transactions }} onFinish={(values) => void save(values)}>
          <Form.Item label="合入这份账单的截图" htmlFor={`capture-${draft.key}`} extra="更改所选截图会重新填入交易明细。">
            <Select id={`capture-${draft.key}`} mode="multiple" value={indexes}
              options={pages.filter((page) => page.duplicateOf === undefined).map((page) => ({
                value: page.index, label: `第 ${page.index} 张 · ${page.name}`,
              }))}
              onChange={(values: number[]) => {
                setIndexes(values);
                const transactions = suggestedTransactions(
                  pages.filter((page) => values.includes(page.index)), form.getFieldValue('statementDate'),
                ).transactions;
                form.setFieldValue('transactions', transactions);
              }} />
          </Form.Item>
          <div className="capture-draft-fields">
            <Form.Item name="cardId" label="卡片" rules={[{ required: true, message: '请选择卡片' }]}>
              <Select showSearch optionFilterProp="label" options={cards.map((card) => ({
                value: card.id, label: cardDisplayLabel(card),
              }))} />
            </Form.Item>
            <Form.Item name="currency" label="币种" rules={[{ required: true }, { pattern: /^[a-z]{3}$/i, message: '填写三位币种代码' }]}>
              <Input maxLength={3} placeholder="CNY" />
            </Form.Item>
            <Form.Item name="statementDate" label="出账日" rules={dateRules}><Input placeholder="YYYY-MM-DD" /></Form.Item>
            <Form.Item name="dueDate" label="还款日" rules={dateRules}><Input placeholder="YYYY-MM-DD" /></Form.Item>
            <Form.Item name="amount" label="本期应还金额" rules={[{ required: true, message: '请填写应还金额' }]}>
              <InputNumber style={{ width: '100%' }} precision={2} />
            </Form.Item>
            <Form.Item name="minAmount" label="最低还款额"><InputNumber min={0} style={{ width: '100%' }} precision={2} /></Form.Item>
          </div>
          <Form.List name="transactions">
            {(rows, { add, remove }) => (
              <Collapse size="small" items={[{
                key: 'transactions', label: `交易明细（${rows.length} 笔）`, forceRender: true,
                children: <Flex vertical gap={6}>
                  {startingRows.overlaps > 0 && <Alert type="info" title={`已折叠 ${startingRows.overlaps} 笔疑似重叠明细，请和截图核对。`} />}
                  {rows.map((row) => <div className="capture-transaction" key={row.key}>
                    <Form.Item name={[row.name, 'date']} label="交易日期" rules={[{ required: true }]}>
                      <Input placeholder="YYYY-MM-DD" />
                    </Form.Item>
                    <Form.Item name={[row.name, 'description']} label="商户或说明" rules={[{ required: true }]}>
                      <Input maxLength={512} />
                    </Form.Item>
                    <Form.Item name={[row.name, 'amount']} label="金额" rules={[{ required: true }]}>
                      <InputNumber style={{ width: '100%' }} precision={2} />
                    </Form.Item>
                    <Button size="small" onClick={() => remove(row.name)}>移除</Button>
                  </div>)}
                  <Space wrap><Button size="small" onClick={() => add()}>添加一笔</Button>
                    {rows.length > 0 && <Button size="small" onClick={() => remove(rows.map((row) => row.name))}>只保存账单汇总</Button>}
                  </Space>
                </Flex>,
              }]} />
            )}
          </Form.List>
          {error && <Alert type="error" title={error} />}
          <Button style={{ marginTop: 12 }} type="primary" htmlType="submit" loading={saving}>保存这份账单</Button>
        </Form>
      )}
    </Card>
  );
}

function CaptureReview({ capture, id, cards }: { capture: Capture; id: string; cards: CardRow[] }) {
  const [drafts] = useState(() => createDrafts(capture.pages, cards));
  return <Flex vertical gap={12}>
    {capture.pages.filter((page) => page.error || page.duplicateOf !== undefined).map((page) => (
      <Alert key={page.index} type={page.error ? 'warning' : 'info'}
        title={`第 ${page.index} 张 · ${page.error ?? `和第 ${page.duplicateOf} 张相同，已跳过`}`} />
    ))}
    {drafts.map((draft) => <DraftReview key={draft.key} id={id} draft={draft} pages={capture.pages} cards={cards} />)}
  </Flex>;
}

export default function BillImageCapture({ id, cards, onCapture, onClose }: {
  id?: string; cards?: CardRow[]; onCapture: (id?: string) => void; onClose: () => void;
}) {
  const { message } = App.useApp();
  const [capture, setCapture] = useState<Capture>();
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [token, setToken] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);

  useEffect(() => {
    setCapture(undefined);
    setError('');
    if (!id) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const result = await api.get<Capture>(`/api/bill-images/${encodeURIComponent(id!)}`);
        if (!current) return;
        setCapture(result);
        if (result.status === 'processing') timer = setTimeout(() => void poll(), 1200);
      } catch (reason) {
        if (current) setError(reason instanceof Error ? reason.message : '读取识别结果失败');
      }
    }
    void poll();
    return () => { current = false; clearTimeout(timer); };
  }, [id]);

  async function send(files: File[]) {
    if (!files.length || sendingRef.current) return;
    if (files.length > 10 || files.reduce((sum, file) => sum + file.size, 0) >= 24 * 1024 * 1024) {
      setError('每批最多 10 张截图，总大小须小于 24 MB');
      return;
    }
    const form = new FormData();
    for (const file of files) form.append('images', file);
    sendingRef.current = true;
    setSending(true);
    setError('');
    try {
      const result = await api.uploadForm<{ id: string }>('/api/bill-images', form);
      onCapture(result.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '上传失败');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function changeKey(revoke: boolean) {
    setKeyBusy(true);
    try {
      if (revoke) {
        await api.delete('/api/bill-images/shortcut-key');
        setToken('');
        message.success('旧上传密钥已停用');
      } else {
        const result = await api.post<{ token: string }>('/api/bill-images/shortcut-key');
        setToken(result.token);
      }
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '更新密钥失败');
    } finally { setKeyBusy(false); }
  }

  return (
    <Modal open title="导入账单截图" width={760} onCancel={onClose} footer={null} destroyOnHidden>
      <Flex vertical gap={12} className="capture-modal-body">
        <input ref={input} type="file" accept="image/png,image/jpeg" multiple hidden onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          void send(files);
        }} />
        {!id && <>
          <Button type="primary" loading={sending} onClick={() => input.current?.click()}>选择截图</Button>
          <Typography.Text type="secondary">每批支持 10 张 PNG 或 JPEG，合计不超过 24 MB。</Typography.Text>
          <Collapse size="small" items={[{ key: 'shortcut', label: 'iPhone 快捷指令', children: <Flex vertical gap={8}>
            <Typography.Text>在快捷指令中启用分享菜单并接收图像。将所选截图制作成 ZIP 后，用「获取 URL 内容」发送 POST，请求正文选「文件」。</Typography.Text>
            <Input readOnly value={window.location.origin + '/api/bill-images/shortcut'} aria-label="快捷指令上传地址" onFocus={(event) => event.currentTarget.select()} />
            <Typography.Text>将请求头 Content-Type 设为 application/zip。Authorization 填 Bearer、一个空格，再填截图上传密钥。</Typography.Text>
            <Typography.Text>从返回的字典中取 reviewPath，拼到当前 NAS 的访问地址后，用「打开 URL」进入核对页。</Typography.Text>
            <Space wrap><Button loading={keyBusy} onClick={() => void changeKey(false)}>生成或重置密钥</Button>
              <Button disabled={keyBusy} onClick={() => void changeKey(true)}>停用密钥</Button></Space>
            {token && <Input readOnly value={token} aria-label="截图上传密钥" onFocus={(event) => event.currentTarget.select()} />}
          </Flex> }]} />
        </>}
        {error && <Alert type="error" title={error} action={id ? <Button size="small" onClick={() => onCapture()}>重新上传</Button> : undefined} />}
        {id && !error && (!capture || capture.status === 'processing') && (
          <Space><Spin size="small" /><Tag>{capture ? `已处理 ${capture.pages.length} / ${capture.total} 张` : '正在读取批次'}</Tag></Space>
        )}
        {id && capture?.status === 'ready' && (cards
          ? <CaptureReview key={id} capture={capture} id={id} cards={cards} />
          : <Spin description="正在读取卡片" />)}
      </Flex>
    </Modal>
  );
}
