import {customerDailyBusinessPeriod} from './customer-daily-business-period.js';
import {isWorkingDate} from './china-work-calendar.js';

export const MONTHLY_SUMMARY_FIELDS = Object.freeze(['monitor', 'sdb', 'positive', 'neutral', 'cold', 'comment', 'negativeProcess', 'negativeOther']);
export const MONTHLY_SUMMARY_FORMAT = 'daily_disposition_v2';
const invalid = (message, status = 400) => Object.assign(new Error(message), {status, code: 'daily_summary_invalid'});
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function isMonthlySummary(summary) { return summary?.format === MONTHLY_SUMMARY_FORMAT && Array.isArray(summary.rows); }

export function buildMonthlySummary(records, period, count) {
  const rows = [];
  for (let day = 1; day <= Number(period.reportDate.slice(-2)); day++) {
    const date = `${period.reportDate.slice(0, 8)}${String(day).padStart(2, '0')}`;
    const working = period.reportBasis === 'customer_workday_v1' ? isWorkingDate(date) : true;
    let matching = [];
    if (working) {
      const range = period.reportBasis === 'customer_workday_v1'
        ? customerDailyBusinessPeriod(date, new Date(period.assessedAt), {collectionBoundaryTime: period.collectionBoundaryTime})
        : {collectionStartAt: `${date}T00:00:00+08:00`, collectionCutoffAt: new Date(Date.parse(`${date}T00:00:00+08:00`) + 86400000).toISOString()};
      const start = Date.parse(range.collectionStartAt), end = Date.parse(range.collectionCutoffAt);
      matching = records.filter(row => Date.parse(row.first_seen_at) >= start && Date.parse(row.first_seen_at) < end);
    }
    rows.push({date, isWorkingDay: working, counts: count(matching)});
  }
  return {format: MONTHLY_SUMMARY_FORMAT, dayDate: period.reportDate, rows, day: structuredClone(rows.at(-1).counts), mtd: count(records)};
}

export function monthlySummarySignature(summary) {
  return JSON.stringify(summary.rows.map(row => [row.date, ...MONTHLY_SUMMARY_FIELDS.map(field => row.counts[field])]));
}

export function mergeMonthlySummary(current, patch) {
  if (!object(patch) || Object.keys(patch).some(key => key !== 'rows') || !object(patch.rows) || !Object.keys(patch.rows).length) {
    throw invalid('请提交需要修改的日期及汇总数量；MTD 按每日数量自动加总。');
  }
  const next = structuredClone(current);
  let changed = 0;
  for (const [date, values] of Object.entries(patch.rows)) {
    const row = next.rows.find(item => item.date === date);
    if (!row || row.isWorkingDay === false) throw invalid('只能修改本份日报中的工作日汇总。');
    if (!object(values) || Object.keys(values).some(field => !MONTHLY_SUMMARY_FIELDS.includes(field))) throw invalid('只能修改汇总数量，不能修改日期或系统分类。');
    for (const [field, value] of Object.entries(values)) {
      if (!Number.isSafeInteger(value) || value < 0) throw invalid('汇总数量须为非负整数。');
      row.counts[field] = value;
      changed++;
    }
  }
  if (!changed) throw invalid('请至少填写一个要保存的汇总数量。');
  for (const {counts} of next.rows) {
    if (MONTHLY_SUMMARY_FIELDS.some(field => !Number.isSafeInteger(counts[field]) || counts[field] < 0)) throw invalid('原汇总数量格式无法核实，请重新生成日报。', 409);
    if (counts.sdb > counts.monitor) throw invalid('SDB范畴不能大于平台监控量。');
    let available = counts.sdb;
    for (const field of MONTHLY_SUMMARY_FIELDS.slice(2)) {
      if (counts[field] > available) throw invalid('正面、中性和四类负面处理数量合计不能大于 SDB 范畴。');
      available -= counts[field];
    }
  }
  next.day = structuredClone(next.rows.find(row => row.date === next.dayDate).counts);
  for (const field of MONTHLY_SUMMARY_FIELDS) {
    const total = next.rows.reduce((sum, row) => sum + row.counts[field], 0);
    if (!Number.isSafeInteger(total)) throw invalid('月累计数量过大。');
    next.mtd[field] = total;
  }
  return next;
}
