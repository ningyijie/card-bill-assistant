import { describe, expect, it } from 'vitest';
import { cardDisplayLabel, cardTailsWithNicknames } from './cardDisplay';

describe('卡片别名展示', () => {
  it('追加别名，同时保留银行名称与展示卡尾', () => {
    expect(cardDisplayLabel({ bankName: '测试银行', cardLast4: '0000', displayLast4: '9876', nickname: ' 优享白 ' }))
      .toBe('测试银行（9876） · 优享白');
    expect(cardDisplayLabel({ bankName: '测试银行', cardLast4: '9876', nickname: ' ' })).toBe('测试银行（9876）');
  });

  it('仅在银行和卡尾可唯一对应时附加别名', () => {
    const first = { id: 1, bankName: '测试银行', cardLast4: '1234', nickname: '主卡' };
    const other = { ...first, id: 2, bankName: '其他银行', nickname: '他行卡' };
    expect(cardTailsWithNicknames(['1234', '4567'], '测试银行', [first, other])).toEqual(['1234 · 主卡', '4567']);
    expect(cardTailsWithNicknames(['1234'], '测试银行', [first, { ...first, id: 3 }])).toEqual(['1234']);
  });
});
