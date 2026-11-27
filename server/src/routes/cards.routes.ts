import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';
import { withValidPin } from '../modules/auth/auth.service';
import { decrypt, encrypt } from '../lib/crypto';
import { computeCycle } from '../modules/reminders/reminder.engine';
import { lastPassedCycle, openMissingCycle } from '../modules/bills/ledger';
import { fromYmd, monthParts, today } from '../lib/dates';
import { allCardGroups, recomputePrimary } from '../lib/card-groups';
import { reconcileUnfinishedPlaceholderCards } from '../lib/card-placeholders';
import { annualFeeReviewStatuses, annualFeeSettlementModes, loadAnnualFeeTracking } from '../modules/bills/annual-fee-tracking';
import { loadCardSpendProgress, spendCard, spendStatementDates } from '../modules/bills/card-spend-service';
import { cardProfileSchema, readCardProfile } from '../modules/offers/rules';
import {
  annualFeeWaivers, readSpendRules,
  spendAmountSchema, spendCountSchema, spendDateSchema, spendPeriods, spendRuleIdSchema, spendRulesSchema,
} from '../modules/bills/card-spend-tracking';

const router = Router();
router.use(requireAuth);

const annualFeeDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '年费收取日格式应为 YYYY-MM-DD')
  .nullable()
  .optional();

const annualFeePolicySchema = z.object({
  charge: z.enum(['annual', 'firstYearFree', 'free', 'other']).optional(),
  amount: z.number().nonnegative().max(999_999_999.99).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  waiver: z.enum(annualFeeWaivers).optional(),
  settlement: z.enum(annualFeeSettlementModes).optional(),
  requiredCount: z.number().int().min(1).max(100_000).optional(),
  confirmedCount: z.number().int().min(0).max(100_000).optional(),
  requiredPoints: z.number().int().min(1).max(1_000_000_000).optional(),
  availablePoints: z.number().int().min(0).max(1_000_000_000).optional(),
  cycleEnd: z.iso.date().optional(),
  notes: z.string().trim().max(400).optional(),
  spendRules: spendRulesSchema.optional(),
  annualFeeSpendRuleId: spendRuleIdSchema.optional(),
  pointsDeadline: spendDateSchema.optional(),
}).refine((policy) => !policy.annualFeeSpendRuleId || policy.spendRules?.some((rule) => rule.id === policy.annualFeeSpendRuleId), {
  path: ['annualFeeSpendRuleId'],
  message: '请选择本卡已配置的消费跟踪规则',
}).transform((policy) => Object.values(policy).some((value) => value !== undefined && value !== '') ? policy : null);

const cardCreateSchema = z.object({
  bankName: z.string().trim().min(1, '银行名不能为空'),
  cardLast4: z.string().regex(/^\d{4}$/, '卡号后 4 位必须为 4 位数字'),
  holderName: z.string().trim().max(64).optional().nullable(),
  nickname: z.string().trim().max(32).optional().nullable(),
  currency: z.string().trim().length(3).default('CNY'),
  statementDay: z.number().int().min(1).max(31),
  dueRule: z.enum(['fixed', 'offset']),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  dueOffsetDays: z.number().int().min(0).max(40).nullable().optional(),
  remindDaysBefore: z.array(z.number().int().min(0).max(60)).default([3, 1, 0]),
  annualFeeDate: annualFeeDateSchema,
  annualFeePolicy: annualFeePolicySchema.nullable().optional(),
  rewardProfile: cardProfileSchema.optional(),
  /** 卡片配色序号（前端色表下标，上限与 CARD_PALETTE_COUNT-1 联动）；null = 自动分配 */
  colorPalette: z.number().int().min(0).max(31).nullable().optional(),
});

