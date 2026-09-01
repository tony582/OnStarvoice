import { Router } from 'express';
import { getAllSettings, queryAll, queryOne } from '../db/init.js';
import {
  requireSessionUser,
  requireTenantAccess,
  requireTenantWriter,
} from '../middleware/auth.js';
import {
  getOpsControlPublicHealth,
  getOpsControlTenantSummary,
  normalizeOpsControlSettings,
  runOpsControlTenantObservation,
} from '../services/ops-control.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// This endpoint is intentionally public for a future monitor in a different
// failure domain. It exposes only component freshness and version, never tenant
// names, task identifiers, customer data or credentials.
router.get('/health', async (req, res, next) => {
  try {
    const health = await getOpsControlPublicHealth();
    return res.status(health.ok ? 200 : 503).json(health);
  } catch (error) {
    return next(error);
  }
});

router.use(requireTenantAccess, requireSessionUser);

router.get('/summary', async (req, res, next) => {
  try {
    return res.json(await getOpsControlTenantSummary(req.tenantId));
  } catch (error) {
    return next(error);
  }
});

router.get('/runs/:runId', async (req, res, next) => {
  try {
    const runId = String(req.params.runId || '').trim();
    if (!UUID_PATTERN.test(runId)) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_ops_control_run_id',
        message: '值守运行标识不合法',
      });
    }
    const run = await queryOne(`
      SELECT *
      FROM ops_control_runs
      WHERE id = $1 AND tenant_id = $2
    `, [runId, req.tenantId]);
    if (!run) {
      return res.status(404).json({
        ok: false,
        error: 'ops_control_run_not_found',
        message: '值守运行不存在',
      });
    }
    const [snapshots, incidents, actions] = await Promise.all([
      queryAll(`
        SELECT id, sequence, captured_at, snapshot_hash, normalized
        FROM ops_control_snapshots
        WHERE run_id = $1 AND tenant_id = $2
        ORDER BY sequence DESC
        LIMIT 20
      `, [runId, req.tenantId]),
      queryAll(`
        SELECT id, fingerprint, incident_type, severity, status,
          title, message, evidence, first_seen_at, last_seen_at, resolved_at,
          alert_delivery_status, alert_sent_at
        FROM ops_control_incidents
        WHERE run_id = $1 AND tenant_id = $2
        ORDER BY first_seen_at, id
      `, [runId, req.tenantId]),
      queryAll(`
        SELECT id, incident_id, action_type, target_type, target_id,
          status, attempt_number, snapshot_before_sequence,
          snapshot_after_sequence, result, verification, last_error,
          claimed_at, executed_at, verification_due_at, verified_at,
          created_at, updated_at
        FROM ops_control_actions
        WHERE run_id = $1 AND tenant_id = $2
        ORDER BY created_at, id
      `, [runId, req.tenantId]),
    ]);
    return res.json({ok: true, run, snapshots, incidents, actions});
  } catch (error) {
    return next(error);
  }
});

// Manual recheck follows the same persisted tenant policy as the scheduler.
// In observe mode it only records evidence; guarded actions still require the
// global action gate and an explicit tenant allowlist.
router.post(
  '/observe-now',
  requireTenantWriter,
  async (req, res, next) => {
    try {
      const settings = normalizeOpsControlSettings(
        await getAllSettings(req.tenantId),
      );
      if (!settings.enabled) {
        return res.status(409).json({
          ok: false,
          error: 'ops_control_disabled',
          message: '请先开启租户值守开关；全局 kill switch 也必须允许观察',
        });
      }
      const result = await runOpsControlTenantObservation({
        tenantId: req.tenantId,
        settings,
        force: true,
      });
      return res.json({
        ok: true,
        kind: result.kind,
        run: result.run,
        assessment: result.assessment,
        actions: result.actions,
        incidentAlert: result.incidentAlert,
        delivery: result.delivery,
      });
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
