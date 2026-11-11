import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getSentryScopeRetiredAt, parseSentryScopeRetiredAt, recordCreatedAfterSentryRetirement} from '../server/config/sentry-admission.js';
import {legacySentryAdmissionScope, legacySentryAdmissionScopeSql, recordTriageAdmission,
  recordTriageAdmissionSql, recordAdmissionSelectSql, recordSentryScopeSql, withRecordAdmissionFields} from '../server/services/record-triage-admission.js';
import {isSentryEvidenceScope, SENTRY_SCOPE_KEYWORDS} from '../server/services/record-content-judgment.js';

const CUTOFF = '2026-11-11T11:12:13.456Z';
const options = {retiredAt: CUTOFF};
const post = {keyword: '别克哨兵', title: '录像怎么导出', ai_result: {relevance: 'uncertain'},
  business_visibility: 'eligible', record_type: 'keyword_notes'};
const admittedToWork = row => {const admission = recordTriageAdmission(row, options); return admission.admitted && admission.relevance !== 'irrelevant';};

test('retirement configuration accepts one explicit UTC instant and fails closed for malformed values', t => {
  assert.equal(parseSentryScopeRetiredAt(CUTOFF), CUTOFF);
  assert.equal(parseSentryScopeRetiredAt('2026-11-11T11:12:13Z'), '2026-11-11T11:12:13.000Z');
  for (const value of ['', null, undefined, 0, {}, 'now', '2026-11-11', '2026-02-30T00:00:00.000Z',
    '2026-11-11T11:12:13+08:00', "2026-11-11'; SELECT 1", '2026-11-11T24:00:00.000Z', '0000-01-01T00:00:00.000Z']) {
    assert.equal(parseSentryScopeRetiredAt(value), '', JSON.stringify(value));
  }
  const directory = mkdtempSync(join(tmpdir(), 'sentry-config-')), file = join(directory, 'cutoff.json');
  const before = process.env.SENTRY_ADMISSION_CONFIG_PATH;
  t.after(() => {if (before === undefined) delete process.env.SENTRY_ADMISSION_CONFIG_PATH; else process.env.SENTRY_ADMISSION_CONFIG_PATH = before; rmSync(directory, {recursive: true, force: true});});
  process.env.SENTRY_ADMISSION_CONFIG_PATH = file;
  assert.equal(getSentryScopeRetiredAt(), '');
  writeFileSync(file, '{invalid json'); assert.equal(getSentryScopeRetiredAt(), '');
  writeFileSync(file, JSON.stringify({SENTRY_SCOPE_RETIRED_AT: ''})); assert.equal(getSentryScopeRetiredAt(), '');
  writeFileSync(file, JSON.stringify({SENTRY_SCOPE_RETIRED_AT: CUTOFF})); assert.equal(getSentryScopeRetiredAt(), CUTOFF);
  assert.equal(recordTriageAdmission({...post, created_at: CUTOFF}).scoped, false);
  assert.match(recordTriageAdmissionSql('r'), /created_at >= '2026-11-11T11:12:13\.456Z'/);
  writeFileSync(file, JSON.stringify({SENTRY_SCOPE_RETIRED_AT: ''}));
  assert.equal(recordTriageAdmission({...post, created_at: CUTOFF}).scoped, true, 'already loaded code reads a changed config rather than process-start time');
  process.env.SENTRY_ADMISSION_CONFIG_PATH = 'relative.json'; assert.equal(getSentryScopeRetiredAt(), '');
});

