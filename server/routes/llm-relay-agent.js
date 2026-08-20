import { Router } from 'express';

import { requireLlmRelayAgent } from '../middleware/llm-relay-agent.js';
import {
  claimNextLlmRelayJob,
  completeLlmRelayJob,
  heartbeatLlmRelayAgent,
} from '../services/llm-relay-jobs.js';

const router = Router();
router.use(requireLlmRelayAgent);

function relayStatus(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

router.post('/agent/claim', async (req, res, next) => {
  try {
    const job = await claimNextLlmRelayJob(req.llmRelayAgent);
    return res.json({ok: true, job});
  } catch (error) {
    if (error?.code) {
      return res.status(relayStatus(error)).json({
        ok: false,
        error: error.code,
        message: error.message,
      });
    }
    return next(error);
  }
});

router.post('/agent/heartbeat', async (req, res, next) => {
  try {
    const heartbeat = await heartbeatLlmRelayAgent(req.llmRelayAgent);
    return res.json({ok: true, heartbeat});
  } catch (error) {
    if (error?.code) {
      return res.status(relayStatus(error)).json({
        ok: false,
        error: error.code,
        message: error.message,
      });
    }
    return next(error);
  }
});

router.post('/agent/jobs/:id/complete', async (req, res, next) => {
  try {
    const completion = await completeLlmRelayJob(
      req.llmRelayAgent,
      req.params.id,
      req.body || {},
    );
    return res.json({ok: true, completion});
  } catch (error) {
    if (error?.code) {
      return res.status(relayStatus(error)).json({
        ok: false,
        error: error.code,
        message: error.message,
      });
    }
    return next(error);
  }
});

export default router;
