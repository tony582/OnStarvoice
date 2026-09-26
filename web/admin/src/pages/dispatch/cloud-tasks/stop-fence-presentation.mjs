// 停止保护（旧采集页面未确认停止）在管理端的纯展示函数。
// 唯一依据是 /capture-cloud/overview 的 agents[].stop_fence，phase 由服务端 summarizeAgentStopFence 算好；
// 这里不按 error.code 自行推断围栏或阶段：976a0c6 规则隐式放行时不改错误码，按码推断会误报。

const HEADLINE_PREFIX = '旧采集页面未确认停止 · '

// 需要有人到现场或在后台动手的阶段（与值守事件 capture_agent_stop_fence_blocked 的 high 档一致）。
const OPERATOR_PHASES = new Set([
  'task_action_required',
  'manual_only',
  'auto_check_disabled',
  'heartbeat_degraded',
  'needs_operator',
])
// 面板用红色强调的阶段：自动核对已无法推进，只能人工处理。
const URGENT_PHASES = new Set(['needs_operator', 'manual_only', 'auto_check_disabled', 'heartbeat_degraded'])

const PHASE_COPY = {
  task_action_required: {
    headline: '请处理该任务',
    guidance: '在任务或批次里点「继续」或「停止」',
  },
  manual_only: {
    headline: '需人工确认',
    guidance: '版本不支持自动核对，或任务无法定位本机记录；到该电脑检查后点「确认旧页面已停止」',
  },
  auto_check_disabled: {
    headline: '自动核对已关闭',
    guidance: '到该电脑检查后点「确认旧页面已停止」',
  },
  offline: {
    headline: '节点上线后自动核对',
    guidance: '长时间离线请检查该电脑，或检查后人工确认',
  },
  heartbeat_degraded: {
    headline: '节点状态上报不完整',
    guidance: '节点暂时收不到核对请求；检查该电脑的扩展状态，或检查后人工确认',
  },
  needs_operator: {
    headline: '需要到现场处理',
    guidance: '关闭或刷新这些页面（或重启 Chrome），系统会在 3 分钟内自动复核；也可检查后点「确认旧页面已停止」',
  },
  node_retrying: {
    headline: '核对未通过，约 3 分钟后重试',
    guidance: '',
  },
  node_checking: {
    headline: '已请求节点核对',
    guidance: '',
  },
  awaiting_node: {
    headline: '等待节点核对',
    guidance: '',
  },
  local_release_pending: {
    headline: '已人工确认，等待节点释放本机执行锁',
    guidance: '不影响派发',
  },
}

// 批次任务停在「需要处理」且带停止保护时，节点本机「继续」永远失败（checkpoint_flush_not_ready），
// 只能由运营到现场检查后在这里人工确认（服务端 stop_fence.operator_confirmable_task_ids）。phase 仍是 task_action_required。
const RELEASABLE_COPY = {
  headline: '需人工确认',
  guidance: '到该电脑检查后点「确认旧页面已停止」',
}
const RELEASABLE_RECHECK_HINT = '该节点的停止保护来自仍需处理的任务，不能自动核对；批次任务请到该电脑检查后点「确认旧页面已停止」'

// 放行前的预计去向（服务端 release_disposition，依据父批次）；实际结果以确认后的回执为准。
const RELEASE_DISPOSITION_TEXT = {
  return_to_pool: '未完成关键词退回任务池，由其它节点接力（已达接力上限的改为可在批次里重试）',
  batch_retry: '未完成关键词标为需处理，可在批次里「重试失败关键词」',
  parent_stopped: '所在批次已停止，关键词已取消，确认只解除停止保护',
  unknown: '未完成关键词按批次分配方式交回',
}
const RELEASE_DISPOSITION_SHORT = {
  return_to_pool: '退回任务池',
  batch_retry: '可在批次重试',
  parent_stopped: '批次已停止',
  unknown: '按批次分配方式交回',
}

function dispositionCode(value) {
  const code = textValue(value)
  return code in RELEASE_DISPOSITION_TEXT ? code : 'unknown'
}

export function stopFenceReleaseDispositionText(disposition) {
  return RELEASE_DISPOSITION_TEXT[dispositionCode(disposition)]
}

export function stopFenceReleaseDispositionShort(disposition) {
  return RELEASE_DISPOSITION_SHORT[dispositionCode(disposition)]
}

