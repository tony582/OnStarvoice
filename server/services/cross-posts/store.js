import {withTransaction} from '../../db/query.js';
import {groupCrossPosts} from './matching.js';
import {recordAdmissionSelectSql, recordEffectiveRelevanceSql, manualRecordRelevanceSql} from '../record-triage-admission.js';
import {withRecordTriageDisplay} from '../record-triage-display.js';

export const CROSS_POST_CURSOR = 'cross_posts_cursor_v1';
export const CROSS_POST_FIELDS = `r.id, r.tenant_id, r.platform, r.record_type, r.author_name,
  r.title, left(r.content, 500) AS content, r.published_ts, r.created_at, r.updated_at`;
export const CROSS_POST_ELIGIBLE = `r.platform IN ('douyin','xiaohongshu','wechat_channels')
  AND r.record_type NOT IN ('official_content','blogger_profile','comment','comments','record_comment','comment_detail')`;
const READ = {category: 'reporting', readOnly: true, isolationLevel: 'repeatable_read', statementTimeoutMs: 15000, lockTimeoutMs: 500};
const WRITE = {category: 'reporting', statementTimeoutMs: 15000, lockTimeoutMs: 500};
const HOURS_72 = 72 * 3600000;
const fingerprint = rows => JSON.stringify(rows);
const conflict = () => Object.assign(new Error('Cross-post snapshot changed; retry next cycle'), {code: 'CROSS_POST_RETRY'});
const lock = (tx, tenantId) => tx.queryOne("SELECT pg_advisory_xact_lock(hashtextextended('cross-posts:' || $1,0))", [tenantId]);
const readCursor = async (tx, tenantId) => (await tx.queryOne('SELECT value FROM tenant_settings WHERE tenant_id=$1 AND key=$2', [tenantId, CROSS_POST_CURSOR]))?.value || '';
const readExclusions = (tx, tenantId) => tx.queryAll('SELECT tenant_id,record_a,record_b FROM record_cross_post_exclusions WHERE tenant_id=$1 ORDER BY record_a,record_b', [tenantId]);
const readVersions = (tx,tenantId,ids) => tx.queryAll('SELECT id,xmin::text AS version FROM records WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[tenantId,ids]);
const readLabels = (tx, tenantId) => tx.queryAll('SELECT record_id,group_id FROM record_cross_posts WHERE tenant_id=$1 ORDER BY record_id', [tenantId]);

async function snapshot(tenantId, {now, limit}) {
  return withTransaction(async tx => {
    const cursor = await readCursor(tx, tenantId);
    let state;
    try { state = JSON.parse(cursor); } catch { /* first scan */ }
    if (!state?.upper || state.done) state = {lower: new Date(now - HOURS_72).toISOString(), upper: new Date(now).toISOString()};
    // Keep the scan upper bound fixed across batches, including unmatched records.
    const seeds = await tx.queryAll(`SELECT ${CROSS_POST_FIELDS}, GREATEST(r.updated_at,r.created_at)::text AS touched
      FROM records r WHERE r.tenant_id=$1
      AND (${CROSS_POST_ELIGIBLE} OR EXISTS (SELECT 1 FROM record_cross_posts cp WHERE cp.tenant_id=r.tenant_id AND cp.record_id=r.id))
      AND GREATEST(r.updated_at,r.created_at) >= $2::timestamptz
      AND GREATEST(r.updated_at,r.created_at) <= $3::timestamptz
      AND ($4::timestamptz IS NULL OR (GREATEST(r.updated_at,r.created_at),r.id) > ($4::timestamptz,$5::uuid))
      ORDER BY GREATEST(r.updated_at,r.created_at),r.id LIMIT $6`,
    [tenantId,state.lower,state.upper,state.afterTs || null,state.afterId || null,limit + 1]);
    const batch = seeds.slice(0,limit), last = batch.at(-1);
    const next = {...state, afterTs: last?.touched || state.afterTs, afterId: last?.id || state.afterId, done: seeds.length <= limit};
    const labels = await readLabels(tx, tenantId), exclusions = await readExclusions(tx,tenantId);
    // Coalesce overlapping time ranges: 2000 recent seeds usually need one range, not 2000 probes per row.
    const windows=[];
    for (const at of batch.map(r=>+new Date(r.published_ts || r.created_at)).sort((a,b)=>a-b)) {
      const last=windows.at(-1), lo=at-HOURS_72, hi=at+HOURS_72;
      if (last && lo<=last[1]) last[1]=Math.max(last[1],hi); else windows.push([lo,hi]);
    }
    const candidates = windows.length ? await tx.queryAll(`SELECT ${CROSS_POST_FIELDS} FROM records r
      WHERE r.tenant_id=$1 AND ${CROSS_POST_ELIGIBLE}
      AND EXISTS (SELECT 1 FROM unnest($2::timestamptz[],$3::timestamptz[]) t(lo,hi)
        WHERE COALESCE(r.published_ts,r.created_at) BETWEEN t.lo AND t.hi)`, [tenantId,windows.map(w=>new Date(w[0]).toISOString()),windows.map(w=>new Date(w[1]).toISOString())]) : [];
    const affected = new Set([...batch,...candidates].map(r=>r.id));
    const groups = new Set(labels.filter(r=>affected.has(r.record_id)).map(r=>r.group_id));
    const extraIds = labels.filter(r=>groups.has(r.group_id) && !affected.has(r.record_id)).map(r=>r.record_id);
    for (const id of extraIds) affected.add(id);
    if (extraIds.length) candidates.push(...await tx.queryAll(`SELECT ${CROSS_POST_FIELDS} FROM records r
      WHERE r.tenant_id=$1 AND r.id=ANY($2::uuid[]) AND ${CROSS_POST_ELIGIBLE}`, [tenantId,extraIds]));
    return {cursor,next,batch,candidates,affected:[...affected],labels,exclusions,versions:await readVersions(tx,tenantId,[...affected])};
  }, READ);
}

async function insertGroups(tx, tenantId, groups) {
  const rows = groups.flatMap(group => group.records.map(record => {
    const matches = group.matches.filter(edge => edge.recordA === record.id || edge.recordB === record.id);
    return {record_id:record.id,group_id:group.groupId,score:Math.max(...matches.map(m=>m.score)),evidence:{version:1,matches}};
  }));
  if (rows.length) await tx.execute(`INSERT INTO record_cross_posts(tenant_id,record_id,group_id,score,evidence)
    SELECT $1,x.record_id,x.group_id,x.score,x.evidence FROM jsonb_to_recordset($2::jsonb)
      AS x(record_id uuid,group_id uuid,score double precision,evidence jsonb)
    ON CONFLICT(tenant_id,record_id) DO UPDATE SET group_id=excluded.group_id,score=excluded.score,
      evidence=excluded.evidence,matched_at=now()`, [tenantId,JSON.stringify(rows)]);
}

export async function calculateTenantCrossPosts(tenantId, {now=Date.now(),limit=2000}={}) {
  limit = Math.max(1,Math.min(2000,Math.floor(limit) || 2000));
  const data = await snapshot(tenantId,{now:+new Date(now),limit});
  // CPU comparison happens after releasing the database read transaction.
  const groups = groupCrossPosts(data.candidates,{exclusions:data.exclusions});
  await withTransaction(async tx => {
    await lock(tx,tenantId);
    if (await readCursor(tx,tenantId) !== data.cursor
      || fingerprint(await readExclusions(tx,tenantId)) !== fingerprint(data.exclusions)
      || fingerprint(await readLabels(tx,tenantId)) !== fingerprint(data.labels)
      || fingerprint(await readVersions(tx,tenantId,data.affected)) !== fingerprint(data.versions)) throw conflict();
    await tx.execute('DELETE FROM record_cross_posts WHERE tenant_id=$1 AND record_id=ANY($2::uuid[])', [tenantId,data.affected]);
    await insertGroups(tx,tenantId,groups);
    await tx.execute(`INSERT INTO tenant_settings(tenant_id,key,value) VALUES($1,$2,$3)
      ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value,updated_at=now()`, [tenantId,CROSS_POST_CURSOR,JSON.stringify(data.next)]);
  }, WRITE);
  return {tenantId,processed:data.batch.length,groups:groups.length,members:groups.reduce((n,g)=>n+g.records.length,0),done:data.next.done};
}

export async function processCrossPosts() {
  const tenants = await withTransaction(tx=>tx.queryAll("SELECT id FROM tenants WHERE status='active' ORDER BY id"),READ);
  const results=[];
  for (const tenant of tenants) {
    try { results.push(await calculateTenantCrossPosts(tenant.id)); }
    catch (err) { console.error('[CrossPosts]',tenant.id,err.code || err.message); results.push({tenantId:tenant.id,error:err.code || 'calculation_failed'}); }
  }
  return results;
}

export async function getCrossPosts(tenantId,recordId) {
  return withTransaction(async tx=>{
    const exists=await tx.queryOne('SELECT id FROM records WHERE tenant_id=$1 AND id=$2',[tenantId,recordId]);
    if (!exists) throw Object.assign(new Error('内容不存在'),{status:404,code:'record_not_found'});
    const members=await tx.queryAll(`SELECT r.id,r.platform,r.author_name AS author,COALESCE(r.published_ts,r.created_at) AS published_at,
      r.created_at,left(COALESCE(NULLIF(r.title,''),r.content),40) AS title,cp.group_id,cp.score,cp.evidence,COALESCE(rt.status,'unhandled') AS triage_status,
      r.business_visibility,r.record_type,${recordAdmissionSelectSql('r')},
      EXISTS(SELECT 1 FROM record_watchlist watched WHERE watched.tenant_id=r.tenant_id AND watched.record_id=r.id) AS is_watched,
      ${recordEffectiveRelevanceSql('r')} AS effective_relevance,${manualRecordRelevanceSql('r')} AS manual_relevance,
      rt.archived_at,COALESCE(rt.priority,'normal') AS triage_priority,COALESCE(rt.feishu_table_no,'') AS feishu_table_no
      FROM record_cross_posts current JOIN record_cross_posts cp ON cp.tenant_id=current.tenant_id AND cp.group_id=current.group_id
      JOIN records r ON r.tenant_id=cp.tenant_id AND r.id=cp.record_id
      LEFT JOIN record_triage rt ON rt.tenant_id=r.tenant_id AND rt.record_id=r.id
      WHERE current.tenant_id=$1 AND current.record_id=$2 ORDER BY r.created_at,r.id`,[tenantId,recordId]);
    const displayed = members.map(({admission_scoped,admission_allowed,effective_relevance,manual_relevance,...record}) => {
      const {business_visibility,record_type,...member} = withRecordTriageDisplay(record,{scoped:admission_scoped,admitted:admission_allowed,
        relevance:effective_relevance,manualRelevance:manual_relevance});
      return member;
    });
    return {groupId:members.length>1?members[0].group_id:null,members:members.length>1?displayed:[]};
  },READ);
}

export async function excludeCrossPost(tenantId,currentId,otherId,createdBy=null) {
  return withTransaction(async tx=>{
    await lock(tx,tenantId);
    const members=await tx.queryAll(`SELECT cp.record_id,cp.group_id FROM record_cross_posts cp
      JOIN record_cross_posts c ON c.tenant_id=cp.tenant_id AND c.group_id=cp.group_id
      WHERE c.tenant_id=$1 AND c.record_id=$2 ORDER BY cp.record_id`,[tenantId,currentId]);
    if (currentId===otherId || !members.some(r=>r.record_id===otherId)) throw Object.assign(new Error('内容不在同组，请刷新后重试'),{status:409,code:'cross_post_group_changed'});
    // Detach this member from the entire group; a third member must not reconnect it.
    for (const member of members.filter(r=>r.record_id!==otherId)) {
      const [a,b]=[member.record_id,otherId].sort();
      await tx.execute(`INSERT INTO record_cross_post_exclusions(tenant_id,record_a,record_b,created_by)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[tenantId,a,b,createdBy]);
    }
    const records=await tx.queryAll(`SELECT ${CROSS_POST_FIELDS} FROM records r WHERE r.tenant_id=$1 AND r.id=ANY($2::uuid[]) AND ${CROSS_POST_ELIGIBLE}`,
      [tenantId,members.filter(r=>r.record_id!==otherId).map(r=>r.record_id)]);
    await tx.execute('DELETE FROM record_cross_posts WHERE tenant_id=$1 AND group_id=$2',[tenantId,members[0].group_id]);
    await insertGroups(tx,tenantId,groupCrossPosts(records,{exclusions:await readExclusions(tx,tenantId)}));
    return {ok:true};
  },WRITE);
}
