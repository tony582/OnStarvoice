import {safeJson, text} from './control-outcome-projection.js';

export function profilePatrolIntent(source = {}) {
  const value = safeJson(source);
  const targetMode = text(
    value.targetMode || value.target_mode,
    80,
  ).toLowerCase();
  if (targetMode) {
    if ([
      'profile',
      'account',
      'account_profile',
      'profile_patrol',
      'profile_scan',
    ].includes(targetMode)) {
      return true;
    }
    if ([
      'post',
      'detail',
      'record',
      'direct',
      'single_post',
      'post_detail',
    ].includes(targetMode)) {
      return false;
    }
  }
  const profileMode = value.profileMode ?? value.profile_mode;
  if (profileMode === true || profileMode === 'true' || profileMode === 1) {
    return true;
  }
  if (profileMode === false || profileMode === 'false' || profileMode === 0) {
    return false;
  }
  return null;
}

export function isProfilePatrolTask(taskOrType = {}, payload = {}) {
  const task = typeof taskOrType === 'string'
    ? {task_type: taskOrType}
    : safeJson(taskOrType);
  const metadata = safeJson(task.metadata);
  const commandPayload = safeJson(payload);
  const taskType = text(
    task.task_type ||
      task.taskType ||
      task.workflow ||
      metadata.workflow ||
      commandPayload.workflow ||
      commandPayload.taskType,
    80,
  );
  if ([
    'followed_creator_post_patrol',
    'official_account_post_discovery',
  ].includes(taskType)) {
    return true;
  }
  if (taskType !== 'official_account_comment_patrol') {
    return false;
  }
  const taskIntent = profilePatrolIntent(task);
  if (taskIntent !== null) return taskIntent;
  const metadataIntent = profilePatrolIntent(metadata);
  if (metadataIntent !== null) return metadataIntent;
  const payloadIntent = profilePatrolIntent(commandPayload);
  return payloadIntent === true;
}
