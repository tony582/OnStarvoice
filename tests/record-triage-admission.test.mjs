import assert from 'node:assert/strict';
import test from 'node:test';
import { appendRecordIntentFilter, recordTriageAdmission, withRecordAdmissionFields } from '../server/services/record-triage-admission.js';

const post = { keyword: '别克哨兵', ai_result: { relevance: 'relevant' }, title: '开启了哨兵模式' };
test('sentry admission requires overall relevance and original post evidence; existing manual overrides have priority', () => {
  assert.equal(recordTriageAdmission(post).admitted, false);
  assert.equal(recordTriageAdmission({ ...post, author_name: '别克车主', tags: ['别克'], content: '#别克哨兵 很方便' }).admitted, false);
  assert.equal(recordTriageAdmission({ ...post, title: 'CT50的使用说明' }).admitted, true);
  assert.equal(recordTriageAdmission({ ...post, title: '我的 CT5 哨兵功能' }).admitted, true);
  assert.equal(recordTriageAdmission({ ...post, keyword: '至境哨兵别克壁纸', title: 'CT5求救经历' }).admitted, true);
  assert.equal(recordTriageAdmission({ ...post, keyword: '哨兵模式' }).admitted, true);
  assert.equal(recordTriageAdmission({ ...post, keyword: '壁纸', observed_keywords: ['凯迪拉克哨兵'] }).admitted, false);
  assert.equal(recordTriageAdmission({ ...post, manual_overrides: { relevance: { value: 'relevant' } } }).admitted, true);
  assert.equal(recordTriageAdmission({ ...post, manual_overrides: { relevance: 'irrelevant' } }).admitted, false);
  assert.equal(recordTriageAdmission({ ...post, manual_overrides: { relevance: 'uncertain' }, title: 'CT5体验' }).admitted, false);
});

test('current source evidence decides admission independently from old metadata, while AI relevance and current media remain required', () => {
  const ai_result = { relevance: 'relevant', monitoringEvidence: { status: 'confirmed', evidence: [{ source: 'title', quote: 'CT5车主' }] } };
  assert.equal(recordTriageAdmission({ ...post, title: 'CT5车主', ai_result }).admitted, true);
  assert.equal(recordTriageAdmission({ ...post, title: '别克车主', ai_result }).admitted, true);
  assert.equal(recordTriageAdmission({ ...post, title: 'CT50的哨兵功能演示', ai_result: { relevance: 'relevant', monitoringEvidence: { status: 'confirmed', evidence: [{ source: 'title', quote: 'CT5' }] } } }).admitted, true, 'a cropped quote does not negate the vehicle clue in the complete post');
  assert.equal(recordTriageAdmission({ ...post, title: 'CT5车主', ai_result: { ...ai_result, monitoringEvidence: { status: 'needs_review', evidence: [{ source: 'title', quote: 'CT5车主' }] } } }).admitted, true);
  for (const title of ['L7哨兵模式怎么开', 'E5驻车监控异常']) assert.equal(recordTriageAdmission({ ...post, title }).admitted, true);
  for (const relevance of ['uncertain','irrelevant']) assert.equal(recordTriageAdmission({ ...post, title: '理想L7哨兵模式', ai_result: { relevance } }).admitted, false);
  assert.equal(recordTriageAdmission({ ...post, ai_result }).admitted, false, 'an old model quote alone cannot provide missing source evidence');
  const transcript = { ...post, video_url: 'https://v.douyinvod.com/current.mp4', transcript_status: 'done', transcript: '我是CT5车主', transcript_source_url: 'https://v.douyinvod.com/old.mp4' };
  assert.equal(recordTriageAdmission(transcript).admitted, false);
  assert.equal(recordTriageAdmission({ ...transcript, transcript_source_url: transcript.video_url }).admitted, true);
});

test('intent filters support repeated/comma forms and keep unknown intent unclassified', () => {
  const params = [];
  const where = appendRecordIntentFilter('WHERE true', params, ['share,inquiry', 'suggestion']);
  assert.match(where, /ANY\(\$1::text\[\]\)/);
  assert.deepEqual(params, [['share', 'inquiry', 'other']]);
  assert.throws(() => appendRecordIntentFilter('', [], 'unknown'), { code: 'invalid_intent', status: 400 });
  assert.equal(withRecordAdmissionFields({ intent: 'suggestion' }).intent_display, 'other');
  for (const intent of ['', null, 'bogus']) assert.equal(withRecordAdmissionFields({ intent }).intent_display, null);
  const projected = withRecordAdmissionFields(post);
  assert.equal('relevance_review_required' in projected, false);
  assert.equal('relevance_review_reason' in projected, false);
});


test('read projection rebuilds complete current quotes without rewriting stored judgment metadata', () => {
  const original = { ...post, title: 'CT50的哨兵功能演示', ai_result: { relevance: 'relevant', monitoringEvidence: { status: 'needs_review', evidence: [{ source: 'title', quote: 'CT5' }] } } };
  const before = JSON.stringify(original);
  const projected = withRecordAdmissionFields(original);
  assert.equal(projected.ai_result.monitoringEvidence.version, 'main-post-entity-v3');
  assert.equal(projected.ai_result.monitoringEvidence.status, 'confirmed');
  assert.ok(projected.ai_result.monitoringEvidence.evidence.some(item => item.quote.includes('CT50')));
  assert.ok(projected.ai_result.monitoringEvidence.evidence.every(item => item.quote !== 'CT5'));
  assert.equal(JSON.stringify(original), before);
  const mediaOnly = withRecordAdmissionFields({ ...post, admission_scoped: true, admission_allowed: true, ai_result: original.ai_result });
  assert.equal(mediaOnly.ai_result.monitoringEvidence.status, 'confirmed');
  assert.deepEqual(mediaOnly.ai_result.monitoringEvidence.evidence, []);
  assert.match(mediaOnly.ai_result.monitoringEvidence.reason, /媒体/);
});