// 编辑接口不接受卡号后四位，也不复用新增表单的默认值，避免局部修改时意外覆盖原设置。
// 银行名称保留在 schema 中仅为兼容表单原样回传；实际修改在下方直接拒绝。
const cardUpdateSchema = z.object({
  bankName: z.string().trim().min(1, '银行名不能为空').optional(),
  holderName: z.string().trim().max(64).optional().nullable(),
  nickname: z.string().trim().max(32).optional().nullable(),
  currency: z.string().trim().length(3).optional(),
  statementDay: z.number().int().min(1).max(31).optional(),
  dueRule: z.enum(['fixed', 'offset']).optional(),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  dueOffsetDays: z.number().int().min(0).max(40).nullable().optional(),
  remindDaysBefore: z.array(z.number().int().min(0).max(60)).optional(),
  annualFeeDate: annualFeeDateSchema,
  annualFeePolicy: annualFeePolicySchema.nullable().optional(),
  rewardProfile: cardProfileSchema.optional(),
  colorPalette: z.number().int().min(0).max(31).nullable().optional(),
  status: z.enum(['active', 'frozen', 'closed']).optional(),
}).strict();

function validateDueRule(
  dueRule: 'fixed' | 'offset',
  dueDay: number | null | undefined,
  dueOffsetDays: number | null | undefined,
): void {
  if (dueRule === 'fixed' && !dueDay) throw new ApiError(400, '固定还款日模式下必须填写还款日（几号）');
  if (dueRule === 'offset' && (dueOffsetDays == null || dueOffsetDays < 0)) {
    throw new ApiError(400, '出账日偏移模式下必须填写还款日距出账日的天数');
  }
}

/** 列表：含敏感字段有无标记 + 当前账期推算 + 套卡分组（只看出账日与还款规则） */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const cards = await prisma.card.findMany({
      where: { hidden: false },
      orderBy: [{ bankName: 'asc' }, { cardLast4: 'asc' }],
    });
    const now = today();
    const { year, month } = monthParts(now);
    const cardById = new Map(cards.map((card) => [card.id, card] as const));

    const visibleIds = new Set(cards.map((c) => c.id));
    const groups = await allCardGroups();
    const groupOfCard = new Map<number, number[]>();
    for (const members of groups.values()) {
      const visibleMembers = members.filter((id) => visibleIds.has(id));
      for (const id of visibleMembers) groupOfCard.set(id, visibleMembers);
    }
    const businessMembers = (card: (typeof cards)[number]) => {
      const primaryId = card.businessRole === 'primary' ? card.id : card.businessPrimaryId;
      if (primaryId == null) return [];
      return cards
        .filter((candidate) => candidate.id === primaryId || candidate.businessPrimaryId === primaryId)
        .map((candidate) => ({
          id: candidate.id,
          cardLast4: candidate.displayLast4,
          role: candidate.businessRole,
        }));
    };

    const result = await Promise.all(
      cards.map(async (card) => {
        const billingCard = card.businessPrimaryId ? (cardById.get(card.businessPrimaryId) ?? card) : card;
        const calendarPeriod = `${year}-${String(month).padStart(2, '0')}`;
        const last = lastPassedCycle(billingCard, now);
        const lastYear = Number(last.period.slice(0, 4));
        const lastMonth = Number(last.period.slice(5, 7));
        // 本期应还看上一期已过出账日；合并账单按关联查
        const periodBills = await prisma.bill.findMany({
          where: {
            period: last.period,
            OR: [{ cardId: billingCard.id }, { cards: { some: { cardId: billingCard.id } } }],
          },
          include: { cards: { select: { cardId: true } } },
          orderBy: [{ paidStatus: 'asc' }, { currency: 'asc' }, { id: 'asc' }],
        });
        const unpaidBills = periodBills.filter((bill) => bill.paidStatus !== 'paid');
        const representativeBill = unpaidBills[0] ?? periodBills[0] ?? null;
        const missing = card.businessPrimaryId == null
          && periodBills.length === 0
          && openMissingCycle(billingCard, now)?.period === last.period;
        // 未还清或未取得走上一期；已还清且已跨月则切到日历月，避免下一还款停在过去
        const useLast = missing || (periodBills.length > 0 && (unpaidBills.length > 0 || last.period === calendarPeriod));
        const cardLike = { ...billingCard, remindDaysBefore: billingCard.remindDaysBefore as number[] };
        const cycle = useLast
          ? computeCycle(cardLike, lastYear, lastMonth, representativeBill)
          : computeCycle(cardLike, year, month, null);
        const period = useLast ? last.period : calendarPeriod;
        const shownBill = useLast ? representativeBill : null;
        const shownBills = useLast ? periodBills : [];
        const amountBill = useLast && (periodBills.length === 1 || unpaidBills.length === 1)
          ? representativeBill
          : null;
        const linkedCardIds = [shownBill?.cardId, ...(shownBill?.cards ?? []).map((bc) => bc.cardId)]
          .filter((id): id is number => id != null)
          .filter((id, idx, arr) => arr.indexOf(id) === idx);
        return {
          id: card.id,
          bankName: card.bankName,
          cardLast4: card.cardLast4,
          displayLast4: card.displayLast4,
          priority: card.priority,
          holderName: card.holderName,
          nickname: card.nickname,
          currency: card.currency,
          statementDay: card.statementDay,
          dueRule: card.dueRule,
          dueDay: card.dueDay,
          dueOffsetDays: card.dueOffsetDays,
          remindDaysBefore: card.remindDaysBefore,
          annualFeeDate: card.annualFeeDate?.toISOString() ?? null,
          annualFeeDateManual: card.annualFeeDateManual,
          annualFeePolicy: card.annualFeePolicy,
          rewardProfile: readCardProfile(card.rewardProfile),
          colorPalette: card.colorPalette,
          businessRole: card.businessRole,
          businessPrimaryCardId: card.businessPrimaryId,
          businessPrimaryCardLast4: card.businessPrimaryId
            ? (cardById.get(card.businessPrimaryId)?.displayLast4 ?? null)
            : null,
          businessPrimaryCardNickname: card.businessPrimaryId
            ? (cardById.get(card.businessPrimaryId)?.nickname ?? null)
            : null,
          billingEditable: card.businessRole !== 'secondary' && card.businessRole !== 'supplementary',
          businessGroupMembers: businessMembers(card),
          source: card.source,
          status: card.status,
          hasSecret: !!(card.cardNoFullEnc || card.expDateEnc || card.cvvEnc),
          /** 套卡内全部卡 ID（按出账日与还款规则归组，含本卡；单卡组仅自身） */
          groupCardIds: groupOfCard.get(card.id) ?? [card.id],
          /** 套卡内优先显示卡 */
          isPrimary: card.isPrimary,
          /** 用户指定的优先显示卡 */
          primaryManual: card.primaryManual,
          /** 本卡是否承接当期账单（标识字段，不参与自动选定） */
          isBillOwner: shownBill?.cardId === card.id,
          currentCycle: {
            period,
            statementDate: cycle.statementDate.toISOString(),
            dueDate: cycle.dueDate.toISOString(),
            hasBill: shownBills.length > 0,
            missing,
            amount: amountBill?.amount != null ? Number(amountBill.amount) : null,
            minAmount: amountBill?.minAmount != null ? Number(amountBill.minAmount) : null,
            currency: amountBill?.currency ?? null,
            paidStatus: amountBill?.paidStatus ?? null,
            billCount: shownBills.length,
            unpaidBillCount: unpaidBills.length,
            /** 合并账单全部关联卡尾号（含本卡，普通账单仅本卡） */
            cardTails: linkedCardIds.map(
              (cid) => cards.find((c) => c.id === cid)?.displayLast4 ?? '',
            ).filter(Boolean),
          },
          createdAt: card.createdAt.toISOString(),
        };
      }),
    );
    res.json(result);
  }),
);

