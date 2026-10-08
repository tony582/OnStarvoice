#!/usr/bin/env node
// Align Content Triage with the customer daily reports that were already sent.
//
// Daily reports sent before 2026-10-08 counted every eligible post by first
// ingest, including posts the brand-evidence rule keeps out of Content Triage.
// Those reports are frozen, so the posts they counted must exist in Content
// Triage with a handling record on the report date they were counted on:
//   * every cohort post outside the current triage scope gets the explicit
//     admission override (manual_overrides.triage_admission = included);
//   * a post without a handling status becomes 已复核-非监控内容, with the
//     record_triage row and the audit transition dated on its daily report
//     date (never today), so neither the October daily report nor the triage
//     "处理时间" filter sees it as new work;
//   * posts staff already handled keep their status and real handling events;
//   * archived posts are left alone (archive is a lifecycle decision).
//
// Usage: node server/scripts/reconcile-customer-daily-scope.mjs --tenant 安吉星 --month 2026-09 [--apply]
import 'dotenv/config';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {getPool, closePool} from '../db/pool.js';
import {CUSTOMER_ACTIVE_TRIAGE_SQL, CUSTOMER_TRIAGE_STATUSES} from '../services/customer-daily-triage-scope.js';
import {isWorkingDate} from '../services/china-work-calendar.js';
import {collectionBoundary} from '../services/customer-daily-business-period.js';

export const RECONCILE_SOURCE = 'customer_daily_reconcile';
export const RECONCILE_NOTE = '按已发送客户日报对齐导入内容分诊：无品牌证据的哨兵关键词帖，列为已复核-非监控内容';
const ZONE_OFFSET = 8 * 3_600_000;
const DAY = 86_400_000;
const HANDLING_TIME = '09:30';

const shanghaiDate = value => new Date(new Date(value).getTime() + ZONE_OFFSET).toISOString().slice(0, 10);
const nextDate = date => new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/** The report date whose customer workday window [previous workday boundary, D boundary) holds firstSeenAt. */
export function dailyReportDateFor(firstSeenAt, boundary = '18:00') {
  const at = new Date(firstSeenAt).getTime();
  if (!Number.isFinite(at)) throw new Error(`invalid first_seen_at ${firstSeenAt}`);
  let candidate = shanghaiDate(at);
  for (let i = 0; i < 30; i++) {
    if (isWorkingDate(candidate) && at < Date.parse(`${candidate}T${boundary}:00+08:00`)) return candidate;
    candidate = nextDate(candidate);
  }
  throw new Error(`no working date within 30 days of ${firstSeenAt}`);
}

/** Handling happened on the report date, never before the capture itself. */
export function backfilledHandlingTime(firstSeenAt, reportDate) {
  const base = Date.parse(`${reportDate}T${HANDLING_TIME}:00+08:00`);
  const afterCapture = new Date(firstSeenAt).getTime() + 10 * 60_000;
  return new Date(Math.max(base, afterCapture)).toISOString();
}

async function resolveTenant(db, tenant) {
  const row = /^[0-9a-f-]{36}$/i.test(tenant)
    ? await db.query('SELECT id, name FROM tenants WHERE id=$1', [tenant])
    : await db.query('SELECT id, name FROM tenants WHERE name=$1 ORDER BY created_at LIMIT 1', [tenant]);
  if (!row.rows.length) throw new Error(`tenant not found: ${tenant}`);
  return row.rows[0];
}

const SENT_SQL = `(EXISTS (SELECT 1 FROM customer_daily_email_deliveries e WHERE e.tenant_id=r.tenant_id AND e.report_id=r.id AND e.status='sent')
  OR EXISTS (SELECT 1 FROM customer_daily_deliveries f WHERE f.tenant_id=r.tenant_id AND f.report_id=r.id AND f.status='sent'))`;

