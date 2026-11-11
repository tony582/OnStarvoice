import {withTransaction} from '../../db/query.js';
import {groupCrossPosts} from './matching.js';
import {CROSS_POST_FIELDS, CROSS_POST_ELIGIBLE} from './store.js';

const DAY = 86400000;
const READ = {category: 'reporting', readOnly: true, isolationLevel: 'repeatable_read', statementTimeoutMs: 15000, lockTimeoutMs: 500};
const WRITE = {category: 'reporting', statementTimeoutMs: 15000, lockTimeoutMs: 500, idleInTransactionTimeoutMs: 5000};
const fingerprint = value => JSON.stringify(value);
const conflict = () => Object.assign(new Error('Cross-post backfill snapshot changed; no labels were written for this tenant'), {code: 'CROSS_POST_BACKFILL_RETRY'});
const labels = (tx, tenantId) => tx.queryAll(`SELECT record_id,group_id,xmin::text AS version
  FROM record_cross_posts WHERE tenant_id=$1 ORDER BY record_id`, [tenantId]);
const exclusions = (tx, tenantId) => tx.queryAll(`SELECT tenant_id,record_a,record_b,xmin::text AS version
  FROM record_cross_post_exclusions WHERE tenant_id=$1 ORDER BY record_a,record_b`, [tenantId]);
const fields = `${CROSS_POST_FIELDS}, (${CROSS_POST_ELIGIBLE}) AS eligible, r.xmin::text AS version`;

export function backfillWindow({days = 30, now = Date.now()} = {}) {
  const at = +new Date(now);
  if (days !== 30) throw new Error('Cross-post backfill requires days=30');
  if (!Number.isFinite(at)) throw new Error('Invalid cross-post backfill time');
  return {asOf: new Date(at).toISOString(), since: new Date(at - days * DAY).toISOString(),
    boundarySince: new Date(at - (days + 3) * DAY).toISOString()};
}

async function snapshot(tenantId, window) {
  return withTransaction(async tx => {
    const tenant = await tx.queryOne('SELECT id,name FROM tenants WHERE id=$1', [tenantId]);
    if (!tenant) throw Object.assign(new Error('Cross-post tenant not found'), {code: 'CROSS_POST_TENANT_NOT_FOUND'});
    const oldLabels = await labels(tx, tenantId), oldExclusions = await exclusions(tx, tenantId);
    // Include previously labelled ineligible rows so this backfill can remove stale labels too.
    const records = await tx.queryAll(`SELECT ${fields} FROM records r WHERE r.tenant_id=$1
      AND COALESCE(r.published_ts,r.created_at) BETWEEN $2::timestamptz AND $3::timestamptz
      AND (${CROSS_POST_ELIGIBLE} OR EXISTS (SELECT 1 FROM record_cross_posts cp WHERE cp.tenant_id=r.tenant_id AND cp.record_id=r.id))
      ORDER BY r.id`, [tenantId, window.boundarySince, window.asOf]);
    const seeds = records.filter(r => +new Date(r.published_ts || r.created_at) >= +new Date(window.since));
    const loaded = new Set(records.map(r => r.id));
    // A window edge may cut through an existing transitive group. Load every old member before recomputing it.
    const touchedGroups = new Set(oldLabels.filter(r => loaded.has(r.record_id)).map(r => r.group_id));
    const extraIds = oldLabels.filter(r => touchedGroups.has(r.group_id) && !loaded.has(r.record_id)).map(r => r.record_id);
    if (extraIds.length) records.push(...await tx.queryAll(`SELECT ${fields} FROM records r
      WHERE r.tenant_id=$1 AND r.id=ANY($2::uuid[]) ORDER BY r.id`, [tenantId, extraIds]));
    records.sort((a, b) => a.id.localeCompare(b.id));
    return {tenant, records, seeds, labels: oldLabels, exclusions: oldExclusions};
  }, READ);
}

