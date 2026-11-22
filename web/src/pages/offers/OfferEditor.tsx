import { useRef, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, Form, Input, InputNumber, Modal, Select, Space } from 'antd';
import { api } from '../../api/client';
import type { CardSpendProgressResponse } from '../../api/types';
import { cardDisplayLabel } from '../../lib/cardDisplay';
import { useResource } from '../../lib/useResource';
import { discountTypes, networkOptions, paymentChannels } from './types';
import type { CatalogOffer, OfferCard, OfferRule } from './types';

const optionalText = ['bankName', 'product', 'network', 'startsOn', 'endsOn', 'startsAt', 'endsAt', 'claimOn', 'claimAt',
  'cycle', 'spendRuleId', 'entry', 'sourceUrl', 'sourceText', 'stacking'] as const;
const options = (labels: Record<string, string>) => Object.entries(labels).map(([value, label]) => ({ value, label }));
const numbers = { style: { width: '100%' }, min: 0, max: 999_999, precision: 2 };
const separate = (value?: string) => value?.split(/[，,、\n]/).map((part) => part.trim()).filter(Boolean) ?? [];

type OfferDraft = Omit<OfferRule, 'merchants' | 'cities' | 'stores'> & { merchants?: string; cities?: string; stores?: string };

export function OfferEditor({ offer, kind, merchant, cards, library, close, afterSave }: {
  offer?: CatalogOffer; kind: OfferRule['kind']; merchant?: string; cards: OfferCard[]; library: CatalogOffer[];
  close: () => void; afterSave: (kind: OfferRule['kind']) => void;
}) {
  const [form] = Form.useForm<OfferDraft>();
  const selectedKind = Form.useWatch('kind', form) ?? kind;
  const discount = Form.useWatch(['discount', 'type'], form) ?? offer?.rule.discount.type ?? 'fixed';
  const cardIds = Form.useWatch('cardIds', form) ?? [];
  const tracks = useResource<CardSpendProgressResponse>(cardIds.length === 1 ? `/api/cards/${cardIds[0]}/spend-progress` : null).data?.tracks ?? [];
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [ocrNote, setOcrNote] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  async function save(values: OfferDraft, review: 'ready' | 'draft') {
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError('');
    try {
      const rule = { ...values, merchants: separate(values.merchants), cities: separate(values.cities), stores: separate(values.stores) };
      for (const key of optionalText) if (!rule[key]) delete rule[key];
      if (rule.threshold == null) delete rule.threshold;
      if (rule.totalUses == null) delete rule.totalUses;
      rule.discount = Object.fromEntries(Object.entries(rule.discount ?? { type: 'service' }).filter(([, value]) => value != null)) as OfferRule['discount'];
      const { discount } = rule;
      const incompleteDiscount = ((discount.type === 'fixed' || discount.type === 'points') && !discount.amount)
        || (discount.type === 'points' && (!discount.cost || !discount.unit)) || (discount.type === 'random' && !discount.max)
        || ((discount.type === 'percent' || discount.type === 'cashback') && !discount.rate);
      if (review === 'draft' && incompleteDiscount) rule.discount = { type: 'service' };
      if (rule.discount.type !== 'fixed') rule.stackWith = [];
      const body = { rule, review };
      if (offer) await api.put(`/api/offers/${offer.id}`, body);
      else await api.post('/api/offers', body);
      afterSave(rule.kind);
      close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败'); }
    finally { submitting.current = false; setSaving(false); }
  }

  async function ocr(image?: File) {
    if (!image || reading) return;
    setReading(true);
    setError('');
    try {
      const result = await api.upload<Pick<OfferRule, 'sourceText' | 'threshold' | 'discount'>>('/api/offers/screenshot-draft', image, image.type);
      form.setFieldsValue(result);
      setOcrNote(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '截图识别失败'); }
    finally { setReading(false); }
  }

  const current = offer?.rule;
  return (
    <Modal open title={offer ? '编辑权益与活动' : '新增权益或活动'} footer={null} onCancel={close} width={760}>
      <Form<OfferDraft> layout="vertical" form={form} onFinish={(value) => void save(value, 'ready')}
        initialValues={current ? { ...current, merchants: current.merchants.join('、'), cities: current.cities.join('、'), stores: current.stores.join('、') }
          : { kind, merchants: merchant, discount: { type: 'fixed' }, cardIds: [], channels: [], weekdays: [] }}>
        <Space wrap className="offers-form-toolbar">
          <Button loading={reading} onClick={() => file.current?.click()}>上传活动截图</Button>
          <input type="file" hidden ref={file} accept="image/png,image/jpeg" onChange={(event) => {
            void ocr(event.currentTarget.files?.[0]); event.currentTarget.value = '';
          }} />
        </Space>
        {ocrNote && <Alert type="info" title="已填入识别结果，请对照截图补齐商户、资格和有效期。" />}
        <div className="offers-field-grid">
          <Form.Item name="title" label="名称" rules={[{ required: true, message: '请输入活动名称' }]}><Input maxLength={120} /></Form.Item>
          <Form.Item name="kind" label="类型"><Select options={options({ activity: '限时活动', benefit: '卡片权益' })} /></Form.Item>
          <Form.Item name="merchants" label="商户" extra="多个商户用顿号分隔"><Input placeholder="如 海底捞、奈雪" /></Form.Item>
          <Form.Item name="cardIds" label="适用卡片">
            <Select mode="multiple" optionFilterProp="label" options={cards.map((card) => ({ value: card.id, label: cardDisplayLabel(card) }))} />
          </Form.Item>
          <Form.Item name={['discount', 'type']} label="优惠方式"><Select options={options(discountTypes)} /></Form.Item>
          <Form.Item name="threshold" label="单笔消费门槛（元）"><InputNumber {...numbers} /></Form.Item>
          {(discount === 'fixed' || discount === 'points') && (
            <Form.Item name={['discount', 'amount']} label="可抵扣金额（元）"><InputNumber {...numbers} /></Form.Item>
          )}
          {(discount === 'percent' || discount === 'cashback') && <>
            <Form.Item name={['discount', 'rate']} label={discount === 'cashback' ? '返现比例（%）' : '减免比例（%）'}
              extra={discount === 'percent' ? '五折填写 50' : undefined}><InputNumber {...numbers} max={100} /></Form.Item>
            <Form.Item name={['discount', 'cap']} label="最高金额（元）"><InputNumber {...numbers} /></Form.Item>
          </>}
          {discount === 'random' && <>
            <Form.Item name={['discount', 'min']} label="随机立减下限（元）"><InputNumber {...numbers} /></Form.Item>
            <Form.Item name={['discount', 'max']} label="随机立减上限（元）"><InputNumber {...numbers} /></Form.Item>
          </>}
          {discount === 'points' && <>
            <Form.Item name={['discount', 'unit']} label="兑换单位"><Select options={['积分', 'UP金'].map((value) => ({ value, label: value }))} /></Form.Item>
            <Form.Item name={['discount', 'cost']} label="兑换用量"><InputNumber {...numbers} precision={0} max={100_000_000} /></Form.Item>
            <Form.Item name={['discount', 'purchasePrice']} label="领券另付金额（元）"><InputNumber {...numbers} /></Form.Item>
          </>}
          <Form.Item name="channels" label="支付方式"><Select mode="multiple" options={options(paymentChannels)} /></Form.Item>
          <Form.Item name="sourceUrl" label="活动原文链接"><Input placeholder="https://" maxLength={600} /></Form.Item>
          <Form.Item className="offers-field-wide" name="entry" label="领取 / 使用路径"><Input.TextArea autoSize maxLength={300} /></Form.Item>
        </div>
        <Collapse size="small" items={[{ key: 'conditions', label: '日期、门店和资格', forceRender: true,
          children: <div className="offers-field-grid">
            <Form.Item name="bankName" label="发卡行"><Input maxLength={40} /></Form.Item>
            <Form.Item name="product" label="指定卡产品"><Input maxLength={80} placeholder="填写卡片资料中的产品名称" /></Form.Item>
            <Form.Item name="network" label="卡组织"><Select allowClear options={networkOptions.map((value) => ({ value, label: value }))} /></Form.Item>
            <Form.Item name="cities" label="适用城市"><Input placeholder="如 北京、上海" /></Form.Item>
            <Form.Item name="stores" label="适用门店"><Input placeholder="多个门店用顿号分隔" /></Form.Item>
            <Form.Item name="weekdays" label="适用星期">
              <Select mode="multiple" options={'一二三四五六日'.split('').map((day, index) => ({ value: index + 1, label: `周${day}` }))} />
            </Form.Item>
            <Form.Item name="startsOn" label="有效期开始"><Input type="date" /></Form.Item>
            <Form.Item name="endsOn" label="有效期截止"><Input type="date" /></Form.Item>
            <Form.Item name="startsAt" label="可用起始时刻"><Input type="time" /></Form.Item>
            <Form.Item name="endsAt" label="可用截止时刻"><Input type="time" /></Form.Item>
            <Form.Item name="claimOn" label="领券日期"><Input type="date" /></Form.Item>
            <Form.Item name="claimAt" label="开抢时刻"><Input type="time" /></Form.Item>
            {selectedKind === 'benefit' && <>
              <Form.Item name="cycle" label="发放周期"><Select allowClear options={options({ month: '每月', year: '每年', once: '一次' })} /></Form.Item>
              <Form.Item name="totalUses" label="每周期次数"><InputNumber {...numbers} precision={0} /></Form.Item>
            </>}
            <Form.Item name="spendRuleId" label="关联消费跟踪" className="offers-field-wide"
              extra={cardIds.length !== 1 ? '选定一张适用卡后可选择该卡的消费跟踪规则' : undefined}>
              <Select allowClear disabled={cardIds.length !== 1}
                options={tracks.map(({ rule }) => ({ value: rule.id, label: rule.name }))} />
            </Form.Item>
            <Form.Item name="requiresClaim" valuePropName="checked"><Checkbox>需要领券</Checkbox></Form.Item>
            <Form.Item name="requiresRegistration" valuePropName="checked"><Checkbox>需要先报名</Checkbox></Form.Item>
            <Form.Item name="needsEligibility" valuePropName="checked"><Checkbox>需要确认受邀或达标资格</Checkbox></Form.Item>
            <Form.Item name="limited" valuePropName="checked"><Checkbox>限量，付款前需核对</Checkbox></Form.Item>
            <Form.Item className="offers-field-wide" name="stacking" label="叠加规则或限制"><Input.TextArea autoSize maxLength={250} /></Form.Item>
            {discount === 'fixed' && <Form.Item className="offers-field-wide" name="stackWith" label="确认可同单叠加的固定立减"
              extra="仅选择已核对能同时使用的优惠，双方门槛均按原订单金额计算。">
              <Select mode="multiple" optionFilterProp="label" options={library.filter((item) => item.id !== offer?.id
                && (item.review === 'ready' || current?.stackWith?.includes(item.id)) && item.rule.discount.type === 'fixed')
                .map((item) => ({ value: item.id, label: item.rule.title }))} />
            </Form.Item>}
          </div>,
        }, { key: 'source', label: '活动原文', forceRender: true, children: (
          <Form.Item name="sourceText" label="规则原文"><Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} maxLength={8000} /></Form.Item>
        ) }]} />
        {error && <Alert type="error" className="offers-form-feedback" title={error} />}
        <Space wrap className="offers-form-feedback">
          <Button type="primary" htmlType="submit" loading={saving}>保存并参与查询</Button>
          <Button disabled={saving} onClick={() => void form.validateFields().then((value) => save(value, 'draft')).catch(() => undefined)}>保存草稿</Button>
          <Button onClick={close}>取消</Button>
        </Space>
      </Form>
    </Modal>
  );
}
