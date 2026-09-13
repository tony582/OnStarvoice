import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMMENT_SALES_PROMPT_RULES,
  normalizeSalesLeadJudgment,
} from '../server/services/comment-sales-judgment.js';
import {
  buildCommentSystemPrompt,
  buildCommentBatchSystemPrompt,
  buildCommentUserMessage,
  buildCommentBatchUserMessage,
  normalizeCommentAiResult,
  normalizeCommentBatchAiResults,
} from '../server/services/ai-labeler.js';
import {
  resolveLeadType,
  shouldCreateLead,
  upsertCommentLeadForComment,
} from '../server/services/comment-leads.js';

const brand = {brandName: '安吉星', brandAliases: ['OnStar'], businessContext: '车联网服务'};
const buyer = (content, overrides = {}) => ({
  sentiment: 'neutral', isNegative: false, riskLevel: 'none', category: 'other',
  salesIntent: true, salesIntentStatus: 'confirmed', salesActor: 'buyer',
  salesTargetMatch: 'relevant', salesIntentTarget: '安吉星服务', expressionType: 'literal',
  salesIntentConfidence: 0.92, salesIntentEvidence: [content],
  salesIntentReason: '评论者本人直接咨询目标服务的购买方式',
  ...overrides,
});

test('confirmed purchase requires the buyer, relevant target and verifiable comment evidence', () => {
  for (const content of ['我想买安吉星服务，怎么买？', '价格有点高，但有优惠我想订，怎么联系？', '2.1卖我吧[偷笑R]']) {
    const result = normalizeCommentAiResult(buyer(content, {
      sentiment: content.includes('价格') ? 'negative' : 'neutral',
      isNegative: content.includes('价格'),
    }), null, {comment: {content}});
    assert.equal(result.ai_result.salesIntent, true, content);
    assert.equal(resolveLeadType({content, ...result}), 'sales_intent');
    assert.equal(shouldCreateLead({content, ...result}), true);
  }
});

test('sarcasm, rhetorical questions and denied purchase cannot pass a contradictory sales boolean', () => {
  const cases = [
    ['多少钱一年的智商税？', 'sarcasm'],
    ['就这质量还想我下单？', 'rhetorical'],
    ['再优惠也不买了', 'negated'],
  ];
  for (const [content, expressionType] of cases) {
    const result = normalizeCommentAiResult(buyer(content, {
      expressionType, sentiment: 'negative', isNegative: true, riskLevel: 'low', category: 'brand_image',
    }), null, {comment: {content}});
    assert.equal(result.ai_result.salesIntent, false, content);
    assert.equal(result.ai_result.salesIntentStatus, 'rejected');
    assert.equal(result.is_negative, true, 'sales routing must not suppress the risk classification');
    assert.equal(resolveLeadType({content, ...result}), 'brand_risk');
    assert.equal(shouldCreateLead({content, ...result}), true, 'risk comment remains actionable');
  }
});

test('observed seller and quoted-promotion cases do not become buyer leads', () => {
  const cases = [
    ['私。这里发不出来。有检测报告', {salesActor: 'seller'}],
    ['185包牌落地价', {salesActor: 'seller'}],
    ['今天给我发的。好消息！车机升级，您看要预留一个名额吗？', {salesActor: 'third_party', expressionType: 'quoted'}],
    ['我想买丰田，这个价格合适吗？', {salesTargetMatch: 'irrelevant', salesIntentTarget: '丰田汽车'}],
  ];
  for (const [content, overrides] of cases) {
    const result = normalizeCommentAiResult(buyer(content, overrides), null, {comment: {content}});
    assert.equal(result.ai_result.salesIntentStatus, 'rejected', content);
    assert.notEqual(resolveLeadType({content, ...result}), 'sales_intent');
    assert.equal(shouldCreateLead({content, ...result}), false, 'neutral seller/third-party speech should not create a risk lead');
  }
});

test('uncertain buyers remain reviewable without being advertised as confirmed sales leads', () => {
  const content = '2.1卖我吧[偷笑R]';
  const cases = [
    {salesIntentConfidence: 0.5},
    {salesIntentConfidence: undefined},
    {salesIntentConfidence: 'NaN'},
    {salesIntentConfidence: 85},
    {salesIntentEvidence: ['另一位用户说我想买']},
    {salesActor: 'unknown'},
    {salesTargetMatch: 'uncertain'},
    {expressionType: 'uncertain'},
    {salesIntentStatus: 'needs_review'},
  ];
  for (const overrides of cases) {
    const result = normalizeCommentAiResult(buyer(content, overrides), null, {comment: {content}});
    assert.equal(result.ai_result.salesIntentStatus, 'needs_review', JSON.stringify(overrides));
    assert.equal(result.ai_result.salesIntent, false);
    assert.equal(shouldCreateLead({content, ...result}), true, 'uncertainty remains available for human review');
    assert.notEqual(resolveLeadType({content, ...result}), 'sales_intent');
  }
});

