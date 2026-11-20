import type { CardDisplayIdentity } from '../api/types';

/** 保留原有的银行名和卡尾，只追加用户设置的别名。 */
export function withCardNickname(label: string, nickname?: string | null): string {
  const name = nickname?.trim();
  return name ? `${label} · ${name}` : label;
}

export function cardDisplayLabel(card: {
  bankName: string;
  cardLast4?: string | null;
  displayLast4?: string | null;
  nickname?: string | null;
}): string {
  return withCardNickname(`${card.bankName}（${card.displayLast4 || card.cardLast4 || '----'}）`, card.nickname);
}

export function nicknameForTail(cards: readonly CardDisplayIdentity[], bankName: string, cardLast4: string): string | null {
  const matches = cards.filter((card) => card.bankName === bankName
    && (card.cardLast4 === cardLast4 || card.displayLast4 === cardLast4));
  return matches.length === 1 ? matches[0].nickname ?? null : null;
}

export function cardTailsWithNicknames(tails: readonly string[], bankName: string, cards: readonly CardDisplayIdentity[]): string[] {
  return tails.map((tail) => withCardNickname(tail, nicknameForTail(cards, bankName, tail)));
}
