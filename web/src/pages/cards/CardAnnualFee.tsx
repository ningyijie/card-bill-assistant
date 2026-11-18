import { Button, Col, DatePicker, Form, Input, InputNumber, Row, Select, Typography } from 'antd';
import dayjs from 'dayjs';
import type { CardAnnualFeePolicy } from '../../api/types';
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

function hasCountRule(waiver?: CardAnnualFeePolicy['waiver']) {
  return waiver === 'count' || waiver === 'either';
}

function hasPointsRule(waiver?: CardAnnualFeePolicy['waiver']) {
  return waiver === 'points' || waiver === 'either';
}

export async function validateAnnualFeePolicy(_: unknown, policy?: CardAnnualFeePolicy | null) {
  if (!policy || policy.charge === 'free') return;
  if ((policy.amount != null || policy.currency != null) && !/^[A-Z]{3}$/.test(policy.currency ?? '')) throw new Error('请填写 3 位币种代码，如 CNY');
  if (hasCountRule(policy.waiver) && !policy.requiredCount) throw new Error('请填写减免所需刷卡次数');
  if (hasCountRule(policy.waiver) && policy.confirmedCount != null && !policy.cycleEnd) {
    throw new Error('记录已刷次数时请填写本期截止日');
  }
  if (hasPointsRule(policy.waiver) && !policy.requiredPoints) throw new Error('请填写抵扣所需积分');
}

export function CardAnnualFeeFields({ value, onChange }: {
  value?: CardAnnualFeePolicy | null;
  onChange?: (value: CardAnnualFeePolicy | null) => void;
}) {
  const update = (fields: Partial<CardAnnualFeePolicy>) => {
    if (value) onChange?.({ ...value, ...fields });
  };
  const setWaiver = (waiver: CardAnnualFeePolicy['waiver']) => {
    update({
      waiver,
      ...(!hasCountRule(waiver) ? { requiredCount: undefined, confirmedCount: undefined, cycleEnd: undefined } : {}),
      ...(!hasPointsRule(waiver) ? { requiredPoints: undefined, availablePoints: undefined } : {}),
    });
  };
  return (
    <Row gutter={[12, 0]}>
      <Col xs={24} sm={12}>
        <Form.Item label="收费方式" htmlFor="annual-fee-charge" colon={false}>
          <Select<CardAnnualFeePolicy['charge']>
            id="annual-fee-charge"
            value={value?.charge}
            placeholder="未设置"
            allowClear
            options={Object.entries(charges).map(([key, label]) => ({ value: key as CardAnnualFeePolicy['charge'], label }))}
            onChange={(charge) => {
              if (!charge) onChange?.(null);
              else if (!value || charge === 'free') onChange?.({ charge, waiver: 'none', notes: value?.notes });
              else update({ charge });
            }}
          />
        </Form.Item>
      </Col>
      {value && value.charge !== 'free' && (
        <>
          <Col xs={16} sm={8}>
            <Form.Item label="标准年费（可选）" htmlFor="annual-fee-amount">
              <InputNumber id="annual-fee-amount" value={value.amount ?? null} min={0} max={999_999_999.99}
                precision={2} style={{ width: '100%' }}
                onChange={(amount) => update({ amount: amount ?? undefined, currency: value.currency ?? 'CNY' })} />
            </Form.Item>
          </Col>
          <Col xs={8} sm={4}>
            <Form.Item label="币种" htmlFor="annual-fee-currency">
              <Input id="annual-fee-currency" value={value.currency ?? 'CNY'} maxLength={3}
                onChange={(event) => update({ currency: event.target.value.toUpperCase() })} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item label="减免方式" htmlFor="annual-fee-waiver">
              <Select<CardAnnualFeePolicy['waiver']>
                id="annual-fee-waiver"
                value={value.waiver}
                options={Object.entries(waivers).map(([key, label]) => ({ value: key as CardAnnualFeePolicy['waiver'], label }))}
                onChange={setWaiver}
              />
            </Form.Item>
          </Col>
          {hasCountRule(value.waiver) && (
            <>
              <Col xs={12} sm={6}>
                <Form.Item label="需刷次数" htmlFor="annual-fee-required-count">
                  <InputNumber id="annual-fee-required-count" value={value.requiredCount ?? null} min={1} max={100_000}
                    precision={0} style={{ width: '100%' }}
                    onChange={(requiredCount) => update({ requiredCount: requiredCount ?? undefined })} />
                </Form.Item>
              </Col>
              <Col xs={12} sm={6}>
                <Form.Item label="银行已确认次数" htmlFor="annual-fee-confirmed-count">
                  <InputNumber id="annual-fee-confirmed-count" value={value.confirmedCount ?? null} min={0} max={100_000}
                    precision={0} style={{ width: '100%' }} placeholder="未核对"
                    onChange={(confirmedCount) => update({ confirmedCount: confirmedCount ?? undefined })} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item label="本期刷卡截止日" htmlFor="annual-fee-cycle-end">
                  <DatePicker id="annual-fee-cycle-end" value={value.cycleEnd ? dayjs(value.cycleEnd) : null}
                    style={{ width: '100%' }} format="YYYY-MM-DD"
                    onChange={(date) => {
                      const cycleEnd = date?.format('YYYY-MM-DD');
                      const newCycle = !!value.cycleEnd && value.cycleEnd < dayjs().format('YYYY-MM-DD') &&
                        !!cycleEnd && cycleEnd >= dayjs().format('YYYY-MM-DD');
                      update({ cycleEnd, ...(newCycle ? { confirmedCount: undefined } : {}) });
                    }} />
                </Form.Item>
              </Col>
            </>
          )}
          {hasPointsRule(value.waiver) && (
            <>
              <Col xs={12} sm={6}>
                <Form.Item label="所需积分" htmlFor="annual-fee-required-points">
                  <InputNumber id="annual-fee-required-points" value={value.requiredPoints ?? null} min={1} max={1_000_000_000}
                    precision={0} style={{ width: '100%' }}
                    onChange={(requiredPoints) => update({ requiredPoints: requiredPoints ?? undefined })} />
                </Form.Item>
              </Col>
              <Col xs={12} sm={6}>
                <Form.Item label="当前可用积分" htmlFor="annual-fee-available-points">
                  <InputNumber id="annual-fee-available-points" value={value.availablePoints ?? null} min={0} max={1_000_000_000}
                    precision={0} style={{ width: '100%' }} placeholder="未核对"
                    onChange={(availablePoints) => update({ availablePoints: availablePoints ?? undefined })} />
                </Form.Item>
              </Col>
            </>
          )}
        </>
      )}
      {value && (
        <Col span={24}>
          <Form.Item label="规则备注（可选）" htmlFor="annual-fee-notes">
            <Input.TextArea id="annual-fee-notes" value={value.notes ?? ''} maxLength={400} autoSize={{ minRows: 1, maxRows: 3 }}
              placeholder="例如：仅指定渠道消费计入，积分抵扣需在银行 App 申请"
              onChange={(event) => update({ notes: event.target.value })} />
          </Form.Item>
        </Col>
      )}
    </Row>
  );
}