test('legacy booleans and bare sales keywords cannot bypass the new evidence contract', () => {
  const content = '价格这么高，谁买谁冤种';
  assert.notEqual(resolveLeadType({content, ai_result: {salesIntent: true}}), 'sales_intent');
  assert.notEqual(resolveLeadType({content, sentiment: 'negative', ai_result: {classifier: 'rule_comment'}}), 'sales_intent');
  const review = normalizeSalesLeadJudgment({salesIntent: true}, {comment: {content}});
  assert.equal(review.salesIntentStatus, 'needs_review');
  assert.deepEqual(normalizeSalesLeadJudgment(review, {comment: {content}}), review, 'normalization must be idempotent');
});

test('single and batch classification use the same rules and preserve reply context', () => {
  assert.ok(buildCommentSystemPrompt(brand).includes(COMMENT_SALES_PROMPT_RULES));
  assert.ok(buildCommentBatchSystemPrompt(brand).includes(COMMENT_SALES_PROMPT_RULES));
  const comment = {content: '2.1卖我吧[偷笑R]', parent_comment_id: 'parent-1', parent_comment_content: '这台二手车2.5万出售'};
  assert.ok(buildCommentUserMessage({comment}).includes(comment.parent_comment_content));
  const batchMessage = buildCommentBatchUserMessage({comments: [comment]});
  assert.ok(batchMessage.includes(comment.parent_comment_content));
  assert.ok(buildCommentUserMessage({comment: {...comment, parent_comment_content: ''}}).includes('原文缺失'));
});

test('batch results are matched by index and evidence cannot leak from another comment', () => {
  const comments = [{content: '我想买安吉星服务，怎么买？'}, {content: '我只是来看看'}];
  const raw = buyer(comments[0].content);
  const results = normalizeCommentBatchAiResults({results: [
    {i: 1, ...raw}, {i: 0, ...raw},
  ]}, comments);
  assert.equal(results[0].ai_result.salesIntent, true);
  assert.equal(results[1].ai_result.salesIntentStatus, 'needs_review');
  assert.deepEqual(results[1].ai_result.salesIntentEvidence, []);
  const {i: _batchIndex, ...batchAiResult} = results[0].ai_result;
  assert.deepEqual({...results[0], ai_result: batchAiResult}, normalizeCommentAiResult(raw, null, {comment: comments[0]}));
  const duplicated = normalizeCommentBatchAiResults({results: [{i: 0, ...raw}, {i: 0, ...raw}]}, comments);
  assert.deepEqual(duplicated, [null, null], 'ambiguous or omitted indexes remain queued for retry');
});

test('a truncated batch comment cannot be confirmed before its full context is reviewed', () => {
  const comment = {content: '我想买安吉星服务。' + '补充说明'.repeat(310)};
  const [result] = normalizeCommentBatchAiResults({results: [{i: 0, ...buyer('我想买安吉星服务。')}]}, [comment]);
  assert.equal(result.ai_result.salesIntentStatus, 'needs_review');
  assert.equal(shouldCreateLead({content: comment.content, ...result}), true);
});

test('neutral rejudgment updates an existing lead without deleting status, notes or manual classification', async () => {
  const content = '185包牌落地价';
  const classification = normalizeCommentAiResult(buyer(content, {salesActor: 'seller'}), null, {comment: {content}});
  const queries = [];
  const tx = {queryOne: async (sql, params) => {
    queries.push({sql, params});
    return {id: 'lead-1', status: 'following', note: '已沟通，等待核实', manual_lead_type: null};
  }};
  const lead = await upsertCommentLeadForComment(tx, {
    tenantId: 'tenant-1', record: {id: 'record-1'}, comment: {id: 'comment-1', content, ...classification},
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /UPDATE comment_leads/);
  assert.doesNotMatch(queries[0].sql, /DELETE|INSERT|status\s*=|note\s*=/);
  assert.match(queries[0].sql, /COALESCE\(manual_lead_type, \$3\)/);
  assert.equal(JSON.parse(queries[0].params[4]).salesIntent, false);
  assert.equal(lead.note, '已沟通，等待核实');
  assert.equal(lead.status, 'following');
});

test('review candidates are persisted without discarding comment content or human category overrides', async () => {
  const content = '2.1卖我吧[偷笑R]';
  const classification = normalizeCommentAiResult(buyer(content, {salesIntentConfidence: 0.5}), null, {comment: {content}});
  let written;
  await upsertCommentLeadForComment({queryOne: async (sql, params) => { written = {sql, params}; return {id: 'lead-1'}; }}, {
    tenantId: 'tenant-1', record: {id: 'record-1'}, comment: {id: 'comment-1', content, ...classification},
  });
  assert.match(written.sql, /COALESCE\(comment_leads.manual_lead_type, excluded.lead_type\)/);
  assert.notEqual(written.params[4], 'sales_intent');
  assert.equal(written.params[11], content);
  assert.equal(JSON.parse(written.params[15]).salesIntentStatus, 'needs_review');
});
