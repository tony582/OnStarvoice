import {Router} from 'express';
import {requireTenantAccess,requireSessionUser,requireTenantWriter} from '../middleware/auth.js';
import {isDbCapacityError} from '../db/query.js';
import {createDiscoveryManagementService} from '../services/capture-discovery/management.js';

export function createDiscoveryManagementRouter({service=createDiscoveryManagementService(),
  tenantAccess=requireTenantAccess,session=requireSessionUser,writer=requireTenantWriter,
  enabledTenants=()=>new Set(String(process.env.ANDROID_DISCOVERY_INGEST_TENANTS||'').split(',').map(v=>v.trim())),
}={}) {
  const router=Router();
  function enabled(req,res,next) {
    const tenants=typeof enabledTenants==='function'?enabledTenants():enabledTenants;
    if (!tenants.has(req.tenantId)) return res.status(404).json({ok:false,error:'discovery_not_enabled'});
    next();
  }
  const handle=operation=>async(req,res,next)=>{
    try {res.json({ok:true,...await operation(req)});} catch(error) {
      if (isDbCapacityError(error)||['55P03','57014'].includes(error.code)) {
        res.set('Retry-After','1'); return res.status(503).json({ok:false,error:'server_busy',retryAfterMs:1000});
      }
      if ([400,403,404,409].includes(error.status)) return res.status(error.status).json({ok:false,error:error.code});
      next(error);
    }
  };
  router.get('/tasks/:id/discoveries',tenantAccess,session,enabled,handle(req=>service.list({tenantId:req.tenantId,runId:req.params.id})));
  router.post('/tasks/:id/discoveries/reprocess',tenantAccess,session,writer,enabled,handle(req=>service.reprocess({
    tenantId:req.tenantId,runId:req.params.id,userId:req.user?.id||null,requestId:req.body?.requestId,
    eventIds:req.body?.eventIds,candidateIds:req.body?.candidateIds,
  })));
  return router;
}
export default createDiscoveryManagementRouter();
