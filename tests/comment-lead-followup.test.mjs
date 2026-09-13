import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommentLeadSuggestion, validateCommentLeadMutation } from '../server/services/comment-lead-followup.js';

test('unverified old sales and sarcastic AI results require review before sales outreach', () => {
  for (const ai_result of [{}, { salesIntent: true }, { salesIntent: true, salesIntentStatus: 'confirmed', expressionType: 'sarcasm' }]) {
    const suggestion = buildCommentLeadSuggestion({ lead_type: 'sales_intent', ai_result });
    assert.match(suggestion.summary, /暗讽/);
    assert.equal(suggestion.replyDraft, undefined);
    assert.match(suggestion.steps.join(' '), /修正/);
  }
});

test('verified sales and manual corrections receive suggestions for their effective classification', () => {
  const sales = buildCommentLeadSuggestion({ lead_type: 'sales_intent', ai_result: { salesIntent: true, salesIntentStatus: 'confirmed' } });
  assert.match(sales.summary, /购买需求/);
  assert.match(sales.replyDraft, /哪款产品/);
  const corrected = buildCommentLeadSuggestion({ lead_type: 'sales_intent', manual_lead_type: 'renewal_billing' });
  assert.match(corrected.summary, /费用争议/);
  assert.match(corrected.steps.join(' '), /不承诺退款/);
});

test('manual correction discards old AI advice while retaining urgency and ticket guidance', () => {
  const result = buildCommentLeadSuggestion({
    lead_type: 'app_issue', manual_lead_type: 'app_issue', priority: 'urgent', status: 'ticketed',
    ai_result: { followUpSuggestion: '购买套餐', suggestedReply: '现在就承诺退款和赔偿' },
  });
  assert.match(result.steps.join(' '), /紧急/);
  assert.match(result.steps.join(' '), /关联工单/);
  assert.doesNotMatch(result.replyDraft, /退款和赔偿/);
  assert.equal(result.source, 'rules');
  const archived = buildCommentLeadSuggestion({ lead_type: 'brand_risk', status: 'ignored' });
  assert.match(archived.steps.join(' '), /重新设为待处理/);
});

test('current item-level AI advice is shown with rules, while uncertain comments keep a review-first summary', () => {
  const ai = { salesIntent: false, salesIntentStatus: 'rejected', followUpSuggestion: '核实上周联系售后后为何未收到反馈', suggestedReply: '您好，请问上周通过哪个渠道联系过售后？' };
  const matched = buildCommentLeadSuggestion({ lead_type: 'service_quality', ai_result: ai });
  assert.equal(matched.source, 'ai');
  assert.equal(matched.summary, ai.followUpSuggestion);
  assert.equal(matched.replyDraft, ai.suggestedReply);
  assert.match(matched.steps.join(' '), /上下文/);
  const uncertain = buildCommentLeadSuggestion({ lead_type: 'other', ai_result: { ...ai, salesIntentStatus: 'needs_review' } });
  assert.match(uncertain.summary, /购买意向尚待核实/);
  assert.doesNotMatch(uncertain.steps.join(' '), /上周联系售后/);
  assert.equal(uncertain.source, 'rules');
  assert.equal(uncertain.replyDraft, undefined);
});

test('mutation validation requires a reason for each human correction and rejects fabricated ticket state', () => {
  assert.throws(() => validateCommentLeadMutation({ leadType: 'complaint', correctionReason: ' ' }), { code: 'correction_reason_required' });
  assert.throws(() => validateCommentLeadMutation({ status: 'ticketed' }), { code: 'ticketed_via_ticket_only' });
  assert.deepEqual(validateCommentLeadMutation({ note: '  已核实  ' }), { status: undefined, priority: undefined, note: '已核实', leadType: undefined, correctionReason: undefined });
});
