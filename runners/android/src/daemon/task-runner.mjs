import {runDiscoveryTask} from '../core/discovery-runner.mjs';
import {runWechatTask, DEFAULT_CLOCK} from '../core/wechat-runner.mjs';
import {runWechatArticleTask} from '../core/wechat-article-runner.mjs';
import {createCardPrefilter} from '../core/card-prefilter.mjs';
import {readDeviceClosure} from '../core/device-closure.mjs';
import {recordDiagnostic} from '../core/diagnostics.mjs';
import {settleDevice} from './settle-device.mjs';
import {PLATFORMS} from './multi-device.mjs';

/**
 * Run one claimed task on the adapter of its platform and settle that adapter afterwards. A task without a
 * platform field is a Douyin discovery task (servers before 0.4.0 never send one).
 */
export async function runClaimedTask({task, device, store, permit, clock = DEFAULT_CLOCK, control, actionTimeoutMs, deviceClosureVerified}) {
  device.setTaskActive?.(true);
  try {
    const platform = task.platform ?? PLATFORMS.douyin;
    const adapter = device.forPlatform ? device.forPlatform(platform) : platform === PLATFORMS.douyin ? device : null;
    const common = {task, store, permit, clock, actionTimeoutMs, resumeAuthorized: task.resumeAuthorized === true,
      prefilter: options => createCardPrefilter({...options, client: control}), deviceClosureVerified};
    if (!adapter) {
      return {status: 'needs_action', reason: 'platform_unsupported', stats: null, deviceIdle: true, pendingEvents: store.pendingCount()};
    }
    if ([PLATFORMS.wechat, PLATFORMS.articles].includes(platform) && typeof device.prepareTask === 'function') {
      try {
        permit.assertAllowed();
        const startedAt = clock.monotonicNow();
        // Preparation owns no phone operation; core starts its ledger and operation gate afterwards.
        await device.prepareTask({platform, signal: permit.signal});
        common.preparationMs = Math.max(0, clock.monotonicNow() - startedAt);
        permit.assertAllowed();
      } catch (error) {
        let fault = error;
        try { permit.assertAllowed(); } catch (controlError) { fault = controlError; }
        const code = permit.signal.aborted ? permit.signal.reason?.code || 'aborted' : fault.code;
        const canceled = ['user_stop', 'operator_takeover', 'remote_stop'].includes(code);
        const interrupted = ['lease_expired', 'usb_disconnected', 'aborted'].includes(code);
        const previewFailure = code?.startsWith('preview_') === true;
        // A failed preflight must not park/close the phone or clear an earlier unconfirmed operation.
        const deviceClosure = readDeviceClosure(store, task.deviceId);
        if (!previewFailure) recordDiagnostic(store, {event: 'ocr_warmup_failed', runId: task.identity.discoveryRunId,
          itemId: task.identity.itemId, at: new Date(clock.wallNow()).toISOString(), code: code || 'ocr_unavailable',
          message: error.message, details: error.details});
        return {status: canceled ? 'canceled' : interrupted ? 'interrupted' : 'needs_action',
          reason: canceled || interrupted || previewFailure ? code : 'ocr_unavailable',
          details: {operation: previewFailure ? 'preview_prepare' : 'ocr_warmup'},
          stats: null, deviceIdle: !deviceClosure?.required, stopConfirmationRequired: Boolean(deviceClosure?.required),
          deviceClosure, pendingEvents: store.pendingCount()};
      }
    }
    const result = platform === PLATFORMS.wechat
      ? await runWechatTask({...common, device: adapter, preview: device.preview})
      : platform === PLATFORMS.articles ? await runWechatArticleTask({...common, device: adapter, preview: device.preview})
        : await runDiscoveryTask({...common, device: adapter});
    return await settleDevice({device: adapter, store, task, result, clock, permit});
  } finally {
    device.setTaskActive?.(false);
  }
}
