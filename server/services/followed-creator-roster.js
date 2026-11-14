import {findOfficialRecordOwner} from './official-account-identity.js';
import {withTransaction} from '../db/init.js';
import {canonicalProfileUrl, creatorProfileId, normalizeCreatorNickname, matchFollowedCreator, loadCreatorCandidates} from './followed-creator-identity.js';
import {nextCreatorPatrolTime} from './followed-creator-schedule.js';

const trim = value => String(value ?? '').toWellFormed().trim().slice(0, 2000).toWellFormed();
function invalid(message) { return Object.assign(new Error(message), {status:400}); }

// status is roster membership; alertEnabled and autoPatrolEnabled are independent switches.
export function normalizeCreatorAccount(input) {
  const platform = trim(input.platform);
  const label = trim(input.creatorLabel);
  if (!label) throw invalid('请填写博主名称');
  const name = trim(input.name) || label;
  const status = input.status || 'active';
  if (!['active','paused'].includes(status)) throw invalid('账号状态无效');
  const alertEnabled = input.alertEnabled !== false;
  if (platform === 'wechat_channels') {
    const nicknames = [...new Set([name,...trim(input.aliases).split(/[,，\n]/u)]
      .map(normalizeCreatorNickname).filter(Boolean))];
    if (!nicknames.length) throw invalid('请填写有效的视频号昵称');
    return {platform,label,name,status,alertEnabled,autoPatrol:false,url:'',keyword:trim(input.finderId),nicknames,accountNo:''};
  }
  const url = canonicalProfileUrl(input.url, platform);
  const keyword = creatorProfileId(url, platform);
  if (!url || !keyword) throw invalid('请填写对应平台的有效博主主页链接');
  return {platform,label,name,status,alertEnabled,autoPatrol:input.autoPatrolEnabled===true,url,keyword,nicknames:null,accountNo:trim(input.accountNo)};
}

export function parseCreatorRoster(tsv) {
  const lines = trimRoster(tsv);
  const header = lines.shift()?.split('\t').map(v=>v.trim().replace(/^\uFEFF/u,''));
  if (!header?.includes('博主 / 账号') || !header.some(key=>['抖音主页链接','视频号名称'].includes(key))) {
    throw invalid('请粘贴包含「博主 / 账号」和平台列的 Excel 名单');
  }
  let previousLabel = '';
  return lines.flatMap((line,index)=>{
    if (!line.trim()) return [];
    const columns = line.split('\t');
    const get = key => {
      const value = trim(columns[header.indexOf(key)]);
      return /^[-—–−－]+$/u.test(value) ? '' : value;
    };
    const douyin = get('抖音名称');
    const channel = get('视频号名称');
    const label = get('博主 / 账号') || [douyin, channel].find(name => /疑似|待确认/u.test(name)) || previousLabel;
    const suspect = /疑似|待确认/u.test([label, douyin, channel].join(' '));
    previousLabel = suspect ? '' : label;
    const inputs = [];
    const url = get('抖音主页链接');
    if (douyin || url) inputs.push({platform:'douyin',creatorLabel:label,name:douyin,url,accountNo:get('抖音号')});
    if (channel) inputs.push({platform:'wechat_channels',creatorLabel:label,name:channel,finderId:get('视频号ID') || get('视频号 ID') || get('视频号原始ID')});
    return inputs.length ? inputs.map(input=>({line:index+2,input:{...input,alertEnabled:!suspect}})) :
      [{line:index+2,error:'本行没有可导入的平台账号'}];
  });
}

function trimRoster(value) {
  const text = String(value ?? '').toWellFormed();
  if (text.length > 150000) throw invalid('名单文本超过长度限制');
  return text.split(/\r?\n/u);
}

