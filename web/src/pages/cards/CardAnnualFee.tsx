import { Button, Col, DatePicker, Form, Input, InputNumber, Row, Select, Typography } from 'antd';
import dayjs from 'dayjs';
import type { AnnualFeeSettlement, CardAnnualFeePolicy } from '../../api/types';
import { formatMoney } from '../../lib/money';

const charges = {
  annual: '按年收取',
  firstYearFree: '首年免，之后按年收取',
  free: '长期免年费',
  other: '其他收费方式',
} as const;

const waivers = {
  none: '无减免条件',
  count: '刷满次数免年费',
  points: '积分抵扣',
  either: '刷卡次数或积分（二选一）',
  other: '其他减免条件',
} as const;

export const annualFeeSettlementLabels: Record<AnnualFeeSettlement, string> = {
  automatic: '满足条件自动减免',
  automaticRefund: '先扣费，银行自动退回',
  apply: '先扣费，需申请退回',
  none: '不支持减免',
};

export async function validateAnnualFeePolicy(_: unknown, policy?: CardAnnualFeePolicy | null) {
  if (policy?.currency && !/^[A-Z]{3}$/.test(policy.currency)) throw new Error('币种应为 3 位字母，如 CNY');
}

export function CardAnnualFeeFields({ value, onChange }: {
  value?: CardAnnualFeePolicy | null;
  onChange?: (value: CardAnnualFeePolicy | null) => void;
}) {
  const policy: CardAnnualFeePolicy = value ?? {};
  const update = (fields: Partial<CardAnnualFeePolicy>) => {
    const next = { ...policy, ...fields };
    onChange?.(Object.values(next).some((entry) => entry !== undefined && entry !== '') ? next : null);
  };

  return (
    <Row gutter={[12, 0]}>
      <Col xs={24} sm={12}>
        <Form.Item label="收费方式" htmlFor="annual-fee-charge">
          <Select<CardAnnualFeePolicy['charge']> id="annual-fee-charge" value={policy.charge} placeholder="未设置" allowClear
            options={Object.entries(charges).map(([key, label]) => ({ value: key as keyof typeof charges, label }))}
            onChange={(charge) => update({ charge })} />
        </Form.Item>
      </Col>
      <Col xs={16} sm={8}>
        <Form.Item label="标准年费" htmlFor="annual-fee-amount">
          <InputNumber id="annual-fee-amount" value={policy.amount ?? null} min={0} max={999_999_999.99}
            precision={2} style={{ width: '100%' }} onChange={(amount) => update({ amount: amount ?? undefined })} />
        </Form.Item>
      </Col>
      <Col xs={8} sm={4}>
        <Form.Item label="币种" htmlFor="annual-fee-currency">
          <Input id="annual-fee-currency" value={policy.currency ?? ''} maxLength={3} placeholder="如 CNY"
            onChange={(event) => update({ currency: event.target.value.trim().toUpperCase() || undefined })} />
        </Form.Item>
      </Col>
      <Col xs={24} sm={12}>
        <Form.Item label="减免条件" htmlFor="annual-fee-waiver">
          <Select<CardAnnualFeePolicy['waiver']> id="annual-fee-waiver" value={policy.waiver} placeholder="未设置" allowClear
            options={Object.entries(waivers).map(([key, label]) => ({ value: key as keyof typeof waivers, label }))}
            onChange={(waiver) => update({ waiver })} />
        </Form.Item>
      </Col>
      <Col xs={24} sm={12}>
        <Form.Item label="办理方式" htmlFor="annual-fee-settlement">
          <Select<AnnualFeeSettlement> id="annual-fee-settlement" value={policy.settlement} placeholder="未设置" allowClear
            options={Object.entries(annualFeeSettlementLabels).map(([value, label]) => ({ value, label }))}
            onChange={(settlement) => update({ settlement })} />
        </Form.Item>
      </Col>
      <Col xs={12} sm={6}>
        <Form.Item label="需刷次数" htmlFor="annual-fee-required-count">
          <InputNumber id="annual-fee-required-count" value={policy.requiredCount ?? null} min={1} max={100_000}
            precision={0} style={{ width: '100%' }} onChange={(requiredCount) => update({ requiredCount: requiredCount ?? undefined })} />
        </Form.Item>
      </Col>
      <Col xs={12} sm={6}>
        <Form.Item label="银行已确认次数" htmlFor="annual-fee-confirmed-count">
          <InputNumber id="annual-fee-confirmed-count" value={policy.confirmedCount ?? null} min={0} max={100_000}
            precision={0} style={{ width: '100%' }} placeholder="未核对"
            onChange={(confirmedCount) => update({ confirmedCount: confirmedCount ?? undefined })} />
        </Form.Item>
      </Col>
      <Col xs={24} sm={12}>
        <Form.Item label="本期刷卡截止日" htmlFor="annual-fee-cycle-end">
          <DatePicker id="annual-fee-cycle-end" value={policy.cycleEnd ? dayjs(policy.cycleEnd) : null}
            style={{ width: '100%' }} format="YYYY-MM-DD"
            onChange={(date) => {
              const cycleEnd = date?.format('YYYY-MM-DD');
              const today = dayjs().format('YYYY-MM-DD');
              const newCycle = policy.cycleEnd && policy.cycleEnd < today && cycleEnd && cycleEnd >= today;
              update({ cycleEnd, ...(newCycle ? { confirmedCount: undefined } : {}) });
            }} />
        </Form.Item>
      </Col>
      <Col xs={12} sm={12}>
        <Form.Item label="所需积分" htmlFor="annual-fee-required-points">
          <InputNumber id="annual-fee-required-points" value={policy.requiredPoints ?? null} min={1} max={1_000_000_000}
            precision={0} style={{ width: '100%' }} onChange={(requiredPoints) => update({ requiredPoints: requiredPoints ?? undefined })} />
        </Form.Item>
      </Col>
      <Col xs={12} sm={12}>
        <Form.Item label="当前可用积分" htmlFor="annual-fee-available-points">
          <InputNumber id="annual-fee-available-points" value={policy.availablePoints ?? null} min={0} max={1_000_000_000}
            precision={0} style={{ width: '100%' }} placeholder="未核对"
            onChange={(availablePoints) => update({ availablePoints: availablePoints ?? undefined })} />
        </Form.Item>
      </Col>
      <Col span={24}>
        <Form.Item label="规则备注" htmlFor="annual-fee-notes">
          <Input.TextArea id="annual-fee-notes" value={policy.notes ?? ''} maxLength={400} autoSize={{ minRows: 1, maxRows: 3 }}
            placeholder="例如，仅指定渠道消费计入减免"
            onChange={(event) => update({ notes: event.target.value || undefined })} />
        </Form.Item>
      </Col>
    </Row>
  );
}

