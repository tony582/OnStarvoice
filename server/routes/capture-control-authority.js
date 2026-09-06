import {Router} from 'express';
import {getCaptureAgentToken} from '../middleware/auth.js';
import {evaluateTerminalControlAuthority} from '../services/capture-control-authority.js';

export function createCaptureControlAuthorityRouter({evaluate = evaluateTerminalControlAuthority} = {}) {
  const router = Router();
  router.post('/agent/control-authority', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    try {
      const result = await evaluate({token: getCaptureAgentToken(req), body: req.body});
      const status = result.ok ? 200 : result.reason === 'invalid_control_target' ? 400 :
        ['invalid_agent_token', 'agent_entitlement_unavailable'].includes(result.reason) ? 403 : 409;
      return res.status(status).json(result);
    } catch (error) {
      return next(error);
    }
  });
  return router;
}

export default createCaptureControlAuthorityRouter();
