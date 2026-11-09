import {RunnerFault} from './errors.mjs';
import {sameWork} from './wechat-patrol.mjs';
import {EXPORT_ID} from '../device/wechat-profile.mjs';

// 「发到微信」 (2026-11-09): the stored link's preview confirms the post and gives a fresh export id; the phone opens the
// post in WeChat and forwards it to one contact of the capture account. It is sent at most once: every failure before
// 发送 ends the attempt, and the server never retries a forward.
export async function runWechatForward({task, call, resolve, note}) {
  const target = task.forwardTarget;
  if (!target || typeof target.url !== 'string' || typeof target.recipient !== 'string' || !target.recipient.trim()) {
    throw new RunnerFault('invalid_forward_target');
  }
  let info = null;
  try { info = await resolve(target.url); } catch (error) { note('wechat_forward_preview_failed', error); }
  if (!info || info.unavailable || !EXPORT_ID.test(info.exportId ?? '')) throw new RunnerFault('forward_post_unavailable');
  if (Number.isSafeInteger(target.createtime) && !sameWork(info, target)) throw new RunnerFault('forward_post_mismatch');
  await call('openPost', {exportId: info.exportId});
  const sent = await call('forwardPost', {recipient: target.recipient});
  return {status: 'completed', reason: sent?.confirmed ? 'forward_sent' : 'forward_unconfirmed'};
}