export function CardAnnualFeeSummary({ policy, onEdit }: {
  policy: CardAnnualFeePolicy;
  onEdit: () => void;
}) {
  const expired = policy.cycleEnd && policy.cycleEnd < dayjs().format('YYYY-MM-DD');
  const count = policy.requiredCount;
  const points = policy.requiredPoints;
  const remainingCount = count != null && policy.confirmedCount != null ? Math.max(0, count - policy.confirmedCount) : null;
  const remainingPoints = points != null && policy.availablePoints != null ? Math.max(0, points - policy.availablePoints) : null;
  return (
    <div className="cards-annual-fee-summary">
      <div className="cards-annual-fee-heading">
        <Typography.Text strong>
          {policy.charge === 'free' ? charges.free : policy.amount != null ? `标准年费 ${formatMoney(policy.amount, policy.currency)}` : '年费与减免'}
        </Typography.Text>
        <Button type="link" size="small" onClick={onEdit}>编辑年费</Button>
      </div>
      {policy.charge !== 'free' && (
        <Typography.Text type="secondary">{charges[policy.charge]} · {waivers[policy.waiver]}</Typography.Text>
      )}
      {hasCountRule(policy.waiver) && count != null && (
        <div>
          {expired ? '本期刷卡减免已截止' : remainingCount === null ? `需刷 ${count} 笔 · 进度待核对`
            : remainingCount === 0 ? '刷卡次数已达标' : `还差 ${remainingCount} 笔`}
          {policy.confirmedCount != null && `（银行确认 ${policy.confirmedCount}/${count} 笔）`}
          {policy.cycleEnd && <Typography.Text type="secondary"> · 截止 {policy.cycleEnd}</Typography.Text>}
        </div>
      )}
      {hasPointsRule(policy.waiver) && points != null && (
        <div>
          需 {points.toLocaleString('zh-CN')} 积分
          {remainingPoints != null && (remainingPoints === 0 ? ' · 积分已足够，按银行要求办理抵扣'
            : ` · 还差 ${remainingPoints.toLocaleString('zh-CN')} 积分`)}
        </div>
      )}
      {policy.notes && <Typography.Text type="secondary">{policy.notes}</Typography.Text>}
    </div>
  );
}
