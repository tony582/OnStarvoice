import assert from 'node:assert/strict';
import test from 'node:test';
import { appendRecordRelevanceFilters, recordRelevanceJudgment, recordRelevanceExportFields, recordRelevanceSql } from '../server/services/record-relevance-filter.js';
import { recordJudgmentExportFields } from '../server/services/record-triage-admission.js';

test('relevance uses only valid manual/AI decisions and never admission uncertain defaults', () => {
  for (const relevance of [undefined, '', 'bogus', ['relevant'], {}, true]) {
    const judgment = recordRelevanceJudgment({ ai_result: { relevance, relevanceConfidence: 0.99 }, manual_overrides: { relevance: { value: 'bogus' } } });
    assert.equal(judgment.relevance, 'unjudged');
    assert.equal(judgment.source, 'unjudged');
    assert.equal(judgment.confidence, null);
    assert.equal(judgment.confidenceBand, 'missing');
  }
  for (const relevance of ['relevant','uncertain','irrelevant']) {
    assert.equal(recordRelevanceJudgment({ ai_result: { relevance } }).relevance, relevance);
    for (const override of [relevance, { value: relevance, reason: '人工核对原帖' }]) {
      const value = recordRelevanceJudgment({ ai_result: { relevance: 'irrelevant', relevanceConfidence: 0.99, relevanceReason: '过时AI依据' }, manual_overrides: { relevance: override } });
      assert.equal(value.relevance, relevance);
      assert.equal(value.source, 'manual');
      assert.equal(value.confidence, null);
      assert.equal(value.percent, null);
      assert.equal(value.confidenceBand, 'manual');
      assert.equal(value.reason, typeof override === 'string' ? '人工判断，未填写依据' : '人工核对原帖');
    }
  }
});

test('confidence normalizes Number-compatible strings and rounds displayed percentage before banding', () => {
  const samples = [[0,'low',0], [1,'high',100], [0.5949999999999999,'low',59], [.595,'medium',60], [.7949999999999998,'medium',79], [.7949999999999999,'high',80], [.795,'high',80], ['7.95e-1','high',80], ['\ufeff .92\u00a0','high',92], ['0x1','high',100], ['0b0','low',0], ['1e-999999','low',0], ['-1e-999999','low',-0], ['1.00000000000000001','high',100]];
  for (const [score, band, percent] of samples) {
    const judgment = recordRelevanceJudgment({ ai_result: { relevance: 'irrelevant', relevanceConfidence: score } });
    assert.equal(judgment.confidenceBand, band, String(score));
    assert.equal(judgment.percent, percent, String(score));
  }
  for (const score of [null, undefined, '', ' ', true, false, [], {}, 'NaN','Infinity', '1e999999', '-.01', 1.01, '0x2']) {
    const judgment = recordRelevanceJudgment({ ai_result: { relevance: 'relevant', relevanceConfidence: score } });
    assert.equal(judgment.confidence, null, JSON.stringify(score));
    assert.equal(judgment.confidenceBand, 'missing');
  }
});

test('list/export filter dimensions use OR selections and AND dimensions with bound parameters', () => {
  const params = ['tenant'];
  const where = appendRecordRelevanceFilters('WHERE tenant_id=$1', params, { relevance: ['relevant,uncertain','relevant'], relevanceConfidence: ['high','manual'] });
  assert.deepEqual(params, ['tenant',['relevant','uncertain'],['high','manual']]);
  assert.match(where, /= ANY\(\$2::text\[\]\)/);
  assert.match(where, /= ANY\(\$3::text\[\]\)/);
  assert.equal(appendRecordRelevanceFilters('WHERE true', [], {}), 'WHERE true');
  assert.match(recordRelevanceSql(), /'unjudged'/);
  assert.throws(() => recordRelevanceSql('r;DROP'), /Invalid record SQL alias/);
  for (const value of ['', 'none', 'high,', "relevant') OR true--", {}, [], [null]]) {
    const untouched = ['tenant'];
    assert.throws(() => appendRecordRelevanceFilters('', untouched, { relevance: value }), { status: 400, code: 'invalid_relevance' });
    assert.deepEqual(untouched, ['tenant']);
  }
  assert.throws(() => appendRecordRelevanceFilters('', [], { relevance: 'relevant', relevanceConfidence: 'bad' }), { status: 400, code: 'invalid_relevance_confidence' });
});

test('export labels distinguish relevance from confidence and retain the actual judgment source', () => {
  assert.deepEqual(recordRelevanceExportFields({ ai_result: { relevance: 'irrelevant', relevanceConfidence: .92, relevanceReason: '主帖讨论其他品牌' } }), { relevance: '无关', relevance_confidence: '92%', relevance_source: 'AI', relevance_reason: '主帖讨论其他品牌' });
  assert.equal(recordRelevanceExportFields({ ai_result: { relevance: 'uncertain' } }).relevance, '信息不足');
  assert.equal(recordRelevanceExportFields({}).relevance, '未判断');
  const human = recordJudgmentExportFields({ intent: 'inquiry', manual_overrides: { relevance: { value: 'relevant' } }, ai_result: { relevance: 'irrelevant', relevanceConfidence: .99, relevanceReason: '旧AI' } });
  assert.deepEqual(human, { intent: '咨询', relevance: '相关', relevance_confidence: '', relevance_source: '人工', relevance_reason: '人工判断，未填写依据' });
});
