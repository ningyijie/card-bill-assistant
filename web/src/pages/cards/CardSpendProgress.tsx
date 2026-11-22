import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Flex, InputNumber, Modal, Spin, Tag, Typography } from 'antd';
import { api } from '../../api/client';
import type { CardSpendProgress as Progress, CardSpendProgressResponse } from '../../api/types';
import { formatMoney } from '../../lib/money';
import { spendBasisLabels } from './CardSpendRules';

type Period = Progress['periods'][number];

function AnnualFeeEligibility({ annualFee }: { annualFee: NonNullable<CardSpendProgressResponse['annualFee']> }) {
  const { met, points, spend } = annualFee;
  const formatPoints = (quantity: number) => quantity.toLocaleString('zh-CN');
  return (
    <Card size="small" title="年费减免条件">
      <Flex vertical gap={8}>
        <Flex wrap gap={8} align="center">
          <Tag color={met ? 'green' : undefined}>{met ? '已满足年费减免条件' : '等待达标或核对'}</Tag>
          {points && <Typography.Text type="secondary">满足下面任意一项即可</Typography.Text>}
        </Flex>
        {points && (
          <div>
            <Typography.Text strong>积分兑换 </Typography.Text>
            {points.target !== null && <span>需 {formatPoints(points.target)} 积分 · </span>}
            {points.expired ? '兑换已截止'
              : points.met ? '积分门槛已达到'
                : points.remaining === null ? '待填写积分'
                  : `还差 ${formatPoints(points.remaining)} 积分`}
            {points.deadline && <Typography.Text type="secondary"> · 截止 {points.deadline}</Typography.Text>}
          </div>
        )}
        <div>
          <Typography.Text strong>消费达标 </Typography.Text>
          {spend ? (
            <span>
              {spend.name} · 银行确认 {spend.confirmed}/{spend.required} 期
              {spend.met ? ' · 消费条件已达标' : spend.estimated >= spend.required ? ' · 估算已达标，待银行核对' : ''}
            </span>
          ) : '待关联消费规则'}
        </div>
        <Typography.Text type="secondary">退款到账情况在「减免记录」中查看。</Typography.Text>
      </Flex>
    </Card>
  );
}

