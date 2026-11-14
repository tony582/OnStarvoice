import {Router} from 'express';
import {requireAdmin, requireTenantAccess, requireSessionUser} from '../middleware/auth.js';
import {queryAll, execute, setSettings, withTransaction} from '../db/init.js';
import {applyCreatorRoster, parseCreatorRoster, queueCreatorBackfill} from '../services/followed-creator-roster.js';
import {creatorAlertSettings, creatorAlertTarget} from '../services/followed-creator-alerts.js';
import {sealDailySecret} from '../services/customer-daily-report-config.js';

const router = Router();
const session = [requireTenantAccess,requireSessionUser];
const admin = [...session,requireAdmin];
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

router.get('/followed-creators', ...session, async (req,res,next)=>{
  try {
    const accounts = await queryAll(`SELECT s.id,s.name,s.platform,s.keyword,s.account_url,s.status,s.creator_label,
      s.account_no,s.match_nicknames,s.alert_enabled,s.auto_patrol_enabled,s.last_run_at,s.next_run_at,
      s.last_error, latest.status AS latest_result,
      EXISTS (SELECT 1 FROM monitor_subscriptions official
        WHERE official.tenant_id=s.tenant_id AND official.platform=s.platform
          AND official.subject_type='official' AND official.status='active'
          AND s.account_url<>'' AND official.account_url=s.account_url) AS has_official_role
      FROM monitor_subscriptions s
      LEFT JOIN LATERAL (SELECT e.status FROM monitor_executions e
        WHERE e.tenant_id=s.tenant_id AND e.subscription_id=s.id ORDER BY e.created_at DESC LIMIT 1) latest ON true
      WHERE s.tenant_id=$1 AND s.subject_type='creator' AND s.status<>'deleted'
        AND (s.platform='wechat_channels' OR COALESCE(s.account_url,'')<>'')
      ORDER BY COALESCE(NULLIF(s.creator_label,''),s.name),s.platform,s.id`,[req.tenantId]);
    res.json({accounts, canManage:req.canCrossTenant});
  } catch(error) { next(error); }
});

router.post('/followed-creators/import', ...admin, async (req,res,next)=>{
  try {
    const entries = parseCreatorRoster(req.body?.text);
    const rows = await applyCreatorRoster(req.tenantId, entries, req.body?.commit===true, {importing:true});
    const counts = Object.fromEntries(['create','update','error'].map(action=>[action,rows.filter(r=>r.action===action).length]));
    counts.reenable = rows.filter(row=>row.reenable).length;
    res.json({rows,counts});
  } catch(error) {
    if (error.status===400) return res.status(400).json({message:error.message});
    next(error);
  }
});

router.put('/followed-creators/account', ...admin, async (req,res,next)=>{
  try {
    const id=req.body?.id;
    if (id && !uuid.test(id)) return res.status(400).json({message:'账号标识无效'});
    const [result] = await applyCreatorRoster(req.tenantId,[{id,input:req.body}],true);
    if (result.action==='error') return res.status(400).json({message:result.message});
    res.json({ok:true});
  } catch(error) { next(error); }
});

router.delete('/followed-creators/:id', ...admin, async (req,res,next)=>{
  try {
    if (!uuid.test(req.params.id)) return res.status(400).json({message:'账号标识无效'});
    await withTransaction(async tx=>{
      await tx.execute(`UPDATE monitor_subscriptions SET status='deleted',updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND subject_type='creator'`,[req.params.id,req.tenantId]);
      await queueCreatorBackfill(tx,req.tenantId);
    });
    res.json({ok:true});
  } catch(error) { next(error); }
});

router.get('/followed-creator-alert-settings', ...admin, async (req,res,next)=>{
  try {
    const settings=await creatorAlertSettings(req.tenantId);
    const target=JSON.parse(settings.followed_creator_alert_target || '{}');
    let configured=false;
    try {configured=Boolean(await creatorAlertTarget(req.tenantId,settings));} catch {}
    const alerts=await queryAll(`SELECT id,status,last_error,created_at,payload->>'title' AS title
      FROM followed_creator_alerts WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`,[req.tenantId]);
    res.json({enabled:settings.followed_creator_alerts_enabled==='true',channel:target.channel || 'daily',
      chatId:target.chatId || '',configured,alerts});
  } catch(error) {next(error);}
});

router.put('/followed-creator-alert-settings', ...admin, async (req,res,next)=>{
  try {
    const {enabled,channel,chatId,webhookUrl,webhookSecret}=req.body || {};
    if (!['daily','app','webhook'].includes(channel)) return res.status(400).json({message:'请选择飞书发送目标'});
    const current=await creatorAlertSettings(req.tenantId);
    const saved=JSON.parse(current.followed_creator_alert_target || '{}');
    const target={};
    if (channel==='app') {
      if (!/^oc_[a-zA-Z0-9_-]{8,200}$/u.test(chatId || '')) return res.status(400).json({message:'请填写有效的飞书群 chat_id'});
      Object.assign(target,{channel,chatId});
    } else if (channel==='webhook') {
      if (webhookUrl && !/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{10,200}$/u.test(webhookUrl)) {
        return res.status(400).json({message:'请填写飞书官方群机器人地址'});
      }
      target.channel=channel;
      target.webhookUrlEncrypted=webhookUrl ? sealDailySecret(webhookUrl,req.tenantId,'followedCreatorWebhookUrl',process.env) : saved.webhookUrlEncrypted;
      target.webhookSecretEncrypted=webhookSecret ? sealDailySecret(webhookSecret,req.tenantId,'followedCreatorWebhookSecret',process.env) : saved.webhookSecretEncrypted;
      if (!target.webhookUrlEncrypted || !target.webhookSecretEncrypted) return res.status(400).json({message:'请填写机器人地址和签名密钥'});
    }
    const nextSettings={followed_creator_alerts_enabled:String(enabled===true),followed_creator_alert_target:JSON.stringify(target)};
    if (enabled===true && !await creatorAlertTarget(req.tenantId,nextSettings)) {
      return res.status(400).json({message:'请先配置日报飞书，或另填一个群'});
    }
    await setSettings(nextSettings,req.tenantId);
    res.json({ok:true});
  } catch(error) {next(error);}
});

router.post('/followed-creator-alert-settings/test', ...admin, async (req,res,next)=>{
  try {
    const target=await creatorAlertTarget(req.tenantId,await creatorAlertSettings(req.tenantId));
    if (!target) return res.status(400).json({message:'请先配置日报飞书，或另填一个群'});
    await execute("INSERT INTO followed_creator_alerts(tenant_id,payload) VALUES($1,'{\"test\":true,\"title\":\"测试消息\"}')",[req.tenantId]);
    res.json({ok:true});
  } catch(error) {next(error);}
});
export default router;
