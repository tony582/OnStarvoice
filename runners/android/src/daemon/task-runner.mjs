import {runDiscoveryTask} from '../core/discovery-runner.mjs';
import {runWechatTask} from '../core/wechat-runner.mjs';
import {createCardPrefilter} from '../core/card-prefilter.mjs';
import {settleDevice} from './settle-device.mjs';
import {PLATFORMS} from './multi-device.mjs';

/**
 * Run one claimed task on the adapter of its platform and settle that adapter afterwards. A task without a
 * platform field is a Douyin discovery task (servers before 0.4.0 never send one).
 */
export async function runClaimedTask({task, device, store, permit, clock, control, actionTimeoutMs, deviceClosureVerified}) {
  const platform = task.platform ?? PLATFORMS.douyin;
  const adapter = device.forPlatform ? device.forPlatform(platform) : platform === PLATFORMS.douyin ? device : null;
  const common = {task, store, permit, clock, actionTimeoutMs, resumeAuthorized: task.resumeAuthorized === true,
    prefilter: options => createCardPrefilter({...options, client: control}), deviceClosureVerified};
  if (!adapter) {
    return {status: 'needs_action', reason: 'platform_unsupported', stats: null, deviceIdle: true, pendingEvents: store.pendingCount()};
  }
  const result = platform === PLATFORMS.wechat
    ? await runWechatTask({...common, device: adapter, preview: device.preview})
    : await runDiscoveryTask({...common, device: adapter});
  return settleDevice({device: adapter, store, task, result, clock, permit});
}