/** Build the plan without writing anything. */
export async function planCustomerDailyReconcile(db, {tenant, month}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) throw new Error('month must be YYYY-MM');
  const owner = await resolveTenant(db, tenant);
  const settings = await db.query('SELECT config FROM customer_daily_report_settings WHERE tenant_id=$1', [owner.id]);
  const boundary = collectionBoundary(settings.rows[0]?.config || {});
  const monthStart = `${month}-01`;
  const cohortReport = (await db.query(`SELECT r.id, r.report_date::text AS report_date, r.version, r.snapshot->'evidence'->'monthRecords' AS month_records
    FROM customer_daily_reports r WHERE r.tenant_id=$1 AND r.report_date >= $2::date AND r.report_date < ($2::date + interval '1 month') AND ${SENT_SQL}
    ORDER BY r.report_date DESC, r.version DESC LIMIT 1`, [owner.id, monthStart])).rows[0];
  if (!cohortReport) throw new Error(`no sent daily report for ${owner.name} in ${month}`);
  const cohort = new Map();
  for (const item of cohortReport.month_records || []) if (item?.recordId) cohort.set(String(item.recordId).toLowerCase(), item);
  const dayRows = (await db.query(`SELECT DISTINCT ON (r.report_date) r.report_date::text AS report_date, r.version, ${SENT_SQL} AS sent, r.snapshot->'evidence'->'dayRecordIds' AS day_ids
    FROM customer_daily_reports r WHERE r.tenant_id=$1 AND r.report_date >= $2::date AND r.report_date < ($2::date + interval '1 month')
    ORDER BY r.report_date, ${SENT_SQL} DESC, r.version DESC`, [owner.id, monthStart])).rows;
  const dayOf = new Map();
  for (const row of dayRows) for (const id of row.day_ids || []) dayOf.set(String(id).toLowerCase(), row.report_date);
  const ids = [...cohort.keys()];
  const rows = ids.length ? (await db.query(`SELECT r.id, r.created_at AS first_seen_at, r.published_ts, r.keyword, r.title, r.platform,
      rt.status AS triage_status, rt.archived_at, (rt.record_id IS NOT NULL) AS has_triage_row,
      (CASE WHEN jsonb_typeof(r.manual_overrides->'triage_admission') = 'object' THEN r.manual_overrides->'triage_admission'->>'value' ELSE r.manual_overrides->>'triage_admission' END) = 'included' AS already_included,
      (${CUSTOMER_ACTIVE_TRIAGE_SQL}) AS in_scope
    FROM records r LEFT JOIN record_triage rt ON rt.tenant_id=r.tenant_id AND rt.record_id=r.id
    WHERE r.tenant_id=$1 AND r.id = ANY($2::uuid[]) ORDER BY r.created_at, r.id`, [owner.id, ids])).rows : [];
  const found = new Set(rows.map(row => String(row.id).toLowerCase()));
  const plan = {tenant: owner, month, boundary, cohortReport: {id: cohortReport.id, reportDate: cohortReport.report_date, version: cohortReport.version, size: cohort.size},
    missingRecords: ids.filter(id => !found.has(id)), inScope: 0, items: []};
  for (const row of rows) {
    const id = String(row.id).toLowerCase();
    if (row.in_scope) { plan.inScope++; continue; }
    const firstSeenAt = new Date(row.first_seen_at).toISOString();
    const computedDate = dailyReportDateFor(firstSeenAt, boundary);
    const snapshotDate = dayOf.get(id) || null;
    if (snapshotDate && snapshotDate !== computedDate) throw new Error(`report date mismatch for ${id}: snapshot ${snapshotDate}, computed ${computedDate}`);
    const reportDate = snapshotDate || computedDate;
    const status = row.triage_status || 'unhandled';
    const action = row.archived_at ? 'skip_archived'
      : row.already_included ? 'skip_already_included'
        : !CUSTOMER_TRIAGE_STATUSES.includes(status) ? 'skip_unknown_status'
          : status === 'unhandled' ? 'import_non_monitor' : 'override_only';
    plan.items.push({recordId: id, action, firstSeenAt, reportDate, reportDateSource: snapshotDate ? 'daily_snapshot' : 'workday_window',
      handledAt: action === 'import_non_monitor' ? backfilledHandlingTime(firstSeenAt, reportDate) : null,
      currentStatus: status, hasTriageRow: row.has_triage_row, keyword: row.keyword || '', platform: row.platform || '', title: String(row.title || '').slice(0, 40),
      publishedMonth: row.published_ts ? shanghaiDate(row.published_ts).slice(0, 7) : null});
  }
  return plan;
}

export function summarizeReconcilePlan(plan) {
  const byAction = {};
  const byDate = {};
  for (const item of plan.items) {
    byAction[item.action] = (byAction[item.action] || 0) + 1;
    if (item.action === 'import_non_monitor' || item.action === 'override_only') {
      byDate[item.reportDate] ??= {import_non_monitor: 0, override_only: 0};
      byDate[item.reportDate][item.action]++;
    }
  }
  return {cohortSize: plan.cohortReport.size, inScope: plan.inScope, outOfScope: plan.items.length, missingRecords: plan.missingRecords.length, byAction, byDate};
}