// 创建
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = cardCreateSchema.parse(req.body);
    validateDueRule(input.dueRule, input.dueDay, input.dueOffsetDays);
    const exists = await prisma.card.findUnique({
      where: { bankName_cardLast4: { bankName: input.bankName, cardLast4: input.cardLast4 } },
    });
    if (exists) throw new ApiError(409, `已存在 ${input.bankName}（${input.cardLast4}）的卡档案`);
    const card = await prisma.$transaction(async (tx) => {
      const created = await tx.card.create({ data: {
        bankName: input.bankName,
        cardLast4: input.cardLast4,
        displayLast4: input.cardLast4,
        holderName: input.holderName || null,
        nickname: input.nickname || null,
        currency: input.currency,
        statementDay: input.statementDay,
        dueRule: input.dueRule,
        dueDay: input.dueRule === 'fixed' ? input.dueDay! : null,
        dueOffsetDays: input.dueRule === 'offset' ? input.dueOffsetDays! : null,
        remindDaysBefore: input.remindDaysBefore,
        annualFeeDate: input.annualFeeDate ? fromYmd(input.annualFeeDate) : null,
        annualFeeDateManual: input.annualFeeDate ? true : false,
        ...(input.annualFeePolicy ? { annualFeePolicy: input.annualFeePolicy } : {}),
        ...(input.rewardProfile !== undefined ? { rewardProfile: input.rewardProfile } : {}),
        colorPalette: input.colorPalette ?? null,
        source: 'manual',
      } });
      await reconcileUnfinishedPlaceholderCards(tx, { bankNames: [input.bankName] });
      return created;
    });
    await recomputePrimary();
    res.status(201).json({ id: card.id });
  }),
);

