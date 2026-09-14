import {DAILY_HANDLING_SUMMARY_FORMAT, CUSTOMER_DAILY_NEGATIVE_HANDLING_FIELDS, buildCustomerDailyMixedSummary, customerDailyHandlingMonthStart} from './customer-daily-handling-summary.js';
import {DAILY_COLLECTION_SUMMARY_FORMAT, MONTHLY_SUMMARY_FIELDS, MONTHLY_SUMMARY_FORMAT} from './customer-daily-monthly-summary.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = message => Object.assign(new Error(message), {status: 409, code: 'daily_collection_conversion_invalid'});
const handlingWarning = warning => typeof warning?.code === 'string' && warning.code.startsWith('handling_');
const handlingFields = ['summary', 'systemSummary', 'summaryEdited', 'summaryEditedAt', 'summaryEdit'];

function validCounts(counts) {
  return object(counts) && MONTHLY_SUMMARY_FIELDS.every(field => Number.isSafeInteger(counts[field]) && counts[field] >= 0);
}

// Return a new, unassigned snapshot. The caller owns transaction locking,
// version allocation and insertion; the saved source and all its data stay intact.
export function convertCustomerDailyV3ToCollectionSnapshot(snapshot, {sourceReportId = snapshot?.id} = {}) {
  if (!object(snapshot) || snapshot.schemaVersion !== 3 || snapshot.summary?.format !== DAILY_HANDLING_SUMMARY_FORMAT || !Array.isArray(snapshot.summary.rows)) {
    throw invalid('只能转换含原处理量表的第三版日报。');
  }
  if (typeof sourceReportId !== 'string' || !sourceReportId.trim() || sourceReportId !== sourceReportId.trim() || (snapshot.id !== undefined && snapshot.id !== sourceReportId)) {
    throw invalid('来源日报标识缺失或与冻结快照不一致。');
  }
  if (Object.hasOwn(snapshot, 'legacyHandling')) throw invalid('日报已有原处理量备份，不能重复转换。');
  const collection = snapshot.collectionSummary;
  if (!object(collection) || collection.format !== MONTHLY_SUMMARY_FORMAT || !Array.isArray(collection.rows) || !collection.rows.length ||
      collection.dayDate !== snapshot.reportDate || !validCounts(collection.day) || !validCounts(collection.mtd) ||
      collection.rows.some(row => !object(row) || typeof row.date !== 'string' || !validCounts(row.counts)) ||
      new Set(collection.rows.map(row => row.date)).size !== collection.rows.length || !collection.rows.some(row => row.date === collection.dayDate)) {
    throw invalid('原日报缺少完整的冻结采集汇总，不能用处理量或重新采集的数据替代。');
  }
  if (snapshot.warnings !== undefined && !Array.isArray(snapshot.warnings)) throw invalid('原日报提示格式无法核实。');
  if (snapshot.evidence !== undefined && !object(snapshot.evidence)) throw invalid('原日报证据格式无法核实。');

  const next = structuredClone(snapshot);
  const legacyHandling = {sourceReportId, schemaVersion: snapshot.schemaVersion};
  for (const field of ['id', 'version', ...handlingFields]) {
    if (Object.hasOwn(next, field)) legacyHandling[field] = next[field];
    delete next[field];
  }
  if (Array.isArray(next.warnings)) {
    legacyHandling.warnings = next.warnings.filter(handlingWarning);
    next.warnings = next.warnings.filter(warning => !handlingWarning(warning));
  }
  if (next.evidence && Object.hasOwn(next.evidence, 'handling')) {
    legacyHandling.evidence = {handling: next.evidence.handling};
    delete next.evidence.handling;
  }
  next.schemaVersion = 4;
  next.summary = {...next.collectionSummary, format: DAILY_COLLECTION_SUMMARY_FORMAT, mtdBasis: 'distinct_records'};
  delete next.collectionSummary;
  next.legacyHandling = legacyHandling;
  return next;
}

/** Append-only conversion input: collection quantities and customer content are
 * frozen; only the four audited disposition columns receive a new basis. */
