import { Col, Form, Input, InputNumber, Row, Select } from 'antd';
import { cardNetworks } from '../../api/types';
import type { CardRewardProfile } from '../../api/types';

export type CardRewardFormValues = { [Field in keyof CardRewardProfile]: CardRewardProfile[Field] | null };

export function normalizedCardRewardProfile(values?: CardRewardFormValues): CardRewardProfile {
  return {
    product: values?.product?.trim() || undefined,
    network: values?.network ?? undefined,
    points: values?.points ?? undefined,
    upGold: values?.upGold ?? undefined,
    valuePer1000Points: values?.valuePer1000Points ?? undefined,
    valuePer1000UpGold: values?.valuePer1000UpGold ?? undefined,
  };
}

const networks = cardNetworks.map((value) => ({ value, label: value }));
const numericFields = [
  { name: 'points', label: '当前积分（优惠兑换）', precision: 0, max: 100_000_000 },
  { name: 'upGold', label: '当前 UP 金', precision: 0, max: 100_000_000 },
  { name: 'valuePer1000Points', label: '每千积分估值（元）', precision: 2, max: 999_999 },
  { name: 'valuePer1000UpGold', label: '每千 UP 金估值（元）', precision: 2, max: 999_999 },
] as const;

export function CardRewardFields() {
  return <Row gutter={[24, 0]}>
    <Col xs={24} md={12}>
      <Form.Item name={['rewardProfile', 'product']} label="卡产品名称" tooltip="用于匹配指定卡种的优惠">
        <Input maxLength={80} placeholder="如：华夏 UP" />
      </Form.Item>
    </Col>
    <Col xs={24} md={12}>
      <Form.Item name={['rewardProfile', 'network']} label="卡组织">
        <Select allowClear options={networks} placeholder="如：万事达" />
      </Form.Item>
    </Col>
    {numericFields.map(({ name, label, precision, max }) => <Col key={name} xs={24} md={12}>
      <Form.Item name={['rewardProfile', name]} label={label}>
        <InputNumber min={0} max={max} precision={precision} style={{ width: '100%' }} />
      </Form.Item>
    </Col>)}
  </Row>;
}
