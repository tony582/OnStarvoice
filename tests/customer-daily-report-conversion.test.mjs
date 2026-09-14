import assert from 'node:assert/strict';
import test from 'node:test';
import {convertCustomerDailyV3ToCollectionSnapshot, convertCustomerDailyV4ToMixedSnapshot} from '../server/services/customer-daily-report-conversion.js';
import {buildCustomerDailyNegativeHandlingSummary} from '../server/services/customer-daily-handling-summary.js';
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

function collectionSource() {
  return {...convertCustomerDailyV3ToCollectionSnapshot(sourceSnapshot()), id: 'frozen-v4-report', version: 8};
}
function actionsFor(source) {
  return buildCustomerDailyNegativeHandlingSummary([{id: 'old-post-1', sentiment: 'negative'}, {id: 'old-post-2', sentiment: 'neutral'}], [
    {recordId: 'old-post-1', eventId: 'event-1', handledAt: '2026-09-12T01:00:00Z', previousStatus: 'unhandled', nextStatus: 'negative_cold'},
    {recordId: 'old-post-1', eventId: 'event-2', handledAt: '2026-09-14T04:00:00Z', previousStatus: 'negative_cold', nextStatus: 'negative_comment'},
    {recordId: 'old-post-2', eventId: 'event-3', handledAt: '2026-09-14T05:00:00Z', previousStatus: 'negative_feishu', nextStatus: 'negative_comment'},
  ], source, {coverageFrom: '2026-09-08T09:23:56.772Z'});
}

test('v4 to v5 preserves the exact frozen collection baseline and customer content while replacing only the four action columns', () => {
  const source = collectionSource(), before = structuredClone(source);
  const handling = actionsFor(source);
  const converted = convertCustomerDailyV4ToMixedSnapshot(source, {handlingSummary: handling.summary, handlingEvidence: handling.evidence});
  assert.equal(converted.schemaVersion, 5);
  assert.equal(converted.summary.format, 'daily_collection_handling_v5');
  for (const field of ['monitor', 'sdb', 'positive', 'neutral', 'negative', 'nonMonitor', 'unclassified']) {
    assert.equal(converted.summary.day[field], source.summary.day[field]);
    assert.equal(converted.summary.mtd[field], source.summary.mtd[field]);
    for (const row of source.summary.rows) assert.equal(converted.summary.rows.find(item => item.date === row.date).counts[field], row.counts[field]);
  }
  assert.equal(converted.summary.day.comment, 2);
  assert.equal(converted.summary.mtd.comment, 2);
  const weekend = converted.summary.rows.find(row => row.date === '2026-09-12');
  assert.equal(weekend.counts.monitor, 0);
  assert.equal(weekend.counts.cold, 1);
  assert.equal(weekend.isWorkingDay, false);
  assert.equal(converted.summary.mtd.cold, 0, 'last comment state replaces a prior cold state for monthly dedup only');
  assert.equal(converted.summary.mtd.monitor, 1243);
  for (const field of ['notes', 'highHeat', 'coldMarked', 'assessedAt', 'cutoffAt', 'legacyHandling']) assert.deepEqual(converted[field], source[field], field);
  assert.equal(Object.hasOwn(converted, 'id'), false);
  assert.equal(Object.hasOwn(converted, 'version'), false);
  assert.equal(converted.legacyCollection.sourceReportId, source.id);
  assert.deepEqual(converted.legacyCollection.summary, source.summary);
  assert.deepEqual(converted.evidence.handling, handling.evidence);
  assert.ok(converted.warnings.some(warning => warning.code === 'handling_history_incomplete' && warning.blocking === false));
  for (const warning of source.warnings) assert.ok(converted.warnings.some(item => item.code === warning.code));
  converted.summary.rows[0].counts.comment = 999;
  converted.evidence.handling.transitions[0].nextStatus = 'reviewed';
  assert.deepEqual(source, before);
  assert.equal(handling.evidence.transitions[0].nextStatus, 'negative_cold');
});

test('v4 to v5 retains top-level edit protection and converts the original system baseline without losing customer collection changes', () => {
  const source = collectionSource();
  source.systemSummary = structuredClone(source.summary);
  source.summary.day.monitor = 281;
  source.summary.rows.at(-1).counts.monitor = 281;
  source.summary.mtd.monitor = 1244;
  source.summaryEdited = true;
  source.summaryEditedAt = '2026-09-14T09:00:00Z';
  source.summaryEdit = {sourceReportId: 'earlier-v4', actorId: 'customer', editedAt: source.summaryEditedAt};
  const before = structuredClone(source), handling = actionsFor(source);
  const converted = convertCustomerDailyV4ToMixedSnapshot(source, {handlingSummary: handling.summary, handlingEvidence: handling.evidence});
  assert.equal(converted.summary.day.monitor, 281);
  assert.equal(converted.summary.mtd.monitor, 1244);
  assert.equal(converted.systemSummary.day.monitor, 280);
  assert.equal(converted.systemSummary.mtd.monitor, 1243);
  assert.equal(converted.systemSummary.day.comment, 2);
  assert.equal(converted.systemSummary.format, 'daily_collection_handling_v5');
  for (const field of ['summaryEdited', 'summaryEditedAt', 'summaryEdit']) assert.deepEqual(converted[field], source[field]);
  assert.deepEqual(converted.legacyCollection.systemSummary, source.systemSummary);
  const edited = mergeCustomerDailySummary(converted.summary, {rows: {'2026-09-14': {monitor: 282, comment: 0}}});
  assert.equal(edited.mtd.monitor, 1245);
  assert.equal(edited.mtd.comment, 2);
  assert.deepEqual(source, before);
});

test('v4 conversion rejects mismatched audit cutoffs, incomplete months, wrong sources and repeated conversion', () => {
  const source = collectionSource(), handling = actionsFor(source);
  const options = {sourceReportId: source.id, handlingSummary: handling.summary, handlingEvidence: handling.evidence};
  for (const patch of [
    {sourceReportId: 'wrong'},
    {handlingEvidence: {...handling.evidence, cutoffAt: '2026-09-14T09:00:00Z'}},
    {handlingEvidence: {...handling.evidence, monthStart: '2026-08-01T00:00:00Z'}},
    {handlingSummary: {...handling.summary, dailyBasis: 'daily_unique_posts'}},
    {handlingSummary: {...handling.summary, rows: handling.summary.rows.slice(1)}},
    {handlingSummary: {...handling.summary, mtd: {...handling.summary.mtd, comment: -1}}},
  ]) assert.throws(() => convertCustomerDailyV4ToMixedSnapshot(source, {...options, ...patch}), {code: 'daily_collection_conversion_invalid'});
  const converted = convertCustomerDailyV4ToMixedSnapshot(source, options);
  assert.throws(() => convertCustomerDailyV4ToMixedSnapshot(converted, options), {code: 'daily_collection_conversion_invalid'});
});