function prepareWrite(data) {
  const allGroups = groupCrossPosts(data.records.filter(r => r.eligible), {exclusions: data.exclusions});
  const affected = new Set(data.seeds.map(r => r.id));
  // Follow both old and new groups to closure: never leave an untouched tail of a group that was replaced.
  let previous;
  do {
    previous = affected.size;
    const oldGroups = new Set(data.labels.filter(r => affected.has(r.record_id)).map(r => r.group_id));
    for (const row of data.labels) if (oldGroups.has(row.group_id)) affected.add(row.record_id);
    for (const group of allGroups) if (group.records.some(r => affected.has(r.id))) {
      for (const record of group.records) affected.add(record.id);
    }
  } while (affected.size !== previous);
  const groups = allGroups.filter(group => group.records.some(record => affected.has(record.id)));
  const rows = groups.flatMap(group => group.records.map(record => {
    const matches = group.matches.filter(edge => edge.recordA === record.id || edge.recordB === record.id);
    return {record_id: record.id, group_id: group.groupId, score: Math.max(...matches.map(m => m.score)), evidence: {version: 1, matches}};
  }));
  return {groups, rows, affected: [...affected].sort()};
}

/** Explicit historical write path. It never calls the scheduler's 72-hour cursor or changes source/triage data. */
export async function backfillTenantCrossPosts(tenantId, options = {}) {
  const window = backfillWindow(options);
  const data = await snapshot(tenantId, window);
  const prepared = prepareWrite(data); // CPU work runs after the read-only transaction has ended.
  const versions = data.records.map(r => ({id: r.id, version: r.version}));
  await withTransaction(async tx => {
    await tx.queryOne("SELECT pg_advisory_xact_lock(hashtextextended('cross-posts:' || $1,0))", [tenantId]);
    // Hold row locks only in the short write transaction. Ingestion cannot change an already checked row before commit.
    const currentVersions = await tx.queryAll(`SELECT id,xmin::text AS version FROM records
      WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`, [tenantId, data.records.map(r => r.id)]);
    if (fingerprint(currentVersions) !== fingerprint(versions)
      || fingerprint(await labels(tx, tenantId)) !== fingerprint(data.labels)
      || fingerprint(await exclusions(tx, tenantId)) !== fingerprint(data.exclusions)) throw conflict();
    await tx.execute('DELETE FROM record_cross_posts WHERE tenant_id=$1 AND record_id=ANY($2::uuid[])', [tenantId, prepared.affected]);
    if (prepared.rows.length) await tx.execute(`INSERT INTO record_cross_posts(tenant_id,record_id,group_id,score,evidence)
      SELECT $1,x.record_id,x.group_id,x.score,x.evidence FROM jsonb_to_recordset($2::jsonb)
      AS x(record_id uuid,group_id uuid,score double precision,evidence jsonb)`, [tenantId, JSON.stringify(prepared.rows)]);
  }, WRITE);
  return {tenantId, name: data.tenant.name, mode: 'apply', days: 30, ...window,
    sourceRecords: data.seeds.filter(r => r.eligible).length, candidateRecords: data.records.filter(r => r.eligible).length,
    affectedRecords: prepared.affected.length, groups: prepared.groups.length, members: prepared.rows.length,
    previousLabels: data.labels.filter(row => prepared.affected.includes(row.record_id)).length,
    preservedLabels: data.labels.filter(row => !prepared.affected.includes(row.record_id)).length};
}

export async function backfillCrossPosts({tenantId = null, ...options} = {}) {
  const window = backfillWindow(options);
  const tenants = await withTransaction(tx => tx.queryAll(`SELECT id FROM tenants
    WHERE status='active' AND ($1::uuid IS NULL OR id=$1) ORDER BY id`, [tenantId]), READ);
  if (tenantId && !tenants.length) throw Object.assign(new Error('Active cross-post tenant not found'), {code: 'CROSS_POST_TENANT_NOT_FOUND'});
  const completed = [];
  for (const tenant of tenants) {
    try { completed.push(await backfillTenantCrossPosts(tenant.id, {...options, now: window.asOf})); }
    catch (error) { error.completedTenants = completed; error.failedTenantId = tenant.id; throw error; }
  }
  return {mode: 'apply', days: 30, ...window, tenants: completed,
    groupCount: completed.reduce((sum, row) => sum + row.groups, 0), memberCount: completed.reduce((sum, row) => sum + row.members, 0)};
}
