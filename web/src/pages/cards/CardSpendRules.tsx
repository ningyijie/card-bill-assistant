import { Button, Card, Col, DatePicker, Flex, Form, Input, InputNumber, Row, Select } from 'antd';
import dayjs from 'dayjs';
import type { CardSpendBasis, CardSpendRule } from '../../api/types';

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
        const update = (patch: Partial<CardSpendRule>) =>
          onChange(rules.map((item) => item.id === rule.id ? { ...item, ...patch } : item));
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
              <Col xs={12} sm={range ? 16 : 10}>
                <Form.Item label={range ? '目标消费金额' : '每期目标金额'} htmlFor={`amount-${rule.id}`} required>
                  <InputNumber id={`amount-${rule.id}`} min={0.01} max={999_999_999.99} precision={2}
                    style={{ width: '100%' }} value={rule.amount || null}
                    onChange={(amount) => update({ amount: amount ?? 0 })} />
                </Form.Item>
              </Col>
              <Col xs={12} sm={range ? 8 : 6}>
                <Form.Item label="统计币种" htmlFor={`currency-${rule.id}`} required>
                  <Input id={`currency-${rule.id}`} value={rule.currency} maxLength={3}
                    onChange={(event) => update({ currency: event.target.value.toUpperCase() })} />
                </Form.Item>
              </Col>
              {!range && (
                <Col xs={24} sm={8}>
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
            </Row>
          </Card>
        );
      })}
      <Button type="dashed" block disabled={rules.length >= 12} onClick={addRule}>添加消费跟踪规则</Button>
    </Flex>
  );
}
