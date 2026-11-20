import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Empty, Flex, Modal, Select, Spin, Tag, Typography } from 'antd';
import { api } from '../../api/client';
import type { AnnualFeeReviewStatus, AnnualFeeTrackingRow } from '../../api/types';
import { notifyDataChanged } from '../../lib/dataChanged';
import { formatMoney } from '../../lib/money';
import { cardDisplayLabel } from '../../lib/cardDisplay';
import { annualFeeSettlementLabels } from './CardAnnualFee';

const reviewOptions: { value: AnnualFeeReviewStatus | 'auto'; label: string }[] = [
  { value: 'auto', label: '跟随账单识别' },
  { value: 'pending', label: '恢复待处理（手动核对）' },
  { value: 'requested', label: '已申请，等待退款' },
  { value: 'refunded', label: '已退款（手动确认）' },
  { value: 'closed', label: '无需跟进' },
];

const statusLabels: Record<AnnualFeeTrackingRow['status'], string> = {
  apply: '待申请减免',
  review: '待核对能否减免',
  waiting: '等待银行自动退款',
  requested: '已申请，等待退款',
  refunded: '已退款',
  closed: '无需跟进',
};

export function AnnualFeeTracking({ onClose, cardId }: { onClose: () => void; cardId?: number }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<AnnualFeeTrackingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const path = '/api/cards/annual-fees' + (cardId === undefined ? '' : `?cardId=${cardId}`);

  useEffect(() => {
    let current = true;
    setError(null);
    api.get<AnnualFeeTrackingRow[]>(path).then(
      (result) => { if (current) setRows(result); },
      (err: unknown) => { if (current) setError(err instanceof Error ? err.message : '读取年费记录失败'); },
    );
    return () => { current = false; };
  }, [path, revision]);

  async function save(row: AnnualFeeTrackingRow, value: AnnualFeeReviewStatus | 'auto') {
    setSaving(true);
    try {
      await api.put(`/api/cards/${row.cardId}/annual-fees/${row.period}/${row.currency}`, { status: value === 'auto' ? null : value });
      setRows(null);
      setRevision((previous) => previous + 1);
      notifyDataChanged();
      message.success('年费状态已更新');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存年费状态失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open title="年费减免记录" footer={null} onCancel={onClose}>
      {error ? <Alert type="error" title={error} action={<Button size="small" onClick={() => setRevision(revision + 1)}>重试</Button>} />
        : rows === null ? <Spin />
          : rows.length === 0 ? <Empty description="账单暂无已扣年费记录" />
            : (
              <Flex vertical gap={12} style={{ maxHeight: '65vh', overflowY: 'auto' }}>
                {rows.map((row) => {
                  const account = cardDisplayLabel({ ...row, nickname: row.cardNickname });
                  return (
                    <Card size="small" key={`${row.cardId}:${row.period}:${row.currency}`}>
                      <Flex vertical gap={6}>
                        <Flex wrap gap={8} justify="space-between">
                          <Typography.Text strong>{account} · {row.period} 账单</Typography.Text>
                          <Tag color={row.status === 'refunded' ? 'green' : undefined}>{statusLabels[row.status]}</Tag>
                        </Flex>
                        <div>{row.date} 扣费 {formatMoney(row.amount, row.currency)}</div>
                        {row.settlement && <Typography.Text type="secondary">{annualFeeSettlementLabels[row.settlement]}</Typography.Text>}
                        {row.refundAmount > 0 && (
                          <Flex wrap gap={8} align="center">
                            <Tag color="green">
                              {row.remainingAmount > 0 ? '已部分抵扣或退款' : '账单已全额冲抵'}
                            </Tag>
                            <Typography.Text>
                              已抵扣或退回 {formatMoney(row.refundAmount, row.currency)}
                              {row.status !== 'refunded' && row.remainingAmount > 0
                                && ` · 剩余年费 ${formatMoney(row.remainingAmount, row.currency)}`}
                            </Typography.Text>
                            {row.refundDate && <Typography.Text type="secondary">最近入账 {row.refundDate}</Typography.Text>}
                          </Flex>
                        )}
                        <Select<AnnualFeeReviewStatus | 'auto'>
                          aria-label={`更新 ${account} ${row.period} 年费减免状态`}
                          value={row.manualStatus ?? 'auto'}
                          options={reviewOptions}
                          disabled={saving}
                          onChange={(value) => void save(row, value)}
                        />
                      </Flex>
                    </Card>
                  );
                })}
              </Flex>
            )}
    </Modal>
  );
}