async function applyAccounts(tx, tenantId, entries, commit, {importing}) {
  await tx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`creator-roster:${tenantId}`]);
  const existing = await tx.queryAll(`SELECT * FROM monitor_subscriptions WHERE tenant_id=$1
    AND subject_type='creator' AND status<>'deleted' FOR UPDATE`, [tenantId]);
  const results = [];
  const seen = new Set();
  const setting = await tx.queryOne("SELECT value FROM tenant_settings WHERE tenant_id=$1 AND key='monitor_runTimes'",[tenantId]);
  for (const entry of entries) {
    try {
      if (entry.error) throw invalid(entry.error);
      const account = normalizeCreatorAccount(entry.input);
      const identity = account.nicknames?.[0] || account.keyword;
      const key = `${account.platform}:${identity}`;
      if (seen.has(key)) throw invalid('名单中有重复账号');
      seen.add(key);
      const match = existing.find(r=>r.platform===account.platform && (r.match_nicknames?.[0] || r.keyword)===identity);
      const current = entry.id ? existing.find(r=>r.id===entry.id) : match;
      if (entry.id && !current) throw invalid('账号已删除或不存在');
      if (entry.id && current.platform !== account.platform) throw invalid('已有账号不能更改平台');
      if (entry.id && match && match.id!==entry.id) throw invalid('该平台账号已存在');
      if (account.nicknames && existing.some(r=>r.id!==current?.id && r.platform===account.platform &&
        r.match_nicknames?.some(n=>account.nicknames.includes(n)))) throw invalid('视频号昵称与已有账号重复');
      if (importing && current) {
        account.alertEnabled = current.alert_enabled;
        account.autoPatrol = current.auto_patrol_enabled;
      }
      const reenable = importing && current?.status === 'paused' && account.status === 'active';
      if (commit) {
        const values=[tenantId,account.platform,account.keyword,account.name,account.url,account.label,
          account.accountNo,account.nicknames,account.status,account.alertEnabled,account.autoPatrol,nextCreatorPatrolTime(setting?.value)];
        if (current) await tx.execute(`UPDATE monitor_subscriptions SET platform=$2,keyword=$3,name=$4,account_url=$5,
          creator_label=$6,account_no=$7,match_nicknames=$8,status=$9,alert_enabled=$10,auto_patrol_enabled=$11,
          patrol_retry_count=CASE WHEN NOT $11 OR $9<>'active' OR NOT auto_patrol_enabled OR status<>'active' THEN 0 ELSE patrol_retry_count END,
          next_run_at=CASE WHEN $11 AND (NOT auto_patrol_enabled OR status<>'active') THEN $12 ELSE next_run_at END,
          updated_at=now() WHERE tenant_id=$1 AND id=$13`, [...values,current.id]);
        else await tx.execute(`INSERT INTO monitor_subscriptions
          (tenant_id,platform,keyword,name,account_url,creator_label,account_no,match_nicknames,status,alert_enabled,auto_patrol_enabled,next_run_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,values);
      }
      if (!current) existing.push({platform:account.platform,keyword:account.keyword,match_nicknames:account.nicknames});
      results.push({line:entry.line,action:current?'update':'create',name:account.name,platform:account.platform,reenable});
    } catch (error) {
      if (error.status!==400) throw error;
      results.push({line:entry.line,action:'error',message:error.message});
    }
  }
  if (commit && results.some(r=>r.action!=='error')) await queueCreatorBackfill(tx,tenantId);
  return results;
}

export function applyCreatorRoster(tenantId, entries, commit, options = {}) {
  return withTransaction(tx=>applyAccounts(tx,tenantId,entries,commit,options));
}

export function queueCreatorBackfill(tx, tenantId) {
  return tx.execute(`INSERT INTO followed_creator_backfills(tenant_id) VALUES($1)
    ON CONFLICT(tenant_id) DO UPDATE SET cursor_time=NULL,cursor_id=NULL,requested_at=now()`,[tenantId]);
}

export function processFollowedCreatorBackfill() {
  return withTransaction(async tx=>{
    const job = await tx.queryOne(`SELECT *,cursor_time::text AS cursor_time_text FROM followed_creator_backfills ORDER BY requested_at
      LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!job) return;
    // Use text timestamps for the cursor: JS Date would truncate PG microseconds.
    const rows = await tx.queryAll(`SELECT id,platform,record_type,author_id,author_name,blogger_profile_url,
      author_account_no, followed_creator_subscription_id,created_at::text AS cursor_time
      FROM records WHERE tenant_id=$1 AND created_at>=now()-interval '90 days'
        AND ($2::timestamptz IS NULL OR (created_at,id)>($2::timestamptz,$3::uuid))
        AND platform IN ('douyin','xiaohongshu','weibo','wechat_channels')
      ORDER BY created_at,id LIMIT 200 FOR UPDATE`,[job.tenant_id,job.cursor_time_text || null,job.cursor_id]);
    const candidates = new Map();
    const official = await tx.queryAll("SELECT * FROM official_accounts WHERE tenant_id=$1 AND status='active'", [job.tenant_id]);
    for (const record of rows) {
      if (!candidates.has(record.platform)) candidates.set(record.platform,await loadCreatorCandidates(tx,job.tenant_id,record.platform));
      const id=findOfficialRecordOwner(record,official) ? null : matchFollowedCreator(record,candidates.get(record.platform));
      if (id!==record.followed_creator_subscription_id) await tx.execute(
        'UPDATE records SET followed_creator_subscription_id=$1 WHERE id=$2 AND tenant_id=$3',[id,record.id,job.tenant_id]);
    }
    if (rows.length<200) await tx.execute('DELETE FROM followed_creator_backfills WHERE tenant_id=$1',[job.tenant_id]);
    else await tx.execute('UPDATE followed_creator_backfills SET cursor_time=$1,cursor_id=$2 WHERE tenant_id=$3',
      [rows.at(-1).cursor_time,rows.at(-1).id,job.tenant_id]);
  });
}
