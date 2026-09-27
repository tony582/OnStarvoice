// 「结束并移到历史」与历史清除在管理端的纯展示函数
// （docs/hotfix/20260927-stuck-retry-and-attention-cleanup.md F3/F3b）。
// 能不能结束只看服务端 /capture-cloud/overview 的 tasks[].operator_close，
// 卡片不按状态或错误码自行推断：停止保护、进行中的工作都由服务端一次判定。

const LIVE_WORK = '仍有进行中、排队或等待自动恢复的工作，结束后再处理'

// 卡片底部说明（与服务端 OPERATOR_CLOSE_REASON_MESSAGES 同文，单测逐条比对）。
export const OPERATOR_CLOSE_BLOCKED_TEXT = Object.freeze({
  interrupted: '任务被中断，节点上的旧页面可能仍在运行；请等节点结算，或先「继续」或「停止」',
  stop_fence: '包含未确认停止的旧采集页面：批次子任务请在节点上「确认旧页面已停止」，单独的任务请先「继续」或「停止」',
  stop_pending: LIVE_WORK,
  live_child: LIVE_WORK,
  live_command: LIVE_WORK,
  device_held: '手机仍占用该任务，请先在手机页结束占用',
  live_item: LIVE_WORK,
  negative_patrol_needs_action: '含需处理的负面巡查帖子，请先在批次详情里「恢复失败巡查」，否则这些帖子不会再被巡查',
  active_discovery_demand: '仍有手机发现作品在等待补详情',
})

// 批量结果里的简短原因。
const SKIP_LABELS = Object.freeze({
  not_found: '任务不存在',
  not_root: '不是主任务',
  task_busy: '任务正在更新，请稍后重试',
  status_not_closeable: '状态已变化',
  interrupted: '任务被中断',
  stop_fence: '待确认旧页面停止',
  stop_pending: '仍有进行中的工作',
  live_child: '仍有进行中的工作',
  live_command: '仍有进行中的工作',
  live_item: '仍有进行中的工作',
  device_held: '手机仍占用',
  negative_patrol_needs_action: '含需处理的负面巡查',
  active_discovery_demand: '仍有作品等待补详情',
})

function isAttentionRoot(task) {
  return Boolean(task) && !task.parent_task_id && !task.attention_dismissed_at
}

export function canOperatorClose(task) {
  return isAttentionRoot(task) &&
    task.status === 'needs_action' &&
    task.operator_close?.eligible === true
}

export function operatorCloseBlockedText(reason) {
  return OPERATOR_CLOSE_BLOCKED_TEXT[String(reason || '')] || ''
}

// 需处理卡片上「为什么不能结束」的一行说明；可结束或原因不需要解释时为空。
export function operatorCloseBlockedReason(task) {
  if (!isAttentionRoot(task) || !['needs_action', 'interrupted'].includes(task.status)) return ''
  if (!task.operator_close || task.operator_close.eligible === true) return ''
  return operatorCloseBlockedText(task.operator_close.reason)
}

export function operatorCloseConfirmText(task) {
  const lines = [
    `结束「${task?.title || '当前任务'}」并移到历史？`,
    '· 不会重新采集，也不会向设备发送任何指令；',
    '· 已采集的内容、运行结果和执行记录全部保留；',
    '· 未完成的工作项会标记为失败，原状态和原因记录在任务详情里。',
  ]
  if (task?.task_type === 'discovered_post_capture' || task?.metadata?.workflow === 'discovered_post_capture') {
    lines.push('该作品仍可在对应手机批次里「重新处理」。')
  }
  return lines.join('\n')
}

export function operatorCloseBulkConfirmText(count) {
  return `将 ${count} 个无法继续的任务结束并移到历史？不会重新采集，也不会给设备发指令；采集结果保留。`
}

export function operatorCloseBulkResultText(result = {}) {
  const closed = Array.isArray(result.closedTaskIds) ? result.closedTaskIds.length : 0
  const already = Array.isArray(result.alreadyClosedTaskIds) ? result.alreadyClosedTaskIds.length : 0
  const skipped = Array.isArray(result.skipped) ? result.skipped : []
  let text = `已结束 ${closed} 个任务并移到历史`
  if (already > 0) text += `（另有 ${already} 个此前已结束）`
  if (skipped.length > 0) {
    const reasons = [...new Set(skipped.map(skip => SKIP_LABELS[skip?.reason] || '状态已变化'))]
    text += `；${skipped.length} 个未处理（${reasons.join('、')}）`
  }
  return text
}

export const HISTORY_CLEAR_SKIPPED_TEXT = '仍有未结束的工作或仍需处理'

// /history/clear 的结果：有跳过的行时说明几条没移出，并返回这些 id 让它们保持勾选。
export function historyClearOutcome(result = {}) {
  const skipped = Array.isArray(result.skipped) ? result.skipped : []
  const cleared = Number(result.clearedCount) || 0
  return {
    keepSelectedIds: skipped.map(skip => String(skip?.taskId || '')).filter(Boolean),
    notice: skipped.length > 0
      ? `已移出 ${cleared} 条；${skipped.length} 条未移出：${HISTORY_CLEAR_SKIPPED_TEXT}`
      : result.message || `已清除 ${cleared} 条历史记录，采集内容和运行结果已保留。`,
  }
}