const annualFeeReviewKeySchema = z.object({
  id: z.coerce.number().int().positive(),
  period: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  currency: z.string().regex(/^[A-Z0-9]{3,8}$/),
});

router.get(
  '/annual-fees',
  asyncHandler(async (req, res) => {
    const query = z.object({
      cardId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);
    const rows = await loadAnnualFeeTracking();
    res.json(query.cardId === undefined ? rows : rows.filter((row) => row.cardId === query.cardId));
  }),
);

router.put(
  '/:id/annual-fees/:period/:currency',
  asyncHandler(async (req, res) => {
    const { id: cardId, period, currency } = annualFeeReviewKeySchema.parse(req.params);
    const { status } = z.object({ status: z.enum(annualFeeReviewStatuses).nullable() }).strict().parse(req.body);
    const key = { cardId, period, currency };
    const rows = await loadAnnualFeeTracking();
    if (!rows.some((row) => row.cardId === cardId && row.period === period && row.currency === currency)) {
      throw new ApiError(404, '未找到这笔年费记录');
    }
    if (status === null) {
      await prisma.annualFeeReview.deleteMany({ where: key });
    } else {
      await prisma.$executeRaw`
        INSERT INTO \`AnnualFeeReview\` (\`cardId\`, \`period\`, \`currency\`, \`status\`)
        VALUES (${cardId}, ${period}, ${currency}, ${status})
        ON DUPLICATE KEY UPDATE \`status\` = ${status}
      `;
    }
    res.json({ ok: true });
  }),
);

router.get('/:id/spend-progress', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  res.json(await loadCardSpendProgress(id));
}));

router.put('/:id/spend-progress/:ruleId', asyncHandler(async (req, res) => {
  const { id, ruleId } = z.object({
    id: z.coerce.number().int().positive(), ruleId: spendRuleIdSchema,
  }).parse(req.params);
  const periodKeySchema = z.string().min(1).max(50);
  const confirmation = z.union([
    z.strictObject({ periodKey: periodKeySchema, amount: spendAmountSchema.nullable() }),
    z.strictObject({ periodKey: periodKeySchema, count: spendCountSchema.nullable() }),
  ]).parse(req.body);
  const card = await spendCard(id);
  const rule = readSpendRules(card.annualFeePolicy).find((candidate) => candidate.id === ruleId);
  if (!rule) throw new ApiError(404, '消费跟踪规则不存在');
  const byCount = 'count' in confirmation;
  if (byCount !== (rule.metric === 'count')) throw new ApiError(400, '确认值必须与消费规则的统计方式一致');
  const { periodKey } = confirmation;
  const value = byCount ? confirmation.count : confirmation.amount;
  const now = today();
  const statementDates = rule.basis === 'statement_month' ? await spendStatementDates(id, card.businessPrimaryId) : new Map<string, Date>();
  const period = spendPeriods(rule, now, card.businessPrimary?.statementDay ?? card.statementDay, statementDates)
    .find((candidate) => candidate.key === periodKey);
  if (!period || fromYmd(period.startsOn) > now) throw new ApiError(400, '该统计期尚不可填写');
  const key = { cardId: id, ruleId, periodKey };
  if (value === null) {
    await prisma.cardSpendConfirmation.deleteMany({ where: key });
  } else {
    await prisma.$executeRaw`
      INSERT INTO \`CardSpendConfirmation\` (\`cardId\`, \`ruleId\`, \`periodKey\`, \`amount\`)
      VALUES (${id}, ${ruleId}, ${periodKey}, ${value})
      ON DUPLICATE KEY UPDATE \`amount\` = ${value}
    `;
  }
  res.json({ ok: true });
}));