test('only first stored created_at activates retirement, including the exact instant', () => {
  const old = {...post, created_at: '2026-11-11T11:12:13.455Z', first_seen_at: '2026-11-12T00:00:00Z',
    last_seen_at: '2026-11-12T00:00:00Z', updated_at: '2026-11-12T00:00:00Z', published_ts: '2026-11-12T00:00:00Z'};
  assert.equal(legacySentryAdmissionScope(old, options), true);
  for (const created_at of [CUTOFF, new Date(CUTOFF), '2026-11-11T19:12:13.456+08:00', '2026-11-11T11:12:13.457Z']) {
    assert.equal(recordCreatedAfterSentryRetirement({...old, created_at}, CUTOFF), true);
    assert.equal(recordTriageAdmission({...old, created_at}, options).scoped, false);
  }
  for (const created_at of [undefined, null, '', 'invalid', '2026-11-11', '2026-11-11T11:12:13.456', 9999999999999,
    new Date(NaN), '2026-02-30T11:12:13.456Z']) {
    assert.equal(legacySentryAdmissionScope({...post, created_at}, options), true, String(created_at));
  }
  assert.equal(legacySentryAdmissionScope({...post, created_at: CUTOFF}, {retiredAt: ''}), true);
});

test('all five newly captured sentry keywords share ordinary relevant, uncertain and irrelevant behavior', () => {
  for (const keyword of SENTRY_SCOPE_KEYWORDS) for (const relevance of ['relevant', 'uncertain', 'irrelevant']) {
    const row = {...post, keyword, created_at: CUTOFF, ai_result: {relevance}};
    assert.deepEqual(recordTriageAdmission(row, options), recordTriageAdmission({...row, keyword: '安吉星'}, options));
    assert.equal(admittedToWork(row), relevance !== 'irrelevant');
    assert.equal(withRecordAdmissionFields(row, options).monitoring_evidence_status, 'not_applicable');
  }
  const observed = {...post, keyword: '安吉星', observed_keywords: ['凯迪拉克哨兵'], created_at: CUTOFF};
  assert.equal(isSentryEvidenceScope(observed), true, 'the shared evidence/patrol scope itself is not retired');
  assert.equal(legacySentryAdmissionScope(observed, options), false);
  assert.equal(recordTriageAdmission(observed, options).monitoring_evidence_status, 'not_applicable');
  assert.doesNotMatch(recordSentryScopeSql('r'), /created_at/);
});

test('historical evidence and explicit human choices retain their previous precedence', () => {
  const old = {...post, created_at: '2026-11-11T11:12:13.455Z'};
  for (const relevance of ['relevant', 'uncertain']) assert.equal(admittedToWork({...old, ai_result: {relevance}}), false);
  assert.equal(admittedToWork({...old, title: '我的别克驻车体验', ai_result: {relevance: 'relevant'}}), true);
  for (const created_at of [old.created_at, CUTOFF]) {
    const row = {...old, created_at, manual_overrides: {triage_admission: {value: 'included', reason: '用户指定纳入'}}};
    const before = structuredClone(row);
    assert.equal(admittedToWork(row), true); assert.deepEqual(row, before);
    assert.equal(admittedToWork({...row, manual_overrides: {relevance: 'relevant'}}), true);
    assert.equal(admittedToWork({...row, manual_overrides: {relevance: 'irrelevant'}}), false);
    assert.equal(admittedToWork({...row, ai_result: {relevance: 'irrelevant'}}), false, 'the existing outer irrelevant filter remains authoritative');
  }
});

test('SQL admission and its scoped projection use the same created_at cutoff without changing broad sentry evidence scope', () => {
  const scoped = legacySentryAdmissionScopeSql('r', options);
  assert.match(scoped, /NOT COALESCE\(r\.created_at >= '2026-11-11T11:12:13\.456Z'::timestamptz,false\)/);
  assert.ok(recordTriageAdmissionSql('r', options).includes(scoped));
  assert.ok(recordAdmissionSelectSql('r', options).startsWith(`${scoped} AS admission_scoped`));
  assert.ok(recordAdmissionSelectSql('r', {...options, admitted: true}).endsWith('true AS admission_allowed'));
  assert.equal(legacySentryAdmissionScopeSql('r', {retiredAt: ''}), recordSentryScopeSql('r'));
  assert.throws(() => legacySentryAdmissionScopeSql('r; DROP', options), /Invalid record SQL alias/);
});
