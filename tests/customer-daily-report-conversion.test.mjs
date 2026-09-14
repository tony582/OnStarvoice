import assert from 'node:assert/strict';
import test from 'node:test';
import {convertCustomerDailyV3ToCollectionSnapshot} from '../server/services/customer-daily-report-conversion.js';
import {mergeCustomerDailySummary} from '../server/services/customer-daily-reports.js';

const counts = (monitor, sdb, extra = {}) => ({monitor, sdb, positive: 0, neutral: 0, negative: 0, cold: 0, comment: 0,
  negativeProcess: 0, negativeOther: 0, unclassified: 0, nonMonitor: monitor - sdb, inProgress: null, processed: null, ...extra});

function sourceSnapshot() {
  const day = counts(280, 198, {positive: 65, neutral: 122, negative: 11, cold: 1, comment: 1, negativeProcess: 9});
  const older = counts(964, 735, {positive: 292, neutral: 393, negative: 50, cold: 19, comment: 1, negativeProcess: 26, negativeOther: 4});
  const processing = counts(257, 197, {positive: 65, neutral: 119, negative: 13, comment: 2, negativeProcess: 9, negativeOther: 2});
  return {
    schemaVersion: 3, id: 'frozen-v3-report', version: 7, tenantId: 'customer-a', reportDate: '2026-09-14', mode: 'realtime',
    assessedAt: '2026-09-14T08:00:00.000Z', cutoffAt: '2026-09-14T08:00:00.000Z', collectionStartAt: '2026-09-11T10:00:00.000Z',
    summary: {format: 'daily_handling_v3', mtdBasis: 'daily_sum', dayDate: '2026-09-14',
      rows: [{date: '2026-09-14', isWorkingDay: true, counts: {...processing}}], day: {...processing}, mtd: {...processing}, coverageComplete: false},
    collectionSummary: {format: 'daily_disposition_v2', dayDate: '2026-09-14', customFrozenMetadata: {source: 'original'},
      rows: [{date: '2026-09-11', isWorkingDay: true, counts: older}, {date: '2026-09-12', isWorkingDay: false, counts: counts(0, 0)},
        {date: '2026-09-14', isWorkingDay: true, counts: {...day}}], day,
      mtd: counts(1243, 933, {positive: 357, neutral: 515, negative: 61, cold: 20, comment: 2, negativeProcess: 35, negativeOther: 4})},
    warnings: [{code: 'handling_history_incomplete', blocking: true, message: 'old processing history'},
      {code: 'cold_history_incomplete', blocking: false, message: 'retain cold history'},
      {code: 'capture_not_settled', blocking: true, message: 'retain collection warning'},
      {code: 'handling_unclassified', blocking: true}, {code: 'sentiment_status_conflict', blocking: true}],
    evidence: {handling: {coverageComplete: false, dailyRecordIds: {'2026-09-14': ['old-post']}},
      monthRecords: [{recordId: 'collected-post'}], dayRecordIds: ['collected-post'], cold: {transitions: [{recordId: 'historical-cold'}]}, heat: {selected: ['hot-post']}},
    highHeat: [{recordId: 'hot-post', status: 'negative_feishu', feishuTableNo: '表001', heat: 300}],
    coldMarked: [{recordId: 'historical-cold', isHistorical: true}], notes: [{text: '客户保留备注', author: 'customer'}],
  };
}

test('v3 conversion uses the complete frozen collection table and exact deduplicated MTD without assigning a new version', () => {
  const source = sourceSnapshot();
  const before = structuredClone(source);
  const converted = convertCustomerDailyV3ToCollectionSnapshot(source, {sourceReportId: source.id});
  assert.equal(converted.schemaVersion, 4);
  assert.deepEqual(converted.summary, {...source.collectionSummary, format: 'daily_collection_v4', mtdBasis: 'distinct_records'});
  assert.equal(converted.summary.mtd.monitor, 1243);
  assert.equal(converted.summary.rows.reduce((sum, row) => sum + row.counts.monitor, 0), 1244, 'frozen dedup MTD must not be replaced with a date-row SUM');
  for (const field of ['id', 'version', 'collectionSummary', 'systemSummary', 'summaryEdited', 'summaryEditedAt', 'summaryEdit']) assert.equal(Object.hasOwn(converted, field), false, field);
  assert.equal(converted.legacyHandling.sourceReportId, source.id);
  assert.equal(converted.legacyHandling.id, source.id);
  assert.equal(converted.legacyHandling.version, source.version);
  assert.deepEqual(converted.legacyHandling.summary, source.summary);
  assert.deepEqual(source, before);
  converted.summary.rows[0].counts.monitor = 1;
  converted.legacyHandling.summary.day.monitor = 2;
  assert.deepEqual(source, before, 'neither output table nor backup shares references with the original');
});