// 详情（含历史账单）
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const card = await prisma.card.findUnique({ where: { id } });
    if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');
    const bills = await prisma.bill.findMany({
      where: { OR: [{ cardId: id }, { cards: { some: { cardId: id } } }] },
      orderBy: { period: 'desc' },
      take: 24,
    });
    const primaryId = card.businessRole === 'primary' ? card.id : card.businessPrimaryId;
    const relatedCards = primaryId == null
      ? []
      : await prisma.card.findMany({
          where: { hidden: false, OR: [{ id: primaryId }, { businessPrimaryId: primaryId }] },
          select: { id: true, displayLast4: true, nickname: true, businessRole: true },
        });
    const primary = relatedCards.find((candidate) => candidate.id === primaryId) ?? null;
    res.json({
      id: card.id,
      bankName: card.bankName,
      cardLast4: card.cardLast4,
      displayLast4: card.displayLast4,
      priority: card.priority,
      holderName: card.holderName,
      nickname: card.nickname,
      currency: card.currency,
      statementDay: card.statementDay,
      dueRule: card.dueRule,
      dueDay: card.dueDay,
      dueOffsetDays: card.dueOffsetDays,
      remindDaysBefore: card.remindDaysBefore,
      annualFeeDate: card.annualFeeDate?.toISOString() ?? null,
      annualFeeDateManual: card.annualFeeDateManual,
      annualFeePolicy: card.annualFeePolicy,
      rewardProfile: readCardProfile(card.rewardProfile),
      colorPalette: card.colorPalette,
      businessRole: card.businessRole,
      businessPrimaryCardId: card.businessPrimaryId,
      businessPrimaryCardLast4: card.businessPrimaryId ? primary?.displayLast4 ?? null : null,
      businessPrimaryCardNickname: card.businessPrimaryId ? primary?.nickname ?? null : null,
      billingEditable: card.businessRole !== 'secondary' && card.businessRole !== 'supplementary',
      businessGroupMembers: relatedCards.map((candidate) => ({
        id: candidate.id,
        cardLast4: candidate.displayLast4,
        role: candidate.businessRole,
      })),
      source: card.source,
      status: card.status,
      hasSecret: !!(card.cardNoFullEnc || card.expDateEnc || card.cvvEnc),
      secretFields: {
        cardNoFull: !!card.cardNoFullEnc,
        expDate: !!card.expDateEnc,
        cvv: !!card.cvvEnc,
      },
      bills: bills.map((b) => ({
        id: b.id,
        period: b.period,
        statementDate: b.statementDate.toISOString(),
        dueDate: b.dueDate.toISOString(),
        amount: b.amount != null ? Number(b.amount) : null,
        minAmount: b.minAmount != null ? Number(b.minAmount) : null,
        currency: b.currency,
        paidStatus: b.paidStatus,
        paidAt: b.paidAt?.toISOString() ?? null,
      })),
    });
  }),
);