export function CardAnnualFeeSummary({ policy, onEdit, onTrack }: {
  policy: CardAnnualFeePolicy;
  onEdit: () => void;
  onTrack?: () => void;
}) {
  const expired = policy.cycleEnd && policy.cycleEnd < dayjs().format('YYYY-MM-DD');
  const { requiredCount: count, confirmedCount, requiredPoints: points, availablePoints, amount, currency } = policy;
  const remainingCount = count != null && confirmedCount != null ? Math.max(0, count - confirmedCount) : null;
  const remainingPoints = points != null && availablePoints != null ? Math.max(0, points - availablePoints) : null;
  const labels = [
    policy.charge && (amount != null || policy.charge !== 'free') && charges[policy.charge],
    policy.waiver && waivers[policy.waiver],
    amount == null && currency && `币种 ${currency}`,
  ].filter(Boolean).join(' · ');
  const countStatus = expired ? '本期刷卡减免已截止'
    : count == null ? null : remainingCount == null ? `需刷 ${count} 笔 · 进度待核对`
      : remainingCount === 0 ? '刷卡次数已达标' : `还差 ${remainingCount} 笔`;
  const countText = [
    countStatus,
    confirmedCount != null && (count == null ? `银行已确认 ${confirmedCount} 笔` : `银行确认 ${confirmedCount}/${count} 笔`),
    policy.cycleEnd && `截止 ${policy.cycleEnd}`,
  ].filter(Boolean).join(' · ');
  const pointsText = points == null
    ? availablePoints == null ? null : `当前可用 ${availablePoints.toLocaleString('zh-CN')} 积分`
    : `需 ${points.toLocaleString('zh-CN')} 积分`;
  const feeText = amount != null && `标准年费 ${currency
    ? formatMoney(amount, currency)
    : amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <div className="cards-annual-fee-summary">
      <div className="cards-annual-fee-heading">
        <Typography.Text strong>{feeText || (policy.charge === 'free' ? charges.free : '年费与减免')}</Typography.Text>
        <div>
          <Button type="link" size="small" onClick={onEdit}>编辑年费</Button>
          {onTrack && <Button type="link" size="small" onClick={onTrack}>减免记录</Button>}
        </div>
      </div>
      {labels && <Typography.Text type="secondary">{labels}</Typography.Text>}
      {policy.settlement && <div>{annualFeeSettlementLabels[policy.settlement]}</div>}
      {countText && <div>{countText}</div>}
      {pointsText && (
        <div>
          {pointsText}
          {remainingPoints != null && (remainingPoints === 0 ? ' · 积分已足够，按银行要求办理抵扣'
            : ` · 还差 ${remainingPoints.toLocaleString('zh-CN')} 积分`)}
        </div>
      )}
      {policy.notes && <Typography.Text type="secondary">{policy.notes}</Typography.Text>}
    </div>
  );
}
