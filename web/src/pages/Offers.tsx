import { useRef, useState } from 'react';
import { Alert, App, Button, Card, Collapse, Empty, Flex, Form, Input, InputNumber, Modal, Select, Space, Spin, Switch, Tabs, Tag, Typography } from 'antd';
import { api } from '../api/client';
import type { CardSpendProgressResponse } from '../api/types';
import { Page } from '../components/Layout';
import { cardDisplayLabel } from '../lib/cardDisplay';
import { displayDate } from '../lib/displayDate';
import { formatMoney } from '../lib/money';
import { useResource } from '../lib/useResource';
import { OfferEditor } from './offers/OfferEditor';
import { WechatOfferSources } from './offers/WechatOfferSources';
import { CardProfileEditor, OfferRecordEditor } from './offers/OfferPreferences';
import type { RecordTarget } from './offers/OfferPreferences';
import { discountTypes, paymentChannels } from './offers/types';
import type { CatalogOffer, OfferCandidate, OfferCard, OfferCatalog, OfferFilters, OfferRecord, OfferRule, OfferSearchResult, OfferSource } from './offers/types';
import './offers/offers.css';

const yuan = (amount: number) => formatMoney(amount, 'CNY');
const paymentOptions = Object.entries(paymentChannels).map(([value, label]) => ({ value, label }));
const statusInfo = {
  ready: { name: '规则匹配', color: 'green' },
  action: { name: '先领取或兑换', color: 'blue' },
  check: { name: '待核对', color: 'gold' },
};
const emptyReasons = {
  merchant: '活动库暂时没有这个商户的可查询活动。',
  date: '已收录这个商户的活动，当前选择的日期没有生效的活动。',
  filters: '当前预算、地点、时间或支付方式与已收录的活动条件不符。',
  card: '已收录这个商户的活动，当前卡片中没有匹配的卡。',
  record: '匹配的活动已使用、余量为零，或你已标记不符合资格。',
};

function detail(rule: OfferRule) {
  const d = rule.discount;
  switch (d.type) {
    case 'fixed': return `立减 ${yuan(d.amount ?? 0)}`;
    case 'percent': return `减免 ${d.rate}%${d.cap ? `，最高 ${yuan(d.cap)}` : ''}`;
    case 'random': return `随机立减${d.min != null ? ` ${yuan(d.min)} 至 ${yuan(d.max ?? 0)}` : `，最高 ${yuan(d.max ?? 0)}`}`;
    case 'points': return `${(d.cost ?? 0).toLocaleString('zh-CN')} ${d.unit}兑 ${yuan(d.amount ?? 0)}${d.purchasePrice ? `，另付 ${yuan(d.purchasePrice)}` : ''}`;
    case 'cashback': return `次月返现 ${d.rate}%${d.cap ? `，最高 ${yuan(d.cap)}` : ''}`;
    case 'service': return discountTypes.service;
  }
}

function RuleDetails({ rule, verifiedAt }: { rule: OfferRule; verifiedAt: string | null }) {
  const terms = [
    rule.threshold != null && `单笔满 ${yuan(rule.threshold)}`,
    rule.channels.length > 0 && rule.channels.map((id) => paymentChannels[id]).join(' / '),
    rule.endsOn && `截至 ${rule.endsOn}`,
    rule.claimAt && `${rule.claimAt} 开抢`,
    rule.totalUses && `每周期 ${rule.totalUses} 次`,
  ].filter(Boolean).join(' · ');
  return <>
    <Typography.Text strong>{detail(rule)}</Typography.Text>
    {terms && <Typography.Text type="secondary">{terms}</Typography.Text>}
    {rule.entry && <Typography.Text>{rule.entry}</Typography.Text>}
    {rule.stacking && <Typography.Text type="secondary">{rule.stacking}</Typography.Text>}
    <Space wrap>
      {rule.sourceUrl && <a href={rule.sourceUrl} target="_blank" rel="noreferrer">查看活动原文</a>}
      {verifiedAt && <Typography.Text type="secondary">核验于 {displayDate(verifiedAt)}</Typography.Text>}
    </Space>
  </>;
}