// 更新
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const card = await prisma.card.findUnique({ where: { id } });
    if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');
    const input = cardUpdateSchema.parse(req.body);
    // 银行名称是账单解析匹配键的一半，改名会导致后续账单匹配不到原卡，禁止修改
    if (input.bankName !== undefined && input.bankName !== card.bankName) {
      throw new ApiError(400, '银行名称不支持修改');
    }

    if (card.businessRole === 'secondary' || card.businessRole === 'supplementary') {
      const locked = [
        input.bankName,
        input.currency,
        input.statementDay,
        input.dueRule,
        input.dueDay,
        input.dueOffsetDays,
        input.remindDaysBefore,
      ].some((value) => value !== undefined);
      if (locked) throw new ApiError(400, '副卡和附属卡不能修改账单设置');
      if (card.businessRole === 'secondary' && input.holderName !== undefined) {
        throw new ApiError(400, '副卡持卡人由主卡统一管理');
      }
    }

    const dueRule = input.dueRule ?? (card.dueRule as 'fixed' | 'offset');
    const dueDay = input.dueDay !== undefined ? input.dueDay : card.dueDay;
    const dueOffsetDays = input.dueOffsetDays !== undefined ? input.dueOffsetDays : card.dueOffsetDays;
    if (input.dueRule || input.dueDay !== undefined || input.dueOffsetDays !== undefined) {
      validateDueRule(dueRule, dueDay, dueOffsetDays);
    }

    const updateData = {
        ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
        ...(input.holderName !== undefined ? { holderName: input.holderName || null } : {}),
        ...(input.nickname !== undefined ? { nickname: input.nickname || null } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.statementDay !== undefined ? { statementDay: input.statementDay } : {}),
        ...(input.dueRule !== undefined ? { dueRule: input.dueRule } : {}),
        ...(input.dueDay !== undefined ? { dueDay } : {}),
        ...(input.dueOffsetDays !== undefined ? { dueOffsetDays } : {}),
        ...(input.remindDaysBefore !== undefined ? { remindDaysBefore: input.remindDaysBefore } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.annualFeeDate !== undefined
          ? {
              annualFeeDate: input.annualFeeDate ? fromYmd(input.annualFeeDate) : null,
              // 用户手动设置/清除即置 manual 标记，自动识别不再覆盖
              annualFeeDateManual: input.annualFeeDate ? true : false,
            }
          : {}),
        ...(input.colorPalette !== undefined ? { colorPalette: input.colorPalette } : {}),
        ...(input.annualFeePolicy !== undefined ? { annualFeePolicy: input.annualFeePolicy ?? Prisma.DbNull } : {}),
        ...(input.rewardProfile !== undefined ? { rewardProfile: input.rewardProfile } : {}),
      };
    let hiddenPlaceholder = false;
    await prisma.$transaction(async (tx) => {
      await tx.card.update({ where: { id }, data: updateData });
      if (card.businessRole === 'primary') {
        if (input.holderName !== undefined) {
          await tx.card.updateMany({
            where: { businessPrimaryId: id, businessRole: 'secondary' },
            data: { holderName: input.holderName || null },
          });
        }
        if (input.status !== undefined) {
          await tx.card.updateMany({ where: { businessPrimaryId: id }, data: { status: input.status } });
        }
        const sharedRulePatch = {
          ...(input.statementDay !== undefined ? { statementDay: input.statementDay } : {}),
          ...(input.dueRule !== undefined ? { dueRule: input.dueRule } : {}),
          ...(input.dueDay !== undefined ? { dueDay } : {}),
          ...(input.dueOffsetDays !== undefined ? { dueOffsetDays } : {}),
          ...(input.remindDaysBefore !== undefined ? { remindDaysBefore: input.remindDaysBefore } : {}),
        };
        if (Object.keys(sharedRulePatch).length > 0) {
          await tx.card.updateMany({ where: { businessPrimaryId: id }, data: sharedRulePatch });
        }
      }
      if (
        input.bankName !== undefined ||
        input.statementDay !== undefined ||
        input.dueRule !== undefined ||
        input.dueDay !== undefined ||
        input.dueOffsetDays !== undefined
      ) {
        const reconciled = await reconcileUnfinishedPlaceholderCards(tx, {
          bankNames: [input.bankName ?? card.bankName],
        });
        hiddenPlaceholder = reconciled.hiddenCardIds.length > 0;
      }
    });
    // 出账日/还款规则变更后按当前规则重算归组；冻结/注销让位复用同一套自动主卡
    if (
      input.statementDay !== undefined ||
      input.dueRule !== undefined ||
      input.dueDay !== undefined ||
      input.dueOffsetDays !== undefined ||
      input.status !== undefined ||
      hiddenPlaceholder
    ) {
      await recomputePrimary();
    }
    res.json({ ok: true });
  }),
);

// 设为优先展示（仅控制普通套卡列表哪张卡居首；单卡组无意义；仅正常使用卡可指定）
router.post(
  '/:id/primary',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const card = await prisma.card.findUnique({ where: { id } });
    if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');
    if (card.status !== 'active') throw new ApiError(400, '已冻结或已注销的卡不能设为优先展示');
    if ((card.businessRole ?? 'standalone') !== 'standalone') {
      throw new ApiError(400, '主卡、副卡和附属卡的业务关系由账单确定，不能设置优先展示卡');
    }
    const groups = await allCardGroups();
    const members = [...groups.values()].find((m) => m.includes(id));
    if (!members || members.length <= 1) {
      throw new ApiError(400, '单卡无需设为优先展示');
    }
    await prisma.$transaction(
      members.map((mid) =>
        prisma.card.update({
          where: { id: mid },
          data: mid === id ? { primaryManual: true } : { primaryManual: false },
        }),
      ),
    );
    await recomputePrimary();
    res.json({ ok: true });
  }),
);