// 人工确认后，0.4.16 节点要先释放绑定旧任务的本机执行锁，服务端在此之前暂不给它派新采集
// （stop_fence.local_release_holds_new_work，与心跳用同一判定）。这时不能说「不影响派发」。
const LOCAL_RELEASE_HOLD_GUIDANCE = '节点释放本机执行锁后开始接单'

// 节点回执的整体原因码 → 后台文案（与设计稿「整体原因码」表逐条对应）。
const REASON_LABELS = {
  previous_capture_stopped: '节点已确认旧采集页面已停止',
  request_active: '节点本机仍在运行该任务，稍后再核对',
  capture_still_active: '已向旧采集发送精确停止信号，尚未结束，稍后自动复核',
  tab_busy_unattributed: '页面上有无法归属的采集在运行，未做处理，稍后复核',
  off_platform_observing: '旧页面已离开平台，观察满 10 分钟后确认',
  tab_frozen: '页面暂时无法检查（冻结、加载中或无响应），稍后复核',
  probe_failed: '页面暂时无法检查（冻结、加载中或无响应），稍后复核',
  checkpoint_reports_pending: '旧任务还有进度未上报，暂不关闭其运行页，稍后复核',
  runner_close_failed: '本机运行页或执行锁未能释放，稍后复核',
  lock_holder_alive: '本机运行页或执行锁未能释放，稍后复核',
  local_release_failed: '本机运行页或执行锁未能释放，稍后复核',
  request_changed: '本机运行页或执行锁未能释放，稍后复核',
  check_timeout: '核对超时或本机状态读取失败，稍后复核',
  storage_unreadable: '核对超时或本机状态读取失败，稍后复核',
  old_document_uninspectable: '旧采集页面是扩展重载或升级前打开的，无法自动确认；请在该电脑关闭或刷新下列页面（或重启 Chrome），系统会在 3 分钟内自动复核',
  source_identity_unverifiable: '无法确认旧采集页面身份，请在该电脑关闭下列页面，或检查后人工确认',
  proof_rejected: '节点回执不满足放行条件',
  invalid_result: '节点回执格式不正确，请升级扩展或人工确认',
  local_release_done: '节点已释放本机执行锁',
  local_lock_absent: '节点已释放本机执行锁',
}

// 单页证据（待处理页面）→ 简短原因，用于「平台 · 标题 · 原因」列表。
const EVIDENCE_LABELS = {
  old_document_uninspectable: '扩展重载或升级前打开，无法自动确认',
  source_identity_unverifiable: '无法确认页面身份',
  tab_frozen: '页面被冻结，无法检查',
  probe_failed: '页面加载中或无响应',
  tab_busy_unattributed: '有无法归属的采集在运行',
  capture_still_active: '已发送停止信号，尚未结束',
  off_platform_observing: '已离开平台，观察中',
  runner_close_failed: '运行页未能关闭',
  check_timeout: '核对超时，未检查完',
}

const PLATFORM_LABELS = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  weibo: '微博',
  extension: '扩展页面',
  other: '其它页面',
}

