import assert from 'node:assert/strict';
import { prisma } from './src/lib/prisma.ts';
import { encrypt } from './src/lib/crypto.ts';
import { config } from './src/config.ts';
import { refreshWereadCollection } from './src/modules/offers/wechat-weread-collection.ts';

const bookId = 'MP_WXS_3209006872';
const articleId = 'image_fixture_q1';
const articleUrl = 'https://mp.weixin.qq.com/s/' + articleId;
const fixture = "<script>try { window.cgiDataNew = { title:'测试优惠', desc:'中信银行海底捞消费满200元减50元\\n活动限指定门店', " +
  "content_noencode:'仅供分享的摘要', item_show_type:'8' * 1, picture_page_info_list:[{cdn_url:'https://mmbiz.qpic.cn/example'}] }; } catch (error) {} </script>";
let documentReads = 0;
globalThis.fetch = async (input) => {
  const url = new URL(input);
  assert.equal(url.origin, 'https://weread.qq.com');
  if (url.pathname === '/web/mp/articles') return Response.json({ reviews: [] });
  if (url.pathname === '/api/mp/cover') return Response.json({ title: '测试优惠', reviewId: bookId + '_' + articleId });
  assert.equal(url.pathname, '/web/mp/content');
  assert.equal(url.searchParams.get('reviewId'), bookId + '_' + articleId);
  documentReads++;
  return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
};
try {
  await prisma.card.create({data: {bankName: '中信银行', cardLast4: '1234', statementDay: 5, remindDaysBefore: [] }});
  await prisma.wechatOfferSubscription.create({ data: {
    id: 2, authorizedAt: new Date(), accountId: bookId, accountName: '测试公众号', enabled: true,
    credential: encrypt(config.encryptionKey, JSON.stringify({ wr_vid: '123', wr_skey: 'test-token' })),
  } });
  assert.deepEqual(await refreshWereadCollection(false, new Date(2026, 10, 26, 8)), {
    discovered: 1, updated: 1, skipped: 0, missing: 0, latestOnly: true,
  });
  const saved = await prisma.rewardOffer.findMany();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].review, 'draft');
  assert.deepEqual(saved[0].rule.discount, { type: 'fixed', amount: 50 });
  assert.equal(saved[0].rule.threshold, 200);
  assert.equal(saved[0].rule.sourceUrl, articleUrl);
  assert.deepEqual(await refreshWereadCollection(true, new Date(2026, 10, 26, 8, 2)), {
    discovered: 1, updated: 0, skipped: 1, missing: 0, latestOnly: true,
  });
  assert.equal(documentReads, 1);
  assert.equal(await prisma.rewardOffer.count(), 1);
  console.log('Default Linux Docker: scheduled image caption sync, MySQL draft and deduplication passed with Chromium unavailable.');
} finally {
  await prisma.$disconnect();
}