export function CardSpendProgress({ cardId, cardLabel, onClose }: { cardId: number; cardLabel?: string; onClose: () => void }) {
  const path = `/api/cards/${cardId}/spend-progress`;
  const [data, setData] = useState<CardSpendProgressResponse | null>(null);
  const [revision, setRevision] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [editing, setEditing] = useState<{
    ruleId: string; period: Period; byCount: boolean; value: number | null;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadError('');
    void api.get<CardSpendProgressResponse>(path).then(
      (items) => { if (active) setData(items); },
      (err: unknown) => { if (active) setLoadError(err instanceof Error ? err.message : '读取消费进度失败'); },
    );
    return () => { active = false; };
  }, [path, revision]);

  async function save(value: number | null) {
    if (!editing) return;
    setSaving(true);
    setSaveError('');
    try {
      const confirmation = editing.byCount ? { count: value } : { amount: value };
      await api.put(`${path}/${editing.ruleId}`, { periodKey: editing.period.key, ...confirmation });
      setEditing(null);
      setRevision((value) => value + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存银行确认失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open title={data?.annualFee ? '年费达标进度' : '消费达标进度'} width={720} footer={null} onCancel={onClose}>
      <Flex vertical gap={12} style={{ maxHeight: '70vh', overflowY: 'auto' }}>
        {cardLabel && <Typography.Text strong>{cardLabel}</Typography.Text>}
        <Typography.Text type="secondary">
          进度按已导入的账单明细估算。活动资格和退款扣减以银行记录为准。
        </Typography.Text>
        {loadError && <Alert type="error" title={loadError}
          action={<Button size="small" onClick={() => setRevision((value) => value + 1)}>重试</Button>} />}
        {saveError && <Alert type="error" title={saveError} />}
        {data === null && !loadError && <Spin />}
        {data?.annualFee && <AnnualFeeEligibility annualFee={data.annualFee} />}
        {data?.tracks.length === 0 && !data.annualFee && <Empty description="暂无消费跟踪规则" />}
        {data?.tracks.map(({ rule, periods, bankStreak, estimatedStreak }) => {
          const required = rule.consecutive ?? 1;
          const byCount = rule.metric === 'count';
          const target = byCount ? rule.count : rule.amount;
          const money = (amount: number) => formatMoney(amount, rule.currency);
          const display = (value: number) => byCount ? `${value} 笔` : money(value);
          const confirmLabel = byCount ? '银行确认笔数' : '银行确认金额';
          return (
            <Card key={rule.id} size="small" title={rule.name} extra={<Tag>{spendBasisLabels[rule.basis]}</Tag>}>
              <Flex vertical gap={10}>
                <Typography.Text strong>
                  {rule.basis === 'date_range' ? '累计目标' : '每期目标'} {display(target)}
                </Typography.Text>
                {rule.cashback && <Typography.Text>达标后次月返现 {rule.cashback.rate}%，最高 {money(rule.cashback.cap)}</Typography.Text>}
                {required > 1 && (
                  <Flex wrap gap={8}>
                    <Tag color={bankStreak >= required ? 'green' : undefined}>银行确认最长连续 {bankStreak}/{required} 期</Tag>
                    {estimatedStreak > bankStreak && <Tag color="blue">含估算最长连续 {estimatedStreak}/{required} 期</Tag>}
                  </Flex>
                )}
                {[...periods].reverse().map((period) => {
                  const isEditing = editing?.ruleId === rule.id && editing.period.key === period.key;
                  const confirmed = byCount ? period.bankCount ?? null : period.bankAmount;
                  const estimate = byCount ? period.estimatedCount ?? null : period.estimatedAmount;
                  return (
                    <Card key={period.key} size="small">
                      <Flex vertical gap={6}>
                        <Flex wrap gap={8} justify="space-between" align="center">
                          <Typography.Text strong>{period.label}</Typography.Text>
                          {period.canConfirm && !isEditing && <Button type="link" size="small" disabled={saving}
                            onClick={() => {
                              setSaveError('');
                              setEditing({ ruleId: rule.id, period, byCount, value: confirmed });
                            }}>{byCount ? '确认笔数' : '确认金额'}</Button>}
                        </Flex>
                        {rule.basis === 'statement_month' && (
                          <Typography.Text type="secondary">{period.startsOn} 至 {period.endsOn}</Typography.Text>
                        )}
                        <Flex wrap gap={8}>
                          {confirmed !== null && <Tag color="green">银行确认 {display(confirmed)}</Tag>}
                          {estimate !== null && <Tag color="blue">账单估算 {display(estimate)}</Tag>}
                          {period.remaining === null
                            ? <Typography.Text type="secondary">{period.canConfirm ? '暂无账单明细或银行确认' : '尚未开始'}</Typography.Text>
                            : <Typography.Text>
                              {period.remaining > 0 ? `还差 ${display(period.remaining)}`
                                : confirmed !== null ? '银行确认已达标' : '估算已达标，待银行核对'}
                            </Typography.Text>}
                        </Flex>
                        {byCount && period.lastTransactionOn && (
                          <Typography.Text type="secondary">最近一笔已导入交易 {period.lastTransactionOn}</Typography.Text>
                        )}
                        {isEditing && (
                          <Flex wrap gap={8}>
                            <InputNumber aria-label={`${period.label} ${confirmLabel}`} value={editing.value}
                              min={0} max={byCount ? 100_000 : 999_999_999.99} precision={byCount ? 0 : 2} disabled={saving}
                              placeholder={confirmLabel} style={{ width: 152 }}
                              onChange={(value) => setEditing({ ...editing, value })} />
                            <Button type="primary" loading={saving} disabled={editing.value === null}
                              onClick={() => void save(editing.value)}>保存</Button>
                            {confirmed !== null && <Button disabled={saving} onClick={() => void save(null)}>清除确认</Button>}
                            <Button disabled={saving} onClick={() => setEditing(null)}>取消</Button>
                          </Flex>
                        )}
                      </Flex>
                    </Card>
                  );
                })}
              </Flex>
            </Card>
          );
        })}
      </Flex>
    </Modal>
  );
}
