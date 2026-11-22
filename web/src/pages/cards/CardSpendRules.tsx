import { Button, Card, Checkbox, Col, DatePicker, Flex, Form, Input, InputNumber, Row, Select } from 'antd';
import dayjs from 'dayjs';
import type { CardSpendBasis, CardSpendRule, CardSpendRuleFields } from '../../api/types';

export const spendBasisLabels: Record<CardSpendBasis, string> = {
  statement_month: '账单月',
  calendar_month: '自然月',
  date_range: '指定日期范围',
};

export function CardSpendRules({ rules, currency, onChange }: {
  rules: CardSpendRule[];
  currency?: string;
  onChange: (rules: CardSpendRule[]) => void;
}) {
  function addRule() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    onChange([...rules, { id, name: '', basis: 'statement_month', amount: 0,
      currency: currency || 'CNY', start: '', consecutive: 1 }]);
  }

  return (
    <Flex vertical gap={12}>
      {rules.map((rule) => {
        const replaceRule = (next: CardSpendRule) => onChange(rules.map((item) => item.id === rule.id ? next : item));
        const update = (patch: Partial<CardSpendRuleFields>) => replaceRule({ ...rule, ...patch });
        const byCount = rule.metric === 'count';
        const target = byCount ? rule.count : rule.amount;
        const cashback = rule.cashback;
        const changeMetric = (metric: 'amount' | 'count') => {
          if (metric === 'count' && rule.metric !== 'count') {
            const { amount, ...fields } = rule;
            replaceRule({ ...fields, currency: /^[A-Z]{3}$/.test(rule.currency) ? rule.currency : 'CNY', metric, count: 0 });
          } else if (metric === 'amount' && rule.metric === 'count') {
            const { count, ...fields } = rule;
            replaceRule({ ...fields, metric, amount: 0 });
          }
        };
        const range = rule.basis === 'date_range';
        const format = range ? 'YYYY-MM-DD' : 'YYYY-MM';
        return (
          <Card key={rule.id} size="small" title={rule.name.trim() || '消费跟踪规则'}
            extra={<Button danger type="text" size="small" onClick={() => onChange(rules.filter((item) => item.id !== rule.id))}>移除</Button>}>
            <Row gutter={12}>
              <Col xs={24} sm={12}>
                <Form.Item label="跟踪名称" htmlFor={`name-${rule.id}`} required>
                  <Input id={`name-${rule.id}`} value={rule.name} maxLength={48} placeholder="如 优享白年费返还"
                    onChange={(event) => update({ name: event.target.value })} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item label="统计周期" htmlFor={`basis-${rule.id}`} required>
                  <Select id={`basis-${rule.id}`} value={rule.basis}
                    options={Object.entries(spendBasisLabels).map(([value, label]) => ({ value, label }))}
                    onChange={(basis: CardSpendBasis) => update({
                      basis,
                      ...(range !== (basis === 'date_range') ? { start: '', end: undefined } : {}),
                    })} />
                </Form.Item>
              </Col>
              <Col xs={12} sm={6}>
                <Form.Item label="统计方式" htmlFor={`metric-${rule.id}`} required>
                  <Select id={`metric-${rule.id}`} value={rule.metric ?? 'amount'}
                    options={[{ value: 'amount', label: '消费金额' }, { value: 'count', label: '消费笔数' }]}
                    onChange={changeMetric} />
                </Form.Item>
              </Col>
              <Col xs={12} sm={6}>
                <Form.Item label={byCount ? '目标消费笔数' : range ? '目标消费金额' : '每期目标金额'} htmlFor={`amount-${rule.id}`} required>
                  <InputNumber id={`amount-${rule.id}`} min={byCount ? 1 : 0.01}
                    max={byCount ? 100_000 : 999_999_999.99} precision={byCount ? 0 : 2} suffix={byCount ? '笔' : undefined}
                    style={{ width: '100%' }} value={target || null}
                    onChange={(value) => replaceRule(byCount ? { ...rule, count: value ?? 0 } : { ...rule, amount: value ?? 0 })} />
                </Form.Item>
              </Col>
              {(!byCount || cashback) && (
                <Col xs={12} sm={6}>
                  <Form.Item label={byCount ? '返现币种' : '统计币种'} htmlFor={`currency-${rule.id}`} required>
                    <Input id={`currency-${rule.id}`} value={rule.currency} maxLength={3}
                      onChange={(event) => update({ currency: event.target.value.toUpperCase() })} />
                  </Form.Item>
                </Col>
              )}
              {!range && (
                <Col xs={12} sm={6}>
                  <Form.Item label="连续达标期数" htmlFor={`consecutive-${rule.id}`}>
                    <InputNumber id={`consecutive-${rule.id}`} min={1} max={24} precision={0}
                      style={{ width: '100%' }} value={rule.consecutive ?? 1}
                      onChange={(consecutive) => update({ consecutive: consecutive ?? 1 })} />
                  </Form.Item>
                </Col>
              )}
              <Col xs={24} sm={12}>
                <Form.Item label={range ? '开始日期' : rule.basis === 'statement_month' ? '首个账单月' : '开始月份'}
                  htmlFor={`start-${rule.id}`} required>
                  <DatePicker id={`start-${rule.id}`} picker={range ? 'date' : 'month'} format={format}
                    style={{ width: '100%' }} value={rule.start ? dayjs(rule.start) : null}
                    onChange={(date) => update({ start: date?.format(format) ?? '' })} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item label={range ? '截止日期' : '截止月份（可选）'} htmlFor={`end-${rule.id}`} required={range}>
                  <DatePicker id={`end-${rule.id}`} picker={range ? 'date' : 'month'} format={format}
                    style={{ width: '100%' }} value={rule.end ? dayjs(rule.end) : null}
                    onChange={(date) => update({ end: date?.format(format) })} />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item>
                  <Checkbox checked={Boolean(cashback)} onChange={(event) => update({
                    cashback: event.target.checked ? { rate: 0, cap: 0 } : undefined,
                    ...(byCount && !/^[A-Z]{3}$/.test(rule.currency) ? { currency: 'CNY' } : {}),
                  })}>记录达标后的次月返现</Checkbox>
                </Form.Item>
              </Col>
              {cashback && (
                <>
                  <Col xs={12}>
                    <Form.Item label="次月返现比例" htmlFor={`cashback-rate-${rule.id}`} required>
                      <InputNumber id={`cashback-rate-${rule.id}`} min={0.01} max={100} precision={2} suffix="%"
                        style={{ width: '100%' }} value={cashback.rate || null}
                        onChange={(rate) => update({ cashback: { ...cashback, rate: rate ?? 0 } })} />
                    </Form.Item>
                  </Col>
                  <Col xs={12}>
                    <Form.Item label="次月返现上限" htmlFor={`cashback-cap-${rule.id}`} required>
                      <InputNumber id={`cashback-cap-${rule.id}`} min={0.01} max={999_999_999.99} precision={2} suffix={rule.currency}
                        style={{ width: '100%' }} value={cashback.cap || null}
                        onChange={(cap) => update({ cashback: { ...cashback, cap: cap ?? 0 } })} />
                    </Form.Item>
                  </Col>
                </>
              )}
            </Row>
          </Card>
        );
      })}
      <Button type="dashed" block disabled={rules.length >= 12} onClick={addRule}>添加消费跟踪规则</Button>
    </Flex>
  );
}
