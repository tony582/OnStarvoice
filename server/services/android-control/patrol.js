import {claimUnattendedNegativePatrolItem, completeUnattendedNegativePatrolItem, failUnattendedNegativePatrolItem}
  from '../unattended-negative-patrol.js';

// Negative patrol of WeChat Channels posts by the phone (docs/hotfix/20261105-wechat-channels-mobile.md). The item
// is the unattended plan's own negative_post item; the rotation state, lease, cooldown and formal-success rules are
// the shared ones in unattended-negative-patrol.js. A post that is not found three runs in a row stops being
// patrolled (needs_action); it is never marked deleted from a missing search result.
export const PATROL_STOP_AFTER_MISSES = 3;
// Claim refusals that only mean "not now"; every other refusal skips the item for this run.
const TRANSIENT = new Set(['already_claimed', 'active_claim', 'cooldown', 'record_busy', 'content_execution_active']);

/** Publish time "YYYY-MM-DD HH:mm:ss" (Beijing, as stored for Channels posts) → epoch seconds, or null. */
export function beijingSeconds(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u);
  if (!match) return null;
  const [, y, mo, d, h, mi, se] = match.map(Number);
  return Math.floor((Date.UTC(y, mo - 1, d, h, mi, se) - 8 * 3600_000) / 1000);
}

export function patrolSearchQuery(target) {
  const caption = String(target?.content || target?.title || '').split(/\r?\n/u).find(line => line.trim()) ?? '';
  const plain = caption.replace(/#[^\s#]+/gu, ' ').replace(/[\p{Extended_Pictographic}[\]【】]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const query = Array.from(plain).slice(0, 20).join('').trim();
  return query.length >= 4 ? query : `${target?.author ?? ''} ${query}`.trim().slice(0, 40);
}

/**
 * Lease one negative_post item for this phone's new child. Distinguish a
 * temporary refusal (whose state writes must be rolled back) from a permanent
 * skipped item (whose parent must be projected before trying the next item).
 */
export async function claimPhonePatrolItem(tx, {tenantId, parent, item, childId, revision}) {
  const record = await tx.queryOne(`SELECT r.id, r.platform, r.title, r.content, r.author_name, r.publish_time, r.url, triage.archived_at
    FROM records r LEFT JOIN record_triage triage ON triage.tenant_id = r.tenant_id AND triage.record_id = r.id
    WHERE r.tenant_id = $1 AND r.id = $2`, [tenantId, item.record_id]);
  const skip = async reason => {
    await tx.execute(`UPDATE capture_task_items SET status = 'skipped', finished_at = now(), updated_at = now(),
      assignment_revision = assignment_revision + 1, metadata = metadata || jsonb_build_object('skipReason', $3::text)
      WHERE tenant_id = $1 AND id = $2`, [tenantId, item.id, reason]);
    return {status: 'skipped', reason};
  };
  if (!record) return skip('record_missing');
  if (record.archived_at) return skip('archived');
  const claimed = await claimUnattendedNegativePatrolItem(tx, {...(parent.metadata?.negativePatrolRun || {}), tenantId,
    recordId: item.record_id, itemId: item.id, executionTaskId: childId, assignmentRevision: revision, now: new Date().toISOString()});
  if (!claimed.claimed) return TRANSIENT.has(claimed.reason)
    ? {status: 'blocked', reason: claimed.reason} : skip(claimed.reason || 'no_longer_eligible');
  const target = {recordId: record.id, url: item.url_snapshot || record.url, title: record.title || '', content: record.content || '',
    author: record.author_name || '', createtime: beijingSeconds(record.publish_time)};
  if (record.platform === 'wechat_articles') target.platform = record.platform;
  return {status: 'claimed', metadata: {mode: 'patrol', patrolTarget: target,
    searchQuery: patrolSearchQuery(record.platform === 'wechat_articles' ? {...target, content: target.title} : target)}};
}

/** Settle the rotation state when the phone reports the patrol attempt; returns the item status and outcome to keep. */
export async function settlePhonePatrol(tx, {tenantId, item, task, status, reason}) {
  const identity = {tenantId, itemId: item.id, executionTaskId: task.id, assignmentRevision: item.assignment_revision};
  const fresh = await tx.queryOne('SELECT result_observation_id, attempt_count FROM capture_task_items WHERE id=$1', [item.id]);
  if (status === 'completed' && fresh?.result_observation_id) {
    await tx.execute(`UPDATE capture_task_items SET status='completed', finished_at=COALESCE(finished_at, now()) WHERE id=$1`, [item.id]);
    await completeUnattendedNegativePatrolItem(tx, {...identity, resultObservationId: fresh.result_observation_id});
    return {itemStatus: 'completed', patrolOutcome: String(reason || 'patrol_result').slice(0, 80)};
  }
  const state = await tx.queryOne(`SELECT failure_count FROM unattended_negative_patrol_state
    WHERE tenant_id=$1 AND lease_item_id=$2 AND lease_execution_task_id=$3`, [tenantId, item.id, task.id]);
  await failUnattendedNegativePatrolItem(tx, {...identity,
    needsAction: Number(state?.failure_count || 0) + 1 >= PATROL_STOP_AFTER_MISSES});
  // The run itself went fine; the post is cooled down, not failed.
  return {itemStatus: 'completed_with_warnings', patrolOutcome: String(reason || status).slice(0, 80)};
}

/** After an accepted upload in a current patrol attempt: the observation is this item's patrol result. */
export async function bindPatrolResult(tx, {tenantId, itemId, executionTaskId, assignmentRevision, observationId}) {
  await tx.execute(`UPDATE capture_task_items SET result_observation_id = $5, updated_at = now()
    WHERE tenant_id=$1 AND id=$2 AND execution_task_id=$3 AND assignment_revision=$4 AND item_type='negative_post'`,
  [tenantId, itemId, executionTaskId, assignmentRevision, observationId]);
}