test('shared aliases accept width and separator spellings without accepting company prefixes or partial model tokens', () => {
  for (const title of ['ＣＴ５哨兵体验', 'CT 5驻车异常', 'CT‑5录像', 'SAIC‑GM驻车服务', 'CT50哨兵', '上汽通用五菱与别克车型对比']) {
    assert.equal(recordTriageAdmission({ ...post, title }).admitted, true, title);
  }
  for (const title of ['上汽通用五菱哨兵体验', 'SAIC-GM-Wuling录像', 'ＳＡＩＣ－ＧＭ－Ｗｕｌｉｎｇ录像', 'SGMW驻车', 'CT500录像', 'EL70录像', 'myct50录像']) {
    assert.equal(recordTriageAdmission({ ...post, title }).admitted, false, title);
  }
  const original = { ...post, title: 'ＣＴ５的哨兵体验' };
  const evidence = withRecordAdmissionFields(original).ai_result.monitoringEvidence.evidence;
  assert.ok(evidence.some(item => item.entity === 'ＣＴ５'));
  assert.ok(evidence.every(item => original.title.includes(item.quote) && item.quote.includes(item.entity)), 'normalization preserves literal source citations');
});

test('English model names can use vehicle context across current post sources, while comments, tags and stale media cannot supply it', () => {
  for (const fields of [
    { title: 'LaCrosse', content: '哨兵昨晚没有录像' },
    { title: 'Regal', content: '远程解锁故障' },
    { title: '刚买了Regal，哨兵根本没录到' },
    { title: 'LaCrosse怎么开启哨兵模式' },
    { title: 'Regal', video_url: 'https://video.example.test/current.mp4', transcript_status: 'done', transcript_source_url: 'https://video.example.test/current.mp4', transcript: '远程解锁没有响应' },
  ]) assert.equal(recordTriageAdmission({ ...post, ...fields }).admitted, true, JSON.stringify(fields));
  for (const fields of [
    { title: 'LaCrosse', content: '今天比赛打得很精彩' },
    { title: 'Regal', content: '这首歌曲很好听' },
    { title: 'Monza', content: '意大利城市风景很美' },
    { title: 'Regal', comments_text: '哨兵昨晚没有录像' },
    { title: 'Regal', content: '#哨兵 #驻车录像', tags: ['汽车'] },
    { title: 'Regal', video_url: 'https://video.example.test/current.mp4', transcript_status: 'done', transcript_source_url: 'https://video.example.test/old.mp4', transcript: '远程解锁没有响应' },
    { title: 'SGM', content: '哨兵昨晚没有录像' },
    { title: '开拓者', content: '哨兵行业正在发展' },
  ]) assert.equal(recordTriageAdmission({ ...post, ...fields }).admitted, false, JSON.stringify(fields));
});

test('a verifiable explicit model outside the dictionary can enter triage, but malformed or external citations cannot', () => {
  const title = '星穹Z9哨兵录像无法保存';
  const candidate = { source: 'title', quote: title, entity: '星穹Z9', entityType: 'model', manufacturer: 'saic_gm' };
  const make = (item = candidate, fields = {}) => ({ ...post, title, ...fields, ai_result: { relevance: 'relevant', monitoringEvidence: { status: 'needs_review', evidence: [item] } } });
  assert.equal(recordTriageAdmission({ ...post, title }).admitted, false, 'test model is intentionally absent from the local dictionary');
  assert.equal(recordTriageAdmission(make()).admitted, true);
  const projected = withRecordAdmissionFields(make());
  assert.equal(projected.ai_result.monitoringEvidence.status, 'confirmed');
  assert.deepEqual(projected.ai_result.monitoringEvidence.evidence, [candidate]);
  for (const item of [
    { ...candidate, entityType: undefined }, { ...candidate, manufacturer: 'sgmw' },
    { ...candidate, quote: '星穹Z9并不存在的原话' }, { ...candidate, entity: '另外一个名字' },
    { ...candidate, quote: [title] }, { ...candidate, entity: ['星穹Z9'] },
    ...['keyword', 'comments', 'tags', 'image_ocr', 'transcript', 'content'].map(source => ({ ...candidate, source })),
  ]) assert.equal(recordTriageAdmission(make(item)).admitted, false, JSON.stringify(item));
  assert.equal(recordTriageAdmission(make(candidate, { title: '#星穹Z9 哨兵体验' })).admitted, false);
  for (const entity of ['这辆车', '车型', 'SUV', '通用', '上汽']) {
    const text = `${entity}哨兵录像异常`;
    assert.equal(recordTriageAdmission(make({ ...candidate, quote: text, entity }, { title: text })).admitted, false, entity);
  }
  for (const text of ['ZX90哨兵', 'myZX9哨兵', 'ＸZX9哨兵']) {
    assert.equal(recordTriageAdmission(make({ ...candidate, quote: text, entity: 'ZX9' }, { title: text })).admitted, false, text);
  }
  const repeated = 'myZX9旧名字，ZX9哨兵录像';
  assert.equal(recordTriageAdmission(make({ ...candidate, quote: repeated, entity: 'ZX9' }, { title: repeated })).admitted, true);
  for (const relevance of ['uncertain','irrelevant']) {
    const value = make(); value.ai_result.relevance = relevance;
    assert.equal(recordTriageAdmission(value).admitted, false);
  }
});