export function convertCustomerDailyV4ToMixedSnapshot(snapshot, {sourceReportId = snapshot?.id, handlingSummary, handlingEvidence} = {}) {
  if (!object(snapshot) || snapshot.schemaVersion !== 4 || snapshot.summary?.format !== DAILY_COLLECTION_SUMMARY_FORMAT || !Array.isArray(snapshot.summary.rows) ||
      !snapshot.summary.rows.length || snapshot.summary.dayDate !== snapshot.reportDate || !validCounts(snapshot.summary.day) || !validCounts(snapshot.summary.mtd) ||
      snapshot.summary.rows.some(row => !object(row) || typeof row.date !== 'string' || !validCounts(row.counts))) {
    throw invalid('只能从含完整冻结采集汇总的第四版日报生成新版处理统计。');
  }
  if (typeof sourceReportId !== 'string' || !sourceReportId.trim() || sourceReportId !== sourceReportId.trim() || (snapshot.id !== undefined && snapshot.id !== sourceReportId)) throw invalid('来源日报标识缺失或与冻结快照不一致。');
  if (Object.hasOwn(snapshot, 'legacyCollection')) throw invalid('日报已有原采集口径备份，不能重复转换。');
  const validNegative = counts => object(counts) && CUSTOMER_DAILY_NEGATIVE_HANDLING_FIELDS.every(field => Number.isSafeInteger(counts[field]) && counts[field] >= 0);
  const days = Number(snapshot.reportDate.slice(-2));
  const expectedDates = new Set(Array.from({length: days}, (_, i) => `${snapshot.reportDate.slice(0, 8)}${String(i + 1).padStart(2, '0')}`));
  if (!object(handlingSummary) || handlingSummary.dailyBasis !== 'status_transition_events' || handlingSummary.mtdBasis !== 'distinct_records_last_status' ||
      handlingSummary.dayDate !== snapshot.reportDate || !validNegative(handlingSummary.day) || !validNegative(handlingSummary.mtd) || !Array.isArray(handlingSummary.rows) ||
      handlingSummary.rows.length !== days || new Set(handlingSummary.rows.map(row => row?.date)).size !== days ||
      handlingSummary.rows.some(row => !object(row) || !expectedDates.has(row.date) || !validNegative(row.counts)) ||
      !object(handlingEvidence) || handlingEvidence.source !== 'audit_logs.status_transitions' ||
      Date.parse(handlingEvidence.cutoffAt) !== Date.parse(snapshot.cutoffAt) || handlingEvidence.monthStart !== customerDailyHandlingMonthStart(snapshot)) {
    throw invalid('负面处理统计须覆盖同一报表月份，且审计截止时间须与冻结日报一致。');
  }
  if (snapshot.warnings !== undefined && !Array.isArray(snapshot.warnings)) throw invalid('原日报提示格式无法核实。');
  if (snapshot.evidence !== undefined && !object(snapshot.evidence)) throw invalid('原日报证据格式无法核实。');
  const next = structuredClone(snapshot);
  const legacyCollection = {sourceReportId, schemaVersion: snapshot.schemaVersion};
  for (const field of ['id', 'version', ...handlingFields]) {
    if (Object.hasOwn(next, field)) legacyCollection[field] = next[field];
    delete next[field];
  }
  if (Array.isArray(next.warnings)) {
    legacyCollection.warnings = next.warnings.filter(handlingWarning);
    next.warnings = next.warnings.filter(warning => !handlingWarning(warning));
  }
  if (next.evidence && Object.hasOwn(next.evidence, 'handling')) legacyCollection.evidence = {handling: next.evidence.handling};
  next.schemaVersion = 5;
  next.summary = buildCustomerDailyMixedSummary(snapshot.summary, handlingSummary);
  // Retain the customer's edit marker so the automatic-generation guard keeps
  // protecting their collection corrections. Its system baseline also needs
  // the new disposition basis for subsequent manual edits.
  if (snapshot.systemSummary) next.systemSummary = buildCustomerDailyMixedSummary(snapshot.systemSummary, handlingSummary);
  for (const field of ['summaryEdited', 'summaryEditedAt', 'summaryEdit']) if (Object.hasOwn(snapshot, field)) next[field] = structuredClone(snapshot[field]);
  next.evidence = {...next.evidence, handling: structuredClone(handlingEvidence)};
  if (!handlingSummary.coverageComplete) next.warnings = [...(next.warnings || []), {code: 'handling_history_incomplete', message: `负面处理次数仅统计可核实的真实状态变更；本月历史记录覆盖不完整，不能视为完整次数。${handlingEvidence.malformedEventIds?.length ? `有${handlingEvidence.malformedEventIds.length}条审计记录缺少有效变更信息。` : ''}`, blocking: false}];
  next.legacyCollection = legacyCollection;
  return next;
}