// 围栏任务只会是 superseded（已转交）或仍由节点负责的 needs_action / interrupted / failed 等。
const TASK_STATUS_LABELS = {
  superseded: '已转交其它节点',
  needs_action: '需要处理',
  interrupted: '已中断',
  failed: '失败',
  completed_with_failures: '部分失败',
  running: '运行中',
  recovering: '恢复中',
  resume_requested: '已请求继续',
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function textValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function timeValue(value) {
  const time = typeof value === 'number' ? value : Date.parse(textValue(value))
  return Number.isFinite(time) ? time : null
}

function pad(value) {
  return String(value).padStart(2, '0')
}

// 「09-24 20:41」：跨天等待时只写时分会让人误以为是今天。
export function formatStopFenceTime(value) {
  const time = timeValue(value)
  if (time === null) return ''
  const date = new Date(time)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 「已等待 14 小时 / 2 天 3 小时」。不复用 formatDate：它超过 24 小时就退化成日期，看不出卡了多久。
export function formatStopFenceElapsed(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return ''
  const minutes = Math.floor(value / 60_000)
  if (minutes < 1) return '已等待不到 1 分钟'
  if (minutes < 60) return `已等待 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `已等待 ${hours} 小时`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `已等待 ${days} 天 ${restHours} 小时` : `已等待 ${days} 天`
}

export function stopFenceReasonLabel(reason) {
  const code = textValue(reason)
  if (!code) return ''
  return REASON_LABELS[code] || `节点核对未通过（${code}）`
}

export function stopFenceEvidenceLabel(evidence) {
  const code = textValue(evidence)
  if (!code) return ''
  return EVIDENCE_LABELS[code] || REASON_LABELS[code] || code
}

export function stopFencePlatformLabel(platform) {
  const code = textValue(platform)
  return PLATFORM_LABELS[code] || code || '未识别平台'
}

export function stopFenceTaskStatusLabel(status) {
  const code = textValue(status)
  return TASK_STATUS_LABELS[code] || code || '状态未知'
}

function fenceTasks(stopFence) {
  const tasks = Array.isArray(stopFence.tasks) ? stopFence.tasks : []
  // kind='local_release' 是已放行、只等节点释放本机锁的行，不再算待确认任务。
  return tasks.filter(task => task && typeof task === 'object' && textValue(task.id) && task.kind !== 'local_release')
}

// 人工确认要带上该节点当前全部已转交围栏的 id：确认接口只要发现有没带上的已转交围栏就返回 409（agent_stop_fence_changed）。
// tasks 每个节点最多列 20 条且和仍需处理的任务混排，所以并上服务端给的完整 superseded_task_ids（同一次 /overview 快照）。
function uniqueIds(values) {
  const ids = []
  const seen = new Set()
  for (const value of values) {
    const id = textValue(value)
    if (!id || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    ids.push(id)
  }
  return ids
}

function confirmTaskIdsFrom(stopFence, supersededTasks) {
  const serverIds = Array.isArray(stopFence.superseded_task_ids) ? stopFence.superseded_task_ids : []
  return uniqueIds([...supersededTasks.map(task => task.id), ...serverIds])
}

// 可人工放行的「需要处理」批次任务：列出的并上服务端完整的 operator_confirmable_task_ids。
// 只认服务端字段，不按状态自行推断（服务端没给这个字段时，行为与之前完全一样）。
function releasableTaskIdsFrom(stopFence, releasableTasks) {
  const serverIds = Array.isArray(stopFence.operator_confirmable_task_ids) ? stopFence.operator_confirmable_task_ids : []
  return uniqueIds([...releasableTasks.map(task => task.id), ...serverIds])
}

function countValue(value) {
  const count = Math.floor(Number(value))
  return Number.isFinite(count) && count > 0 ? count : 0
}

// 节点当前是否被停止保护挡住（待释放本机锁不影响派发，不算）。
export function isAgentStopFenced(agent) {
  const stopFence = objectValue(agent?.stop_fence)
  const phase = textValue(stopFence.phase)
  return Boolean(phase) && phase !== 'local_release_pending'
}

export function countStopFencedAgents(agents) {
  return (Array.isArray(agents) ? agents : []).filter(isAgentStopFenced).length
}

// 按子任务 id 找到挡住节点的那条围栏任务；批次详情据此标注「旧页面未确认停止」。
export function findExecutionStopFence(executionId, agents) {
  const id = textValue(executionId)
  if (!id) return null
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!isAgentStopFenced(agent)) continue
    const stopFence = objectValue(agent.stop_fence)
    const task = fenceTasks(stopFence).find(candidate => candidate.id === id)
    if (task) return { agent, task }
    // 超出 20 条列表的已转交围栏只有 id，没有标题和时间。
    const serverIds = Array.isArray(stopFence.superseded_task_ids) ? stopFence.superseded_task_ids : []
    if (serverIds.some(value => textValue(value).toLowerCase() === id.toLowerCase())) {
      return { agent, task: { id, kind: 'fence', status: 'superseded' } }
    }
    const releasableIds = Array.isArray(stopFence.operator_confirmable_task_ids) ? stopFence.operator_confirmable_task_ids : []
    if (releasableIds.some(value => textValue(value).toLowerCase() === id.toLowerCase())) {
      return { agent, task: { id, kind: 'fence', status: 'needs_action', operator_confirmable: true } }
    }
  }
  return null
}

export function isExecutionStopFenced(executionId, agents) {
  return findExecutionStopFence(executionId, agents) !== null
}

function pendingTabsFrom(tasks) {
  const seen = new Set()
  const pendingTabs = []
  for (const task of tasks) {
    const lastResult = objectValue(objectValue(task.check).last_result)
    if (lastResult.accepted === true) continue
    for (const raw of Array.isArray(lastResult.pending_tabs) ? lastResult.pending_tabs : []) {
      const tab = objectValue(raw)
      const platform = textValue(tab.platform)
      const evidence = textValue(tab.evidence)
      const title = textValue(tab.title)
      const key = stopFencePendingTabKey({ platform, evidence, title })
      if (seen.has(key)) continue
      seen.add(key)
      pendingTabs.push({
        platform,
        platformLabel: stopFencePlatformLabel(platform),
        evidence,
        reason: stopFenceEvidenceLabel(evidence),
        title: title || '未命名页面',
      })
      if (pendingTabs.length >= 10) return pendingTabs
    }
  }
  return pendingTabs
}

// 有多条围栏任务时，挑最能说明现状的一条核对记录：已升级 > 需人工 > 最近有回执 > 首条。
function primaryCheck(tasks) {
  const checks = tasks.map(task => objectValue(task.check)).filter(check => Object.keys(check).length > 0)
  return checks.find(check => textValue(check.escalated_at))
    || checks.find(check => objectValue(check.last_result).requires_operator === true)
    || checks.find(check => textValue(objectValue(check.last_result).reason))
    || checks[0]
    || {}
}

// 可放行任务的预计去向：按列出的任务的 release_disposition，几种都有时各写一句。
function releasableDispositionSummary(releasableTasks) {
  const codes = uniqueIds(releasableTasks.map(task => dispositionCode(task.release_disposition)))
  return (codes.length > 0 ? codes : ['unknown']).map(code => RELEASE_DISPOSITION_TEXT[code]).join('；')
}

function releasableDetail({ releasableCount, releasableTasks, actionTasks }) {
  const others = actionTasks.length > 0 ? `；另有 ${actionTasks.length} 个任务仍需在任务上点「继续」或「停止」` : ''
  return `${releasableCount} 个批次任务停在「需要处理」，节点本机已无法继续（节点侧栏点「继续」会报 checkpoint_flush_not_ready，或提示到后台处理）；`
    + '请到这台电脑检查：关闭或刷新所有小红书、抖音、微博采集页（旧版本扩展最稳妥是重启 Chrome）后，点「确认旧页面已停止」。'
    + `确认后这些任务结束，预计：${releasableDispositionSummary(releasableTasks)}${others}`
}

function phaseDetail(phase, { agent, stopFence, supersededCount, actionTasks, manualOnlyTasks, check, releasableCount, releasableTasks }) {
  const lastResult = objectValue(check.last_result)
  const reasonLabel = stopFenceReasonLabel(lastResult.reason) || textValue(lastResult.message)
  const failureCount = Math.max(0, Math.floor(Number(check.failure_count) || 0))
  switch (phase) {
    case 'task_action_required':
      if (releasableCount > 0) return releasableDetail({ releasableCount, releasableTasks, actionTasks })
      return `${actionTasks.length || Number(stopFence.action_required_count) || 1} 个旧任务仍待处理；停止或接力后本节点即可继续接单或进入自动核对`
    case 'manual_only':
      if (stopFence.auto_check_supported !== true) {
        const version = textValue(agent?.app_version)
        return `该节点扩展为 ${version || '旧版本'}，不支持自动核对；请到这台电脑检查：关闭或刷新所有小红书、抖音、微博采集页（最稳妥是重启 Chrome）后，点「确认旧页面已停止」；升级到 0.4.16 后系统会自动核对`
      }
      return `${manualOnlyTasks.length || Number(stopFence.manual_only_task_count) || 1} 个任务无法定位节点本机记录，无法自动核对；请到该电脑检查后点「确认旧页面已停止」`
    case 'auto_check_disabled':
      return '服务端已关闭自动核对，节点不会收到核对请求'
    case 'offline':
      return '节点当前离线，上线后会自动核对旧采集页面'
    case 'heartbeat_degraded':
      return '节点在线，但完整心跳过期或状态上报不完整，暂时收不到核对请求'
    case 'needs_operator':
      return reasonLabel
        ? `节点自动核对未能完成：${reasonLabel}`
        : '节点自动核对多次未通过或已超过 30 分钟，需要人工处理'
    case 'node_retrying':
      return `${failureCount > 0 ? `第 ${failureCount} 次核对未通过` : '核对未通过'}${reasonLabel ? `：${reasonLabel}` : ''}`
    case 'node_checking': {
      const issuedAt = formatStopFenceTime(check.issued_at)
      return issuedAt ? `已于 ${issuedAt} 请求节点核对，等待返回结果` : '已请求节点核对，等待返回结果'
    }
    case 'awaiting_node':
      return supersededCount > 0 ? '等待节点下一次心跳时核对旧采集页面' : '等待节点核对旧采集页面'
    case 'local_release_pending':
      return stopFence.local_release_holds_new_work === true
        ? '已人工确认旧采集页面已停止；节点释放本机执行锁之前暂不领新任务（一般在下次心跳完成，最长约 1 小时），分配的任务会排队'
        : '已人工确认旧采集页面已停止；节点下次心跳时会释放本机执行锁'
    default:
      return ''
  }
}

function recheckState(phase, stopFence, agent, releasableCount = 0) {
  if (phase === 'manual_only') {
    return {
      canRecheck: false,
      recheckHint: stopFence.auto_check_supported !== true
        ? `该节点扩展为 ${textValue(agent?.app_version) || '旧版本'}，不支持自动核对；请到这台电脑检查：关闭或刷新所有小红书、抖音、微博采集页（最稳妥是重启 Chrome）后，点「确认旧页面已停止」；升级到 0.4.16 后系统会自动核对`
        : '有任务无法定位节点本机记录，无法自动核对；请到该电脑检查后点「确认旧页面已停止」',
    }
  }
  if (phase === 'auto_check_disabled') {
    return { canRecheck: false, recheckHint: '自动核对已在服务端关闭，请到该电脑检查后点「确认旧页面已停止」' }
  }
  if (phase === 'node_checking') {
    return { canRecheck: false, recheckHint: '已请求节点核对，等待节点返回结果' }
  }
  if (phase === 'task_action_required') {
    return {
      canRecheck: false,
      recheckHint: releasableCount > 0
        ? RELEASABLE_RECHECK_HINT
        : '该节点的停止保护来自仍需处理的任务，请在该任务上点「继续」或「停止」',
    }
  }
  if (phase === 'local_release_pending') {
    return { canRecheck: false, recheckHint: '已人工确认，无需再核对' }
  }
  if (phase === 'offline') {
    return { canRecheck: true, recheckHint: '节点当前离线，上线后会自动核对' }
  }
  return { canRecheck: true, recheckHint: '' }
}

// 返回 null 或节点级的停止保护说明。now 放在默认参数里：组件直接调用时不必在渲染里取时间。
export function agentStopFenceNotice(agent, now = Date.now()) {
  const stopFence = objectValue(agent?.stop_fence)
  const phase = textValue(stopFence.phase)
  if (!phase) return null
  const tasks = fenceTasks(stopFence)
  const supersededTasks = tasks.filter(task => task.status === 'superseded')
  // 「需要处理」的批次任务：服务端标了 operator_confirmable 的可一并人工确认，其余仍要在任务上继续或停止。
  const releasableTasks = tasks.filter(task => task.status !== 'superseded' && task.operator_confirmable === true)
  const actionTasks = tasks.filter(task => task.status !== 'superseded' && task.operator_confirmable !== true)
  const manualOnlyTasks = supersededTasks.filter(task => task.auto_checkable === false)
  const supersededConfirmIds = confirmTaskIdsFrom(stopFence, supersededTasks)
  const releasableIds = releasableTaskIdsFrom(stopFence, releasableTasks)
  const confirmTaskIds = uniqueIds([...supersededConfirmIds, ...releasableIds])
  // 以服务端计数为准：列表截断时，已转交的围栏可能一条都没列出来。
  const supersededCount = Math.max(countValue(stopFence.superseded_count), supersededConfirmIds.length)
  const releasableCount = Math.max(countValue(stopFence.operator_confirmable_count), releasableIds.length)
  const copy = phase === 'task_action_required' && releasableCount > 0
    ? RELEASABLE_COPY
    : PHASE_COPY[phase] || { headline: '等待确认', guidance: '' }
  const check = primaryCheck(supersededTasks.length > 0 ? supersededTasks : tasks)
  const since = timeValue(stopFence.since)
    ?? tasks.map(task => timeValue(task.fenced_at)).filter(value => value !== null).sort((a, b) => a - b)[0]
    ?? null
  const blocking = phase !== 'local_release_pending'
  // 围栏已放行，但节点还没释放本机执行锁：服务端暂不派新采集（有上限），单独说明，不算围栏。
  const holdsNewWork = !blocking && stopFence.local_release_holds_new_work === true
  const elapsedLabel = since === null ? '' : formatStopFenceElapsed(Number(now) - since)
  const operatorRequired = OPERATOR_PHASES.has(phase)
  const { canRecheck, recheckHint } = recheckState(phase, stopFence, agent, releasableCount)
  // 拿不全已转交围栏的 id（例如服务端没给 superseded_task_ids 而列表又被截断）时不让确认：发出去必然被确认接口 409 拒绝。
  // 只比已转交部分：并上可放行的 id 后总数够了，也不能掩盖缺失的已转交 id。
  const confirmIdsComplete = supersededConfirmIds.length >= supersededCount
  return {
    phase,
    headline: blocking ? `${HEADLINE_PREFIX}${copy.headline}` : copy.headline,
    detail: phaseDetail(phase, {
      agent, stopFence, supersededCount, actionTasks, manualOnlyTasks, check, releasableCount, releasableTasks,
    }),
    guidance: holdsNewWork ? LOCAL_RELEASE_HOLD_GUIDANCE : copy.guidance,
    sinceLabel: since === null ? '' : formatStopFenceTime(since),
    elapsedLabel,
    pendingTabs: pendingTabsFrom(supersededTasks),
    canRecheck,
    recheckHint,
    recheckLabel: phase === 'offline' ? '节点上线后核对' : '让节点重新核对',
    // 人工确认放行已转交（superseded）的围栏，以及服务端标为可放行的「需要处理」批次任务；其余仍需处理的任务要在任务上继续或停止。
    canConfirm: blocking && (supersededCount > 0 || releasableCount > 0) && confirmIdsComplete,
    confirmHint: blocking && supersededCount > 0 && !confirmIdsComplete
      ? `该节点共有 ${supersededCount} 个已转交任务，本页只拿到其中 ${supersededConfirmIds.length} 个，暂不能在此确认；请刷新后重试，仍不行请联系技术人员`
      : '',
    confirmTaskIds,
    supersededCount,
    unlistedSupersededCount: Math.max(0, supersededCount - supersededTasks.length),
    supersededTasks,
    releasableTasks,
    releasableCount,
    unlistedReleasableCount: Math.max(0, releasableCount - releasableTasks.length),
    actionTasks,
    manualOnlyTasks,
    blocking,
    holdsNewWork,
    operatorRequired,
    urgent: URGENT_PHASES.has(phase),
    rowLabel: blocking
      ? `待确认停止 · ${operatorRequired ? '需人工处理' : '暂不派新任务'}${elapsedLabel ? ` · ${elapsedLabel}` : ''}`
      : holdsNewWork ? '已人工确认 · 等待节点释放本机执行锁' : '',
  }
}

// 待处理页面的去重键（平台 + 证据 + 标题），对话框据此判断打开或勾选之后节点是否报告了新的页面。
export function stopFencePendingTabKey(tab) {
  const value = objectValue(tab)
  return `${textValue(value.platform)}\u0000${textValue(value.evidence)}\u0000${textValue(value.title)}`
}

// 确认对话框按打开那一刻的 notice 快照展示和提交；/overview 每 15 秒刷新一次，这里比较快照和最新一次，
// 返回需要提示运营的变化（空串表示可以按快照提交）。只关心“出现了快照里没有的已转交任务”或“已不能确认”：
// 快照里的任务后来被自动核对放行了不要紧，确认接口只放行当时仍在挡的那些。
export function stopFenceConfirmDrift(snapshot, live) {
  if (!snapshot) return ''
  if (!live || !live.blocking) return '该节点的停止保护已解除，无需再确认，请关闭此窗口'
  const seen = new Set(snapshot.confirmTaskIds.map(id => id.toLowerCase()))
  if (!live.canConfirm || live.confirmTaskIds.some(id => !seen.has(id.toLowerCase()))) {
    return '打开此窗口后该节点的待确认任务有变化，请关闭后重新打开，核对最新列表再确认'
  }
  return ''
}
