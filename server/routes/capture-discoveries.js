import {resolveDouyinShareUrl} from '../services/capture-discovery/share-resolver.js';
import {Router} from 'express';
import {requireCaptureAgent} from '../middleware/auth.js';
import {isDbCapacityError} from '../db/query.js';
import {createDiscoveryRepository} from '../services/capture-discovery/repository.js';
import {createDiscoveryService} from '../services/capture-discovery/service.js';

function configuredTenants() {
  return new Set(String(process.env.ANDROID_DISCOVERY_INGEST_TENANTS || '')
    .split(',').map(value => value.trim()).filter(Boolean));
}

/** Ingestion-only pilot. Registration, device dispatch and detail capture are
 * deliberately not enabled by this flag; ordinary browsers keep their protocol. */
export function createCaptureDiscoveriesRouter({
  authenticateAgent = requireCaptureAgent,
  enabledTenants = configuredTenants,
  service = createDiscoveryService({repository: createDiscoveryRepository(), resolveShareUrl: resolveDouyinShareUrl}),
} = {}) {
  const router = Router();
  const enabled = () => typeof enabledTenants === 'function' ? enabledTenants() : enabledTenants;
  function featureAvailable(req, res, next) {
    if (!enabled()?.size) return res.status(404).json({ok: false, error: 'discovery_not_enabled'});
    next();
  }
  function mobilePrincipal(req, res, next) {
    const agent = req.captureAgent;
    if (!agent || !enabled().has(agent.tenant_id)) {
      return res.status(403).json({ok: false, error: 'discovery_not_enabled'});
    }
    if (agent.capabilities?.agentKind !== 'android_mobile'
      || agent.capabilities?.mobileSearchDiscoveryV1 !== true
      || !agent.allowed_platforms?.includes('douyin')) {
      return res.status(403).json({ok: false, error: 'mobile_discovery_agent_required'});
    }
    req.discoveryPrincipal = {
      tenantId: agent.tenant_id, agentId: agent.id,
      authCodeId: agent.auth_code_id, authBindingId: agent.auth_binding_id,
    };
    next();
  }
  const access = [featureAvailable, authenticateAgent, mobilePrincipal];
  function handle(operation) {
    return async (req, res, next) => {
      try { res.json({ok: true, ...await operation(req)}); }
      catch (error) {
        if (isDbCapacityError(error) || ['55P03', '57014'].includes(error.code)) {
          const retryAfterMs = Math.max(1000, Number(error.retryAfterMs) || 1000);
          res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
          return res.status(503).json({ok: false, error: 'server_busy', retryAfterMs});
        }
        if ([400, 403, 404, 409, 413, 422].includes(error.status) && error.code) {
          return res.status(error.status).json({ok: false, error: error.code});
        }
        next(error);
      }
    };
  }
  router.post('/agent/discoveries', ...access, handle(req => service.ingestBatch({
    principal: req.discoveryPrincipal, batch: req.body,
  })));
  router.get('/agent/discovery-receipts', ...access, handle(req => service.getReceipts({
    principal: req.discoveryPrincipal, uploadBatchId: req.query.batchId,
  })));
  return router;
}

export default createCaptureDiscoveriesRouter();