// 删除（级联删除账单）
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const card = await prisma.card.findUnique({ where: { id } });
    if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');
    await prisma.$transaction(async (tx) => {
      await tx.card.delete({ where: { id } });
      await cleanupOrphanSharedTransactions(tx);
    });
    res.json({ ok: true });
  }),
);

// ===== 敏感信息（PIN 加密存储） =====

const secretSchema = z
  .object({
    pin: z.string().regex(/^\d{6}$/, 'PIN 必须为 6 位数字'),
    cardNoFull: z.string().regex(/^\d{13,19}$/, '卡号格式错误').optional(),
    expDate: z.string().regex(/^(0[1-9]|1[0-2])\/?\d{2}$/, '有效期格式应为 MM/YY').optional(),
    cvv: z.string().regex(/^\d{3,4}$/, 'CVV 格式错误').optional(),
  })
  .refine((v) => v.cardNoFull || v.expDate || v.cvv, { message: '至少填写一项敏感信息' });

// 保存/覆盖敏感信息（全量覆盖）
router.post(
  '/:id/secret',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = secretSchema.parse(req.body);
    await withValidPin(input.pin, async (key, tx) => {
      const card = await tx.card.findUnique({ where: { id } });
      if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');

      // MMYY 归一化为 MM/YY
      const expDate = input.expDate
        ? input.expDate.includes('/')
          ? input.expDate
          : `${input.expDate.slice(0, 2)}/${input.expDate.slice(2)}`
        : null;

      // 完整卡号保存闸门：按匹配尾号分闸，拒绝时不写入任何字段
      // 1) 匹配尾号已是真号：录入后四位必须与现有匹配尾号一致
      // 2) 匹配尾号是占位 + 展示尾号未完善：由完整卡号后四位写入展示尾号（仅这一次）
      // 3) 匹配尾号是占位 + 展示尾号已有四位：后四位不变（回填原值）放行，变更拒绝
      let displayLast4: string | undefined;
      if (input.cardNoFull) {
        const last4 = input.cardNoFull.slice(-4);
        const placeholder = card.cardLast4 === '----' || card.cardLast4 === '0000';
        if (!placeholder) {
          if (last4 !== card.cardLast4) {
            throw new ApiError(400, `该卡已记录的账单尾号为 ${card.cardLast4}，与本次录入的完整卡号不符`);
          }
        } else if (card.displayLast4 === '----') {
          displayLast4 = last4;
        } else if (last4 !== card.displayLast4) {
          throw new ApiError(400, `该卡已记录的账单尾号为 ${card.displayLast4}，与本次录入的完整卡号不符`);
        }
      }

      await tx.card.update({
        where: { id },
        data: {
          cardNoFullEnc: input.cardNoFull ? encrypt(key, input.cardNoFull) : null,
          expDateEnc: expDate ? encrypt(key, expDate) : null,
          cvvEnc: input.cvv ? encrypt(key, input.cvv) : null,
          ...(displayLast4 ? { displayLast4 } : {}),
        },
      });
    });
    res.json({ ok: true });
  }),
);

// 查看（PIN 即验即用，响应后弃）
router.post(
  '/:id/secret/view',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const secrets = await withValidPin(req.body?.pin, async (key, tx) => {
      const card = await tx.card.findUnique({ where: { id } });
      if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');
      if (!card.cardNoFullEnc && !card.expDateEnc && !card.cvvEnc) {
        throw new ApiError(404, '该卡尚未录入敏感信息');
      }
      return {
        cardNoFull: card.cardNoFullEnc ? decrypt(key, Buffer.from(card.cardNoFullEnc)) : null,
        expDate: card.expDateEnc ? decrypt(key, Buffer.from(card.expDateEnc)) : null,
        cvv: card.cvvEnc ? decrypt(key, Buffer.from(card.cvvEnc)) : null,
      };
    });
    res.set('Cache-Control', 'no-store').json(secrets);
  }),
);

export default router;
import { cleanupOrphanSharedTransactions } from '../modules/bills/shared-transactions';
