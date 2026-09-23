import {Router} from 'express';
import {requireCaptureAgent,requireCriticalTenantAccess,requireSessionUser,requireTenantWriter} from '../middleware/auth.js';
import {isDbCapacityError} from '../db/query.js';
import {configuredAndroidTenants,createAndroidControlService} from '../services/android-control/service.js';
export function createAndroidControlRouter({service,enabledTenants=configuredAndroidTenants,
  authenticateAgent=requireCaptureAgent,authenticateUser=requireCriticalTenantAccess,
  sessionUser=requireSessionUser,tenantWriter=requireTenantWriter}={}) {
  service ||= createAndroidControlService({enabledTenants});
  const router=Router(),hits=new Map();
  const enabled=()=>enabledTenants();
  function flag(req,res,next) {
    if (!enabled().has(req.tenantId)) return res.status(404).json({ok:false,error:'android_discovery_not_enabled'});
    next();
  }
  function principal(req,res,next) {
    if (req.captureAgent?.capabilities?.agentKind!=='android_mobile') return res.status(403).json({ok:false,error:'mobile_agent_required'});
    req.mobilePrincipal={tenantId:req.tenantId,agentId:req.captureAgent.id,
      authCodeId:req.captureAgent.auth_code_id,authBindingId:req.captureAgent.auth_binding_id};
    next();
  }
  function handle(op) {return async (req,res,next)=>{
    try {res.json({ok:true,...await op(req)});} catch(error) {
      if (isDbCapacityError(error) || ['55P03','57014'].includes(error.code)) {
        res.set('Retry-After','1');return res.status(503).json({ok:false,error:'server_busy',retryAfterMs:1000});
      }
      if ([400,401,403,404,409,413,422].includes(error.status)) return res.status(error.status).json({ok:false,error:error.code});
      next(error);
    }
  };}
  router.get('/capabilities',authenticateUser,sessionUser,(req,res)=>res.json({ok:true,enabled:enabled().has(req.tenantId)}));
  router.post('/register',(req,res,next)=>{
    if (!enabled().size) return res.status(404).json({ok:false,error:'android_discovery_not_enabled'});
    const now=Date.now(),key=req.ip;
    for (const [k,v] of hits) if (v.until<=now) hits.delete(k);
    const hit=hits.get(key) || {count:0,until:now+60000};
    hit.count++;hits.set(key,hit);
    if (hit.count>10 || hits.size>10000) return res.status(429).json({ok:false,error:'rate_limited'});
    next();
  },handle(req=>service.register(req.body || {})));
  const user=[authenticateUser,sessionUser,flag], writer=[...user,tenantWriter];
  router.get('/nodes',...user,handle(req=>service.nodes(req.tenantId)));
  router.get('/runs',...user,handle(req=>service.runs(req.tenantId)));
  router.post('/runs',...writer,handle(req=>service.create(req.tenantId,req.body || {})));
  router.get('/runs/:id',...user,handle(req=>service.detail(req.tenantId,req.params.id)));
  router.post('/runs/:id/stop',...writer,handle(req=>service.stop(req.tenantId,req.params.id,req.body || {})));
  router.post('/runs/:id/resume',...writer,handle(req=>service.resume(req.tenantId,req.params.id)));
  const agent=[authenticateAgent,flag,principal];
  for (const action of ['poll','renew','complete','close']) router.post(`/agent/${action}`,...agent,
    handle(req=>service[action](req.mobilePrincipal,req.body || {})));
  return router;
}
export default createAndroidControlRouter();
