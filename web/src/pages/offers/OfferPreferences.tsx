import { useRef, useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, InputNumber, Modal, Select } from 'antd';
import { api } from '../../api/client';
import type { OfferRecord } from './types';

function usePreferenceSave(close: () => void, saved: () => void) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (path: string, value: object) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api.put(path, Object.fromEntries(Object.entries(value).filter(([, item]) => item != null && item !== '')));
      saved();
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally { lock.current = false; setBusy(false); }
  };
  return { busy, error, save };
}

export interface RecordTarget { offerId: number; title: string; cardId: number; cardLabel: string; state?: OfferRecord | null }

export function OfferRecordEditor({ target, close, saved }: { target: RecordTarget; close: () => void; saved: () => void }) {
  const { busy, error, save } = usePreferenceSave(close, saved);
  return <Modal open title={`跟踪 · ${target.title}`} footer={null} onCancel={close}>
    <p>{target.cardLabel}</p>
    <Form layout="vertical" initialValues={target.state
      ? { ...target.state, eligible: target.state.eligible == null ? undefined : String(target.state.eligible) }
      : { favorite: true, status: 'tracked' }}
      onFinish={({ eligible, ...values }) => void save(`/api/offers/${target.offerId}/cards/${target.cardId}`, {
        ...values, eligible: eligible == null ? undefined : eligible === 'true',
      })}>
      <Form.Item name="favorite" valuePropName="checked"><Checkbox>收藏到我的活动</Checkbox></Form.Item>
      <div className="offers-field-grid">
        <Form.Item name="status" label="报名或领取状态"><Select options={[
          { value: 'tracked', label: '待报名或领取' }, { value: 'registered', label: '已报名' },
          { value: 'claimed', label: '已领取' }, { value: 'used', label: '已使用' },
        ]} /></Form.Item>
        <Form.Item name="eligible" label="银行资格"><Select allowClear placeholder="待核对"
          options={[{ value: 'true', label: '已确认符合' }, { value: 'false', label: '已确认不符合' }]} /></Form.Item>
        <Form.Item name="remaining" label="剩余次数"><InputNumber min={0} max={10_000} precision={0} style={{ width: '100%' }} /></Form.Item>
        <Form.Item name="voucherEndsOn" label="已领券到期日"><Input type="date" /></Form.Item>
        <Form.Item name="reminder" label="Bark 提醒" className="offers-field-wide">
          <Select allowClear placeholder="选择提醒" options={[
            { value: 'claim', label: '开抢当天' }, { value: 'expiry', label: '到期前 3 天' },
            { value: 'month_end', label: '月底核对关联消费进度' },
          ]} />
        </Form.Item>
      </div>
      {error && <Alert type="error" title={error} className="offers-form-feedback" />}
      <Button type="primary" htmlType="submit" loading={busy}>保存跟踪</Button>
    </Form>
  </Modal>;
}
