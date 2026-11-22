export const networkOptions = ['银联', 'Visa', '万事达', '美国运通', 'JCB', '其他'];
export const paymentChannels = {
  wechat: '微信支付', alipay: '支付宝', unionpay: '云闪付', bank_app: '银行 App',
  pos: '线下刷卡', merchant_app: '商户 App',
};
export const discountTypes = {
  fixed: '固定满减', percent: '折扣', random: '随机立减', points: '积分 / UP 金兑换',
  cashback: '次月返现', service: '兑换或服务权益',
};
export type PaymentChannel = keyof typeof paymentChannels;
export type Discount = {
  type: keyof typeof discountTypes;
  amount?: number; rate?: number; cap?: number; min?: number; max?: number;
  cost?: number; unit?: '积分' | 'UP金'; purchasePrice?: number;
};
export interface OfferRule {
  title: string;
  kind: 'activity' | 'benefit';
  merchants: string[]; cities: string[]; stores: string[];
  channels: PaymentChannel[];
  bankName?: string; product?: string; network?: string; cardIds: number[];
  startsOn?: string; endsOn?: string; weekdays: number[];
  startsAt?: string; endsAt?: string; claimOn?: string; claimAt?: string;
  threshold?: number; discount: Discount;
  requiresClaim: boolean; requiresRegistration: boolean; needsEligibility: boolean; limited: boolean;
  stacking?: string; stackWith: number[]; cycle?: 'month' | 'year' | 'once'; totalUses?: number; spendRuleId?: string;
  entry?: string; sourceUrl?: string; sourceText?: string;
}
export interface OfferCard {
  id: number; bankName: string; nickname: string | null; displayLast4: string;
  profile: { product?: string; network?: string; points?: number; upGold?: number;
    valuePer1000Points?: number; valuePer1000UpGold?: number };
}
export interface OfferRecord {
  favorite: boolean; status: 'tracked' | 'registered' | 'claimed' | 'used';
  eligible?: boolean; remaining?: number; voucherEndsOn?: string;
  reminder?: 'claim' | 'expiry' | 'month_end';
}
export interface CatalogOffer {
  id: number; rule: OfferRule; review: 'ready' | 'draft' | 'archived';
  verifiedAt: string | null; applicableCardIds: number[]; sourceKey: string | null;
  records: { cardId: number; state: OfferRecord }[];
}
export interface OfferCatalog { cards: OfferCard[]; offers: CatalogOffer[]; ollamaEnabled: boolean }
export interface OfferFilters { city?: string; store?: string; date?: string; time?: string; budget?: number; channel?: PaymentChannel }
export interface OfferCandidate {
  offerId: number; title: string; rule: OfferRule; card: Omit<OfferCard, 'profile'>;
  verifiedAt: string | null; status: 'ready' | 'action' | 'check'; neededActions: string[]; needsCheck: string[];
  state: OfferRecord | null;
  quote: {
    pay: number | null; saving: number | null; cashback: number | null; randomMax: number | null;
    pointCost: { cost: number; unit: string; balance: number | null; valuePer1000: number | null } | null;
    comparableCost: number | null;
  };
  progress?: { bankCount?: number | null; estimatedCount?: number | null; bankAmount: number | null; estimatedAmount: number | null;
    remaining: number | null; startsOn: string; endsOn: string };
}
export interface OfferSearchResult {
  query: OfferFilters & { merchant: string; date: string };
  results: OfferCandidate[];
  tiers: { amount: number; offerId: number; cardId: number }[];
  combinations: { card: OfferCandidate['card']; offerIds: number[]; titles: string[]; channels: PaymentChannel[]; saving: number; pay: number }[];
  prefersCombination: boolean;
  interpretation?: 'local' | 'ollama';
}
export interface OfferSource { key: string; name: string; url: string; enabled: boolean; lastSuccess: string | null; error: string | null }