test('conversion preserves customer processing edits as backup and does not apply them to collection or its future editing baseline', () => {
  const source = sourceSnapshot();
  source.systemSummary = structuredClone(source.summary);
  source.summary.day.monitor = 999;
  source.summary.rows[0].counts.monitor = 999;
  source.summaryEdited = true;
  source.summaryEditedAt = '2026-09-14T09:00:00Z';
  source.summaryEdit = {sourceReportId: 'original-system-report', actorId: 'customer-editor', editedAt: source.summaryEditedAt};
  const before = structuredClone(source);
  const converted = convertCustomerDailyV3ToCollectionSnapshot(source);
  assert.equal(converted.summary.day.monitor, 280);
  for (const field of ['summary', 'systemSummary', 'summaryEdited', 'summaryEditedAt', 'summaryEdit']) assert.deepEqual(converted.legacyHandling[field], source[field], field);
  assert.equal(converted.legacyHandling.systemSummary.day.monitor, 257);
  assert.equal(converted.legacyHandling.summary.day.monitor, 999);
  const noOp = mergeCustomerDailySummary(converted.summary, {rows: {'2026-09-14': {monitor: 280}}});
  assert.equal(noOp.mtd.monitor, 1243);
  const edited = mergeCustomerDailySummary(converted.summary, {rows: {'2026-09-14': {monitor: 281}}});
  assert.equal(edited.mtd.monitor, 1244);
  assert.deepEqual(source, before);
});

test('only handling warnings and evidence move to backup; collection, heat, cold, notes and frozen assessment remain intact', () => {
  const source = sourceSnapshot();
  const converted = convertCustomerDailyV3ToCollectionSnapshot(source);
  assert.deepEqual(converted.warnings, source.warnings.filter(warning => !warning.code.startsWith('handling_')));
  assert.deepEqual(converted.legacyHandling.warnings, source.warnings.filter(warning => warning.code.startsWith('handling_')));
  assert.deepEqual(converted.legacyHandling.evidence.handling, source.evidence.handling);
  assert.equal(Object.hasOwn(converted.evidence, 'handling'), false);
  for (const [key, value] of Object.entries(source.evidence).filter(([key]) => key !== 'handling')) assert.deepEqual(converted.evidence[key], value, key);
  for (const field of ['tenantId', 'reportDate', 'mode', 'assessedAt', 'cutoffAt', 'collectionStartAt', 'highHeat', 'coldMarked', 'notes']) assert.deepEqual(converted[field], source[field], field);
  converted.notes[0].text = 'only new snapshot';
  assert.equal(source.notes[0].text, '客户保留备注');
});

test('conversion accepts an explicitly identified snapshot without embedded id and does not invent absent warnings or evidence', () => {
  const source = sourceSnapshot();
  delete source.id;
  delete source.warnings;
  delete source.evidence;
  const converted = convertCustomerDailyV3ToCollectionSnapshot(source, {sourceReportId: 'database-row-id'});
  assert.equal(converted.legacyHandling.sourceReportId, 'database-row-id');
  assert.equal(Object.hasOwn(converted, 'warnings'), false);
  assert.equal(Object.hasOwn(converted, 'evidence'), false);
});

test('conversion rejects incomplete or unrelated snapshots instead of recollecting, guessing, or overwriting a prior backup', () => {
  const source = sourceSnapshot();
  const variants = [null, {}, {...source, schemaVersion: 4}, {...source, summary: {...source.summary, format: 'daily_disposition_v2'}},
    {...source, collectionSummary: undefined}, {...source, collectionSummary: {...source.collectionSummary, rows: []}},
    {...source, collectionSummary: {...source.collectionSummary, dayDate: '2026-09-13'}},
    {...source, collectionSummary: {...source.collectionSummary, mtd: {...source.collectionSummary.mtd, monitor: null}}},
    {...source, collectionSummary: {...source.collectionSummary, rows: [source.collectionSummary.rows[0], source.collectionSummary.rows[0]]}},
    {...source, warnings: {}}, {...source, evidence: []}, {...source, legacyHandling: {preserve: 'previous backup'}}];
  for (const invalid of variants) assert.throws(() => convertCustomerDailyV3ToCollectionSnapshot(invalid, {sourceReportId: source.id}), {status: 409, code: 'daily_collection_conversion_invalid'});
  assert.throws(() => convertCustomerDailyV3ToCollectionSnapshot(source, {sourceReportId: 'different-report'}), {code: 'daily_collection_conversion_invalid'});
  assert.throws(() => convertCustomerDailyV3ToCollectionSnapshot({...source, id: undefined}), {code: 'daily_collection_conversion_invalid'});
  const converted = convertCustomerDailyV3ToCollectionSnapshot(source);
  assert.throws(() => convertCustomerDailyV3ToCollectionSnapshot(converted, {sourceReportId: 'new-report'}), {code: 'daily_collection_conversion_invalid'});
});
