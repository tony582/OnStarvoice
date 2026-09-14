import {DAILY_HANDLING_SUMMARY_FORMAT} from './customer-daily-handling-summary.js';
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
