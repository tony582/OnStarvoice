import {Router,raw} from 'express';
import {requireTenantAccess,requireSessionUser,requireAdmin} from '../middleware/auth.js';
import {customerAssistantService} from '../services/customer-assistant-service.js';

const handle=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(error){
  if(error.status||error.safeMessage)return res.status(error.status||500).json({ok:false,error:error.code||'assistant_error',message:error.safeMessage||'请求未完成。'});
  next(error);
}};
export function createCustomerAssistantWebhookRouter(service=customerAssistantService) {
  const router=Router();
  router.post('/:tenantId',raw({type:'application/json',limit:'256kb'}),handle(async(req,res)=>{
    res.json(await service.receive(req.params.tenantId,req.body,req.headers));
  }));
  return router;
}
export function createCustomerAssistantRouter(service=customerAssistantService,{authorize=[requireTenantAccess,requireSessionUser,requireAdmin]}={}) {
  const router=Router();router.use(...authorize);
  router.get('/settings',handle(async(req,res)=>res.json({ok:true,settings:await service.settings(req.tenantId),callbackPath:`/api/customer-assistant/feishu/${req.tenantId}`})));
  router.put('/settings',handle(async(req,res)=>res.json({ok:true,settings:await service.saveSettings(req.tenantId,req.body,req.user.id)})));
  router.post('/preview',handle(async(req,res)=>res.json({ok:true,...await service.preview(req.tenantId,req.body,req.user.id)})));
  router.get('/activity',handle(async(req,res)=>res.json({ok:true,events:await service.activity(req.tenantId)})));
  return router;
}
