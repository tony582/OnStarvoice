import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {groupCrossPosts} from '../services/cross-posts/matching.js';
import {CROSS_POST_ELIGIBLE,CROSS_POST_FIELDS} from '../services/cross-posts/store.js';

// No initDb/app/cron imports, migration, or write mode. This command cannot backfill production.
export async function readCrossPostSnapshot({days=30,now=new Date(),withTransaction}) {
  return withTransaction(async tx=>{
    const since=new Date(+new Date(now)-days*86400000).toISOString();
    const tenants=await tx.queryAll('SELECT id,name FROM tenants ORDER BY id');
    const records=await tx.queryAll(`SELECT ${CROSS_POST_FIELDS} FROM records r
      WHERE ${CROSS_POST_ELIGIBLE} AND COALESCE(r.published_ts,r.created_at) >= $1::timestamptz - interval '72 hours'
      AND COALESCE(r.published_ts,r.created_at) <= $2::timestamptz ORDER BY r.tenant_id,r.created_at,r.id`,[since,now]);
    const exists=await tx.queryOne("SELECT to_regclass('record_cross_post_exclusions') IS NOT NULL AS present");
    const exclusions=exists.present?await tx.queryAll('SELECT tenant_id,record_a,record_b FROM record_cross_post_exclusions ORDER BY tenant_id,record_a,record_b'):[];
    return {asOf:new Date(now).toISOString(),since,tenants,records,exclusions};
  },{category:'reporting',readOnly:true,isolationLevel:'repeatable_read',statementTimeoutMs:15000,lockTimeoutMs:500});
}

export function summarizeCrossPosts(snapshot) {
  const groups=groupCrossPosts(snapshot.records,{exclusions:snapshot.exclusions || []})
    .filter(g=>g.records.some(r=>+new Date(r.published_ts || r.created_at)>=+new Date(snapshot.since)));
  const tenants=snapshot.tenants.map(tenant=>{
    const own=groups.filter(g=>g.tenantId===tenant.id);
    return {tenantId:tenant.id,name:tenant.name,groups:own.length,records:own.reduce((n,g)=>n+g.records.length,0),
      sourceRecords:snapshot.records.filter(r=>r.tenant_id===tenant.id && +new Date(r.published_ts || r.created_at)>=+new Date(snapshot.since)).length};
  });
  // Evenly spaced, deterministic sample across tenant/group order, not just the first prolific author.
  const count=Math.min(30,groups.length);
  const samples=Array.from({length:count},(_,i)=>groups[Math.floor(i*groups.length/count)]).map(g=>({
    tenantId:g.tenantId,groupId:g.groupId,matches:g.matches,
    members:g.records.map(r=>({id:r.id,platform:r.platform,author:r.author_name || r.author,
      publishedAt:r.published_ts || r.created_at,title:Array.from(r.title || r.content || '').slice(0,40).join(''),
      score:Math.max(...g.matches.filter(e=>e.recordA===r.id || e.recordB===r.id).map(e=>e.score))})),
  }));
  return {mode:'dry-run',ruleVersion:1,asOf:snapshot.asOf,since:snapshot.since,boundaryHours:72,maxGroupSize:6,
    groupCount:groups.length,memberCount:groups.reduce((n,g)=>n+g.records.length,0),tenants,samples};
}

async function main() {
  const {values}=parseArgs({options:{'dry-run':{type:'boolean'},input:{type:'string'},output:{type:'string'},days:{type:'string',default:'30'}}});
  if (!values['dry-run']) throw new Error('Explicit --dry-run is required; this script has no write mode.');
  const days=Number(values.days);
  if (!Number.isInteger(days) || days<1 || days>90) throw new Error('--days must be 1–90');
  let snapshot;
  if (values.input) snapshot=JSON.parse(await readFile(values.input,'utf8'));
  else {
    const {withTransaction}=await import('../db/query.js');
    const {closePool}=await import('../db/pool.js');
    try { snapshot=await readCrossPostSnapshot({days,withTransaction}); } finally { await closePool(); }
  }
  const report=summarizeCrossPosts(snapshot);
  const json=JSON.stringify(report,null,2)+'\n';
  if (values.output) await writeFile(values.output,json);
  console.log(JSON.stringify({mode:report.mode,groupCount:report.groupCount,memberCount:report.memberCount,tenants:report.tenants,samples:report.samples.length},null,2));
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(err=>{console.error(err.message);process.exitCode=1;});
