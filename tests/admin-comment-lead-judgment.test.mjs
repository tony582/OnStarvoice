import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const ts = createRequire(new URL('../web/admin/package.json', import.meta.url))('typescript');
const compiled = ts.transpileModule(readFileSync(new URL('../web/admin/src/lib/comment-leads.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { commentLeadJudgment, commentLeadIsArchived, commentLeadTicketStatusLabel } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const lead = { id: 'lead', record_id: 'record', lead_type: 'sales_intent', status: 'new', priority: 'normal', comment_content: '这样的服务还想让我买？', reason: '旧判断' };

test('legacy sales leads without supporting adjudication are clearly marked for review', () => {
  for (const ai_result of [null, '{invalid', {}, { salesIntent: true }]) {
    const result = commentLeadJudgment({ ...lead, ai_result });
    assert.equal(result.needsReview, true);
    assert.equal(result.label, '购买意向待核实');
  }
});

test('sarcasm does not display a confirmed purchase label even when legacy AI says confirmed', () => {
  const result = commentLeadJudgment({ ...lead, ai_result: { salesIntent: true, salesIntentStatus: 'confirmed', expressionType: 'sarcasm', salesIntentReason: '以反问表达不满' } });
  assert.equal(result.needsReview, true);
  assert.equal(result.expression, '暗讽');
  assert.equal(result.salesReason, '以反问表达不满');
});

test('uncertain comments retain a visible review label in opinion triage', () => {
  const result = commentLeadJudgment({ ...lead, lead_type: 'other', ai_result: { salesIntent: false, salesIntentStatus: 'needs_review', expressionType: 'uncertain' } });
  assert.equal(result.needsReview, true);
  assert.equal(result.label, '购买意向待核实');
});

test('manual corrections take precedence over stale AI and show the human reason', () => {
  const result = commentLeadJudgment({ ...lead, lead_type: 'brand_risk', manual_lead_type: 'brand_risk', manual_reason: '根据上下文确认是暗讽', ai_result: { salesIntent: true, salesIntentStatus: 'confirmed', salesIntentEvidence: ['想买'] } });
  assert.equal(result.manual, true);
  assert.equal(result.needsReview, false);
  assert.equal(result.label, '人工修正');
  assert.equal(result.reason, '根据上下文确认是暗讽');
  assert.deepEqual(result.evidence, []);
});

test('confirmed direct demand exposes actual saved evidence and actor', () => {
  const result = commentLeadJudgment({ ...lead, ai_result: JSON.stringify({ salesIntent: true, salesIntentStatus: 'confirmed', salesClassifierVersion: 'comment-sales-v2', expressionType: 'literal', salesActor: 'buyer', salesIntentTarget: '安吉星套餐', salesIntentEvidence: ['怎么买套餐', null, 7] }) });
  assert.equal(result.needsReview, false);
  assert.equal(result.label, '购买意向已确认');
  assert.equal(result.actor, '本人需求');
  assert.deepEqual(result.evidence, ['怎么买套餐']);
});

test('ticketed and following comments remain active, only completed and ignored are archived', () => {
  for (const status of ['new', 'following', 'ticketed']) assert.equal(commentLeadIsArchived({ status }), false);
  for (const status of ['resolved', 'ignored']) assert.equal(commentLeadIsArchived({ status }), true);
});


test('ordinary risk comments preserve their substantive complaint reason', () => {
  const result = commentLeadJudgment({ ...lead, lead_type: 'renewal_billing', reason: '用户质疑套餐收费，表达被重复扣费的不满', ai_result: { salesIntent: false, salesIntentStatus: 'none', salesIntentReason: '未识别评论者本人明确的购买咨询需求' } });
  assert.equal(result.reason, '用户质疑套餐收费，表达被重复扣费的不满');
  assert.equal(result.salesReason, '未识别评论者本人明确的购买咨询需求');
});

test('linked ticket labels preserve completed, dismissed and closed outcomes', () => {
  assert.equal(commentLeadTicketStatusLabel('doing'), '处理中');
  assert.equal(commentLeadTicketStatusLabel('done'), '已处理');
  assert.equal(commentLeadTicketStatusLabel('dismissed'), '已忽略');
  assert.equal(commentLeadTicketStatusLabel('closed'), '已结案');
  assert.equal(commentLeadTicketStatusLabel(undefined), '状态待确认');
});