function CandidateCard({ result, date, first, follow }: {
  result: OfferCandidate; date: string; first: boolean; follow: (target: RecordTarget) => void;
}) {
  const { card, quote, rule, progress } = result;
  const voucher = result.state?.status === 'claimed' && (!result.state.voucherEndsOn || result.state.voucherEndsOn >= date);
  return <Card className={first ? 'offers-candidate offers-first' : 'offers-candidate'} size="small">
    <Flex vertical gap={7}>
      <Flex gap={8} wrap align="center">
        <Typography.Text strong>{result.title}</Typography.Text>
        {first && <Tag color="blue">{result.status === 'ready' ? '首选' : '优先核对'}</Tag>}
        <Tag color={statusInfo[result.status].color}>{statusInfo[result.status].name}</Tag>
        {voucher && <Tag color="cyan">已领券{result.state?.voucherEndsOn ? ` · ${result.state.voucherEndsOn}到期` : ''}</Tag>}
      </Flex>
      <Typography.Text>{cardDisplayLabel(card)}</Typography.Text>
      <RuleDetails rule={rule} verifiedAt={result.verifiedAt} />
      {quote.pay != null && <Typography.Text strong>
        预计实付 {yuan(quote.pay)}{quote.cashback != null ? ` · 预计次月返 ${yuan(quote.cashback)}` : ''}
        {quote.pointCost?.valuePer1000 != null && quote.comparableCost != null && ` · 含兑换估值 ${yuan(quote.comparableCost)}`}
      </Typography.Text>}
      {quote.pointCost && <Typography.Text type="secondary">
        需 {quote.pointCost.cost.toLocaleString('zh-CN')} {quote.pointCost.unit}
        {quote.pointCost.balance != null && ` · 记录余额 ${quote.pointCost.balance.toLocaleString('zh-CN')}`}
      </Typography.Text>}
      {progress && <Typography.Text type="secondary">
        {progress.startsOn} 至 {progress.endsOn} · {progress.remaining == null ? '暂无可计算进度'
          : `还差 ${progress.bankCount != null || progress.estimatedCount != null ? `${progress.remaining} 笔` : yuan(progress.remaining)}`}
      </Typography.Text>}
      {[...result.neededActions, ...result.needsCheck].length > 0 && <Typography.Text type="secondary">
        {[...result.neededActions, ...result.needsCheck].join(' · ')}
      </Typography.Text>}
      <Button size="small" className="offers-track-action" onClick={() => follow({
        offerId: result.offerId, cardId: card.id, title: result.title, cardLabel: cardDisplayLabel(card), state: result.state,
      })}>{result.state?.favorite ? '查看跟踪' : '收藏 / 跟踪'}</Button>
    </Flex>
  </Card>;
}

function FavoriteCardProgress({ offer, card, state, follow }: {
  offer: CatalogOffer; card: OfferCard; state: OfferRecord; follow: (target: RecordTarget) => void;
}) {
  const ruleId = offer.rule.spendRuleId;
  const { data, error } = useResource<CardSpendProgressResponse>(ruleId ? `/api/cards/${card.id}/spend-progress` : null);
  const track = data?.tracks.find(({ rule }) => rule.id === ruleId);
  const period = track?.periods.at(-1);
  return <Flex vertical gap={4}>
    <Flex align="center" justify="space-between" wrap gap={6}>
      <Typography.Text>{cardDisplayLabel(card)}{state.remaining != null && ` · 剩 ${state.remaining} 次`}
        {state.voucherEndsOn && ` · 券至 ${state.voucherEndsOn}`}</Typography.Text>
      <Button size="small" onClick={() => follow({ offerId: offer.id, title: offer.rule.title,
        cardId: card.id, cardLabel: cardDisplayLabel(card), state })}>编辑跟踪</Button>
    </Flex>
    {ruleId && <Typography.Text type="secondary">
      {error ? '暂时无法读取消费进度' : !period ? '暂无可计算进度' : <>
        {period.startsOn} 至 {period.endsOn}
        {period.remaining != null && ` · 还差 ${period.bankCount != null || period.estimatedCount != null
          ? `${period.remaining} 笔` : yuan(period.remaining)}`}
        {period.bankCount == null && period.bankAmount == null && ' · 账单估算'}
      </>}
    </Typography.Text>}
  </Flex>;
}

function OfferHistory({ offer, close }: { offer: CatalogOffer; close: () => void }) {
  const { data, error, loading } = useResource<{ id: number; changedAt: string; snapshot: { rule: OfferRule; review: string } }[]>(
    `/api/offers/${offer.id}/revisions`,
  );
  return <Modal open title={`变更记录 · ${offer.rule.title}`} footer={null} onCancel={close}>
    {error && <Alert type="error" title={error} />}
    {loading && <Spin />}
    {data?.length === 0 && <Empty description="暂无历史修改" />}
    {data && data.length > 0 && <Collapse items={data.map(({ id, changedAt, snapshot }) => ({
      key: id, label: `${displayDate(changedAt, { time: true })} · ${snapshot.rule.title}`,
      children: <Flex vertical gap={6}><RuleDetails rule={snapshot.rule} verifiedAt={null} />
        {snapshot.rule.sourceText && <Typography.Paragraph>{snapshot.rule.sourceText}</Typography.Paragraph>}
      </Flex>,
    }))} />}
  </Modal>;
}