/** Apply the plan inside one transaction; safe to re-run (already included posts are skipped at planning time). */
export async function applyCustomerDailyReconcile(db, plan, {now = new Date()} = {}) {
  const client = await db.connect();
  const appliedAt = new Date(now).toISOString();
  const result = {overrides: 0, imported: 0, auditEvents: 0};
  try {
    await client.query('BEGIN');
    for (const item of plan.items) {
      if (item.action !== 'import_non_monitor' && item.action !== 'override_only') continue;
      const override = {value: 'included', reason: RECONCILE_NOTE, source: RECONCILE_SOURCE, reportId: plan.cohortReport.id, reportDate: item.reportDate, appliedAt};
      const updated = await client.query(`UPDATE records SET manual_overrides = COALESCE(manual_overrides, '{}'::jsonb) || jsonb_build_object('triage_admission', $3::jsonb), updated_at = now()
        WHERE tenant_id=$1 AND id=$2 AND COALESCE(CASE WHEN jsonb_typeof(manual_overrides->'triage_admission') = 'object' THEN manual_overrides->'triage_admission'->>'value' ELSE manual_overrides->>'triage_admission' END, '') <> 'included'`,
      [plan.tenant.id, item.recordId, JSON.stringify(override)]);
      if (!updated.rowCount) continue;
      result.overrides++;
      if (item.action !== 'import_non_monitor') continue;
      const triage = await client.query(`INSERT INTO record_triage (tenant_id, record_id, status, created_at, updated_at) VALUES ($1, $2, 'reviewed_non_monitor', $3, $3)
        ON CONFLICT (tenant_id, record_id) DO UPDATE SET status='reviewed_non_monitor', updated_at=EXCLUDED.updated_at WHERE record_triage.status='unhandled' AND record_triage.archived_at IS NULL
        RETURNING record_id`, [plan.tenant.id, item.recordId, item.handledAt]);
      if (!triage.rowCount) continue;
      await client.query(`INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, target_type, target_id, metadata, created_at)
        VALUES ($1, 'system', '', 'record.triage_updated', 'record', $2, $3::jsonb, $4)`,
      [plan.tenant.id, item.recordId, JSON.stringify({previousStatus: 'unhandled', nextStatus: 'reviewed_non_monitor', previousPriority: 'normal', nextPriority: 'normal', note: RECONCILE_NOTE,
        reconcile: {source: RECONCILE_SOURCE, reportId: plan.cohortReport.id, reportDate: item.reportDate, reportDateSource: item.reportDateSource, appliedAt}}), item.handledAt]);
      result.imported++;
      result.auditEvents++;
    }
    await client.query(`INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, target_type, target_id, metadata)
      VALUES ($1, 'system', '', 'customer_daily_reconcile', 'customer_daily_report', $2, $3::jsonb)`,
    [plan.tenant.id, plan.cohortReport.id, JSON.stringify({month: plan.month, ...summarizeReconcilePlan(plan), ...result, appliedAt})]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const tenant = option('--tenant'), month = option('--month'), apply = args.includes('--apply');
  if (!tenant || !month) { console.error('usage: node server/scripts/reconcile-customer-daily-scope.mjs --tenant <name|id> --month YYYY-MM [--apply]'); process.exit(2); }
  const pool = getPool();
  try {
    const plan = await planCustomerDailyReconcile(pool, {tenant, month});
    const summary = summarizeReconcilePlan(plan);
    console.log(JSON.stringify({tenant: plan.tenant.name, month, boundary: plan.boundary, cohortReport: plan.cohortReport, ...summary}, null, 2));
    for (const item of plan.items) if (item.action.startsWith('skip')) console.log('skip', item.action, item.recordId, item.currentStatus, item.reportDate);
    if (!apply) { console.log('dry run only; add --apply to write'); return; }
    const result = await applyCustomerDailyReconcile(pool, plan);
    console.log(JSON.stringify({applied: result}, null, 2));
    const check = await planCustomerDailyReconcile(pool, {tenant, month});
    console.log(JSON.stringify({afterApply: summarizeReconcilePlan(check)}, null, 2));
  } finally {
    await closePool();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exit(1); });
}