export default function Offers() {
  const { message } = App.useApp();
  const catalog = useResource<OfferCatalog>('/api/offers/catalog');
  const [tab, setTab] = useState('ask');
  const sources = useResource<OfferSource[]>(tab === 'sources' ? '/api/offers/sources' : null);
  const cards = catalog.data?.cards ?? [];
  const library = catalog.data?.offers ?? [];
  const [answer, setAnswer] = useState<OfferSearchResult>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sourceBusy, setSourceBusy] = useState<string>();
  const [editor, setEditor] = useState<{ kind: OfferRule['kind']; offer?: CatalogOffer; merchant?: string }>();
  const [profile, setProfile] = useState<OfferCard>();
  const [record, setRecord] = useState<RecordTarget>();
  const [archive, setArchive] = useState<CatalogOffer>();
  const [history, setHistory] = useState<CatalogOffer>();
  const [selectedTrackCards, setSelectedTrackCards] = useState<Record<number, number>>({});
  const locking = useRef(false);
  const refresh = () => { void catalog.refresh(); };
  const lastQuery = useRef<OfferSearchResult['query'] | null>(null);

  async function lookup(values: OfferFilters & { text: string }, byQuestion: boolean) {
    if (locking.current) return;
    locking.current = true;
    setError('');
    setBusy(true);
    setAnswer(undefined);
    const { text, ...raw } = values;
    const filters = Object.fromEntries(Object.entries(raw).filter(([, value]) => value != null && value !== ''));
    try {
      const data = byQuestion
        ? await api.post<OfferSearchResult>('/api/offers/ask', { question: text.trim(), ...filters })
        : await api.get<OfferSearchResult>('/api/offers/search?' + new URLSearchParams({
          merchant: text.trim(), ...Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, String(value)])),
        }));
      lastQuery.current = data.query;
      setAnswer(data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '查询失败'); }
    finally { locking.current = false; setBusy(false); }
  }

  function refreshQuery() {
    refresh();
    if (lastQuery.current) {
      const { merchant, ...filters } = lastQuery.current;
      void lookup({ ...filters, text: merchant }, false);
    }
  }

  async function sourceChange(source: OfferSource, enabled?: boolean) {
    if (sourceBusy) return;
    setSourceBusy(source.key);
    try {
      if (enabled == null) {
        const result = await api.post<{ updated: number }>(`/api/offers/sources/${source.key}/refresh`);
        message.success(result.updated ? `已更新 ${result.updated} 条活动` : '来源没有变化');
        refreshQuery();
      } else await api.put(`/api/offers/sources/${source.key}`, { enabled });
    } catch (reason) { message.error(reason instanceof Error ? reason.message : '活动来源更新失败'); }
    finally { setSourceBusy(undefined); void sources.refresh(); }
  }

  function libraryCards(items: CatalogOffer[], favorite = false) {
    if (!items.length) return <Empty description={favorite ? '还没有收藏的活动' : '暂无权益或活动'} />;
    return <div className="offers-results-grid">
      {items.map((offer) => {
        const applicable = cards.filter((card) => offer.applicableCardIds.includes(card.id));
        const selected = applicable.find((card) => card.id === selectedTrackCards[offer.id]) ?? applicable[0];
        return <Card key={offer.id} size="small" title={offer.rule.title}
          extra={<Space size={4} wrap>
            {offer.sourceKey?.startsWith('wechat:') && <Tag>公众号</Tag>}
            {offer.review !== 'ready' && <Tag>{offer.review === 'draft' ? '待核对' : '已归档'}</Tag>}
          </Space>}>
          <Flex vertical gap={8}>
            <RuleDetails rule={offer.rule} verifiedAt={offer.verifiedAt} />
            {favorite && offer.records.filter(({ state }) => state.favorite).map(({ cardId, state }) => {
              const card = cards.find((item) => item.id === cardId);
              return card && <FavoriteCardProgress key={cardId} offer={offer} card={card} state={state} follow={setRecord} />;
            })}
            {!favorite && <Space wrap>
              <Button size="small" onClick={() => setEditor({ kind: offer.rule.kind, offer })}>编辑</Button>
              <Button size="small" onClick={() => setHistory(offer)}>变更记录</Button>
              {offer.review !== 'archived' && <Button size="small" onClick={() => setArchive(offer)}>归档</Button>}
              {offer.review === 'ready' && selected && <>
                {applicable.length > 1 && <Select size="small" aria-label="选择跟踪卡片" value={selected.id}
                  options={applicable.map((card) => ({ value: card.id, label: cardDisplayLabel(card) }))}
                  onChange={(id) => setSelectedTrackCards((prior) => ({ ...prior, [offer.id]: id }))} />}
                <Button size="small" onClick={() => setRecord({ offerId: offer.id, title: offer.rule.title,
                  cardId: selected.id, cardLabel: cardDisplayLabel(selected),
                  state: offer.records.find((item) => item.cardId === selected.id)?.state })}>收藏 / 跟踪</Button>
              </>}
            </Space>}
          </Flex>
        </Card>;
      })}
    </div>;
  }

  const searchForm = (byQuestion: boolean) => <Card className="offers-search-panel">
    <Form<OfferFilters & { text: string }> layout="vertical" onFinish={(value) => void lookup(value, byQuestion)}>
      <Form.Item name="text" label={byQuestion ? '你想买什么或去哪儿消费' : '商户名称'} rules={[{ required: true, whitespace: true }]}>
        {byQuestion ? <Input.TextArea maxLength={240} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="比如：今晚吃海底捞，用哪张卡？" />
          : <Input maxLength={80} placeholder="如 海底捞、奈雪" />}
      </Form.Item>
      {byQuestion && catalog.data?.ollamaEnabled && <Typography.Paragraph type="secondary">复杂问法可由本地模型识别商户。</Typography.Paragraph>}
      <Collapse size="small" items={[{ key: 'filters', label: '城市、日期、预算（选填）',
        children: <div className="offers-field-grid">
          <Form.Item name="city" label="城市"><Input maxLength={60} placeholder="如 北京" /></Form.Item>
          <Form.Item name="store" label="门店"><Input maxLength={100} /></Form.Item>
          <Form.Item name="date" label="消费日期"><Input type="date" /></Form.Item>
          <Form.Item name="time" label="消费时间"><Input type="time" /></Form.Item>
          <Form.Item name="budget" label="预算（元）"><InputNumber min={0} max={999_999} precision={2} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="channel" label="支付方式"><Select allowClear options={paymentOptions} /></Form.Item>
        </div>,
      }]} />
      <Button className="offers-form-feedback" type="primary" htmlType="submit" loading={busy}>{byQuestion ? '查询划算方案' : '搜索优惠'}</Button>
    </Form>
  </Card>;

  const items = [
    { key: 'ask', label: '问 AI', children: tab === 'ask' ? searchForm(true) : null },
    { key: 'search', label: '搜优惠', children: tab === 'search' ? searchForm(false) : null },
    { key: 'benefits', label: '我的权益', children: libraryCards(library.filter((item) => item.rule.kind === 'benefit')) },
    { key: 'saved', label: '已收藏', children: libraryCards(library.filter((item) => item.review === 'ready' && item.records.some((row) => row.state.favorite)), true) },
    { key: 'manage', label: '维护活动', children: libraryCards(library.filter((item) => item.rule.kind === 'activity')) },
    { key: 'cards', label: '卡片资料', children: <div className="offers-results-grid">
      {cards.map((card) => <Card key={card.id} size="small" title={cardDisplayLabel(card)}
        extra={<Button type="link" size="small" onClick={() => setProfile(card)}>编辑</Button>}>
        {[card.profile.product, card.profile.network].filter(Boolean).join(' · ') || '待填写卡产品和卡组织'}
      </Card>)}
      {!cards.length && <Empty description="请先在卡片管理中添加信用卡" />}
    </div> },
    { key: 'sources', label: '活动来源', children: <Flex vertical gap={12}>
      {tab === 'sources' && <WechatOfferSources onImported={refresh} />}
      {sources.error && <Alert type="error" title={sources.error} />}
      {sources.loading && <Spin />}
      {sources.data?.map((source) => <Card key={source.key} size="small" title={source.name}>
        <Flex vertical gap={8}>
          <Space wrap>
            <Switch checked={source.enabled} disabled={Boolean(sourceBusy)} aria-label={`${source.name}自动同步`}
              onChange={(enabled) => void sourceChange(source, enabled)} />
            <Typography.Text>每日同步</Typography.Text>
            <Button size="small" loading={sourceBusy === source.key} disabled={Boolean(sourceBusy && sourceBusy !== source.key)}
              onClick={() => void sourceChange(source)}>立即刷新</Button>
            <a href={source.url} target="_blank" rel="noreferrer">官方来源</a>
          </Space>
          <Typography.Text type="secondary">{source.lastSuccess ? `最近同步 ${displayDate(source.lastSuccess, { time: true })}` : '尚未同步'}</Typography.Text>
          {source.error && <Alert type="warning" title={source.error} />}
        </Flex>
      </Card>)}
    </Flex> },
  ];

  return <Page title="权益与活动">
    <Flex className="offers-page" vertical gap={14}>
      <Space wrap>
        <Button onClick={() => setEditor({ kind: 'benefit' })}>记录权益</Button>
        <Button onClick={() => setEditor({ kind: 'activity' })}>新增活动</Button>
      </Space>
      {catalog.error && <Alert type="error" title={catalog.error} action={<Button size="small" onClick={refresh}>重试</Button>} />}
      <Tabs activeKey={tab} onChange={(key) => { setTab(key); setError(''); }} items={items} />
      {(tab === 'ask' || tab === 'search') && <>
        {error && <Alert type="error" title={error} />}
        {answer && <>
          <Typography.Title level={5} className="offers-results-title">{answer.query.merchant} · {answer.query.date}</Typography.Title>
          {Boolean(answer.syncIssues?.length) && <Alert type="warning"
            title={`${answer.syncIssues!.join('、')}同步失败，仍可查询已收录的活动。`}
            action={<Button size="small" onClick={() => setTab('sources')}>查看来源状态</Button>} />}
          {answer.tiers.length > 0 && <Flex wrap gap={8} aria-label="按消费门槛推荐">
            {answer.tiers.map((tier) => {
              const match = answer.results.find((row) => row.offerId === tier.offerId && row.card.id === tier.cardId);
              return match && <Tag key={tier.amount} color="blue">{tier.amount ? `满 ${yuan(tier.amount)}` : '无门槛'}
                {' · '}{match.title} · {match.card.nickname || match.card.bankName}
                {match.status !== 'ready' ? `（${statusInfo[match.status].name}）` : ''}</Tag>;
            })}
          </Flex>}
          {answer.combinations.map((combo, index) => <Card size="small" key={`${combo.card.id}:${combo.offerIds.join(':')}`}>
            <Flex vertical gap={6}>
              <Typography.Text strong>{answer.prefersCombination && index === 0 ? '首选 · ' : ''}可叠加 · 预计实付 {yuan(combo.pay)}</Typography.Text>
              <Typography.Text>{cardDisplayLabel(combo.card)} · {combo.titles.join(' + ')}</Typography.Text>
              {combo.channels.length > 0 && <Typography.Text type="secondary">{combo.channels.map((item) => paymentChannels[item]).join(' / ')}</Typography.Text>}
            </Flex>
          </Card>)}
          {answer.results.length ? (
            <div className="offers-results-grid">{answer.results.map((result, index) => (
              <CandidateCard key={`${result.offerId}:${result.card.id}`} result={result} date={answer.query.date}
                first={index === 0 && !answer.prefersCombination} follow={setRecord} />
            ))}</div>
          ) : <Empty description={emptyReasons[answer.emptyReason ?? 'merchant']}>
            <Space wrap>
              <Button onClick={() => setTab('sources')}>查看活动来源</Button>
              <Button onClick={() => setEditor({ kind: 'activity', merchant: answer.query.merchant })}>录入银行 App 中的活动</Button>
            </Space>
          </Empty>}
        </>}
      </>}
      {editor && <OfferEditor offer={editor.offer} kind={editor.kind} merchant={editor.merchant} cards={cards} library={library} close={() => setEditor(undefined)}
        afterSave={(kind) => { refreshQuery(); setTab(kind === 'benefit' ? 'benefits' : 'manage'); }} />}
      {profile && <CardProfileEditor card={profile} close={() => setProfile(undefined)} saved={refreshQuery} />}
      {record && <OfferRecordEditor target={record} close={() => setRecord(undefined)} saved={refreshQuery} />}
      {history && <OfferHistory offer={history} close={() => setHistory(undefined)} />}
      {archive && <Modal open title="归档这条活动？" onCancel={() => setArchive(undefined)} onOk={async () => {
        try { await api.post(`/api/offers/${archive.id}/archive`); setArchive(undefined); refreshQuery(); }
        catch (err) { message.error(err instanceof Error ? err.message : '归档失败'); }
      }}>归档后会从搜索结果和提醒中移除，可通过编辑重新启用。</Modal>}
    </Flex>
  </Page>;
}
