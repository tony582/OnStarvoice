import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentStopFenceNotice,
  countStopFencedAgents,
  findExecutionStopFence,
  formatStopFenceElapsed,
  formatStopFenceTime,
  isAgentStopFenced,
  isExecutionStopFenced,
  stopFenceConfirmDrift,
  stopFencePendingTabKey,
  stopFenceEvidenceLabel,
  stopFenceReasonLabel,
  stopFenceReleaseDispositionShort,
  stopFenceReleaseDispositionText,
} from '../web/admin/src/pages/dispatch/cloud-tasks/stop-fence-presentation.mjs'

const NOW = Date.parse('2026-09-25T09:41:54+08:00')
const FENCED_AT = '2026-09-24T20:41:54+08:00'
const MINUTE = 60_000
const HOUR = 60 * MINUTE

function fenceTask(overrides = {}) {
  return {
    id: '2ffe3308-0000-4000-8000-000000000001',
    parent_task_id: '7a0e0000-0000-4000-8000-000000000009',
    title: '北京 · 凯迪拉克壁纸',
    platform: 'xiaohongshu',
    status: 'superseded',
    fenced_at: FENCED_AT,
    message: '旧采集页面未能安全停止，已阻止自动恢复；请人工检查页面后从任务中心继续',
    handoff_successor_task_id: '9b000000-0000-4000-8000-000000000002',
    auto_checkable: true,
    check: null,
    ...overrides,
  }
}

function agentWith(phase, {tasks = [fenceTask()], online = true, ...stopFence} = {}) {
  return {
    id: 'agent-beijing',
    display_name: '北京',
    app_version: '0.4.16',
    online,
    stop_fence: {
      phase,
      task_count: tasks.length,
      superseded_count: tasks.filter(task => task.status === 'superseded').length,
      since: FENCED_AT,
      auto_check_supported: true,
      auto_check_enabled: true,
      escalated: false,
      tasks,
      ...stopFence,
    },
  }
}

test('an agent without stop_fence has no notice and is not counted as blocked', () => {
  assert.equal(agentStopFenceNotice({id: 'a', online: true}, NOW), null)
  assert.equal(agentStopFenceNotice({id: 'a', stop_fence: null}, NOW), null)
  assert.equal(isAgentStopFenced({id: 'a', stop_fence: null}), false)
  assert.equal(countStopFencedAgents([{id: 'a'}, agentWith('awaiting_node'), agentWith('local_release_pending')]), 1)
})

test('every server phase maps to its own headline, guidance and button availability', () => {
  const expected = {
    task_action_required: {headline: '旧采集页面未确认停止 · 请处理该任务', canRecheck: false, canConfirm: false, operator: true, urgent: false},
    manual_only: {headline: '旧采集页面未确认停止 · 需人工确认', canRecheck: false, canConfirm: true, operator: true, urgent: true},
    auto_check_disabled: {headline: '旧采集页面未确认停止 · 自动核对已关闭', canRecheck: false, canConfirm: true, operator: true, urgent: true},
    offline: {headline: '旧采集页面未确认停止 · 节点上线后自动核对', canRecheck: true, canConfirm: true, operator: false, urgent: false},
    heartbeat_degraded: {headline: '旧采集页面未确认停止 · 节点状态上报不完整', canRecheck: true, canConfirm: true, operator: true, urgent: true},
    needs_operator: {headline: '旧采集页面未确认停止 · 需要到现场处理', canRecheck: true, canConfirm: true, operator: true, urgent: true},
    node_retrying: {headline: '旧采集页面未确认停止 · 核对未通过，约 3 分钟后重试', canRecheck: true, canConfirm: true, operator: false, urgent: false},
    node_checking: {headline: '旧采集页面未确认停止 · 已请求节点核对', canRecheck: false, canConfirm: true, operator: false, urgent: false},
    awaiting_node: {headline: '旧采集页面未确认停止 · 等待节点核对', canRecheck: true, canConfirm: true, operator: false, urgent: false},
    local_release_pending: {headline: '已人工确认，等待节点释放本机执行锁', canRecheck: false, canConfirm: false, operator: false, urgent: false},
  }
  const headlines = new Set()
  for (const [phase, want] of Object.entries(expected)) {
    const tasks = phase === 'task_action_required'
      ? [fenceTask({status: 'needs_action', handoff_successor_task_id: null})]
      : [fenceTask()]
    const notice = agentStopFenceNotice(agentWith(phase, {tasks}), NOW)
    assert.ok(notice, phase)
    assert.equal(notice.phase, phase)
    assert.equal(notice.headline, want.headline, phase)
    assert.equal(notice.canRecheck, want.canRecheck, `${phase} recheck`)
    assert.equal(notice.canConfirm, want.canConfirm, `${phase} confirm`)
    assert.equal(notice.operatorRequired, want.operator, `${phase} operator`)
    assert.equal(notice.urgent, want.urgent, `${phase} urgent`)
    assert.equal(notice.blocking, phase !== 'local_release_pending', `${phase} blocking`)
    assert.ok(notice.detail, `${phase} detail`)
    if (!notice.canRecheck) assert.ok(notice.recheckHint, `${phase} needs a disabled-button hint`)
    headlines.add(notice.headline)
  }
  assert.equal(headlines.size, 10)
})

test('guidance follows the phase table and never tells the operator to wait on phases that need a person', () => {
  const guidance = phase => agentStopFenceNotice(agentWith(phase), NOW).guidance
  assert.match(agentStopFenceNotice(agentWith('task_action_required', {tasks: [fenceTask({status: 'needs_action'})]}), NOW).guidance, /「继续」或「停止」/u)
  assert.match(guidance('manual_only'), /确认旧页面已停止/u)
  assert.match(guidance('auto_check_disabled'), /到该电脑检查后点「确认旧页面已停止」/u)
  assert.match(guidance('offline'), /长时间离线请检查该电脑/u)
  assert.match(guidance('heartbeat_degraded'), /收不到核对请求/u)
  assert.match(guidance('needs_operator'), /3 分钟内自动复核/u)
  assert.equal(guidance('local_release_pending'), '不影响派发')
  for (const phase of ['node_retrying', 'node_checking', 'awaiting_node']) assert.equal(guidance(phase), '')
})

test('old extensions are told to check the computer and confirm; recheck stays disabled with the same text', () => {
  const agent = agentWith('manual_only', {auto_check_supported: false})
  agent.app_version = '0.4.15'
  const notice = agentStopFenceNotice(agent, NOW)
  assert.match(notice.detail, /该节点扩展为 0\.4\.15，不支持自动核对/u)
  assert.match(notice.detail, /最稳妥是重启 Chrome/u)
  assert.match(notice.detail, /升级到 0\.4\.16 后系统会自动核对/u)
  assert.equal(notice.canRecheck, false)
  assert.equal(notice.recheckHint, notice.detail)
  assert.equal(notice.canConfirm, true)
})

test('a supported node with an unlocatable task is manual-only without an upgrade instruction', () => {
  const tasks = [fenceTask(), fenceTask({id: 'clone', auto_checkable: false})]
  const notice = agentStopFenceNotice(agentWith('manual_only', {tasks, manual_only_task_count: 1}), NOW)
  assert.match(notice.detail, /1 个任务无法定位节点本机记录/u)
  assert.doesNotMatch(notice.detail, /升级/u)
  assert.deepEqual(notice.manualOnlyTasks.map(task => task.id), ['clone'])
  assert.deepEqual(notice.supersededTasks.map(task => task.id), [fenceTask().id, 'clone'])
})

test('offline keeps the recheck button with an online-later label; node_checking disables it', () => {
  const offline = agentStopFenceNotice(agentWith('offline', {online: false}), NOW)
  assert.equal(offline.recheckLabel, '节点上线后核对')
  assert.equal(offline.canRecheck, true)
  const checking = agentStopFenceNotice(agentWith('node_checking', {tasks: [fenceTask({check: {check_id: 'c1', round: 1, issued_at: '2026-09-25T09:40:00+08:00', failure_count: 0}})]}), NOW)
  assert.equal(checking.recheckLabel, '让节点重新核对')
  assert.equal(checking.canRecheck, false)
  assert.match(checking.detail, /请求节点核对，等待返回结果/u)
})

test('retrying shows the reason and how many rounds failed', () => {
  const task = fenceTask({check: {check_id: 'c3', round: 2, failure_count: 2, last_result: {
    at: '2026-09-25T09:30:00+08:00', accepted: false, reason: 'capture_still_active', retryable: true, requires_operator: false, pending_tab_count: 0, pending_tabs: [],
  }}})
  const notice = agentStopFenceNotice(agentWith('node_retrying', {tasks: [task]}), NOW)
  assert.equal(notice.detail, '第 2 次核对未通过：已向旧采集发送精确停止信号，尚未结束，稍后自动复核')
})

test('needs_operator lists the pending pages from the latest check as platform, title and reason', () => {
  const task = fenceTask({check: {check_id: 'c4', round: 3, failure_count: 1, escalated_at: '2026-09-25T09:00:00+08:00', last_result: {
    accepted: false, reason: 'old_document_uninspectable', requires_operator: true, pending_tab_count: 3,
    pending_tabs: [
      {platform: 'xiaohongshu', evidence: 'old_document_uninspectable', title: '凯迪拉克壁纸 - 小红书搜索'},
      {platform: 'xiaohongshu', evidence: 'old_document_uninspectable', title: '凯迪拉克壁纸 - 小红书搜索'},
      {platform: 'douyin', evidence: 'source_identity_unverifiable', title: ''},
    ],
  }}})
  const notice = agentStopFenceNotice(agentWith('needs_operator', {tasks: [task], escalated: true}), NOW)
  assert.match(notice.detail, /扩展重载或升级前打开的，无法自动确认/u)
  assert.deepEqual(notice.pendingTabs, [
    {platform: 'xiaohongshu', platformLabel: '小红书', evidence: 'old_document_uninspectable', reason: '扩展重载或升级前打开，无法自动确认', title: '凯迪拉克壁纸 - 小红书搜索'},
    {platform: 'douyin', platformLabel: '抖音', evidence: 'source_identity_unverifiable', reason: '无法确认页面身份', title: '未命名页面'},
  ])
  assert.equal(notice.canRecheck, true, 'after closing the pages the operator may ask for an immediate recheck')
})

test('pages from an accepted check result are not listed as pending', () => {
  const accepted = fenceTask({id: 'accepted', check: {check_id: 'c5', last_result: {accepted: true, reason: 'previous_capture_stopped',
    pending_tabs: [{platform: 'weibo', evidence: 'probe_failed', title: '旧页面'}]}}})
  assert.deepEqual(agentStopFenceNotice(agentWith('awaiting_node', {tasks: [accepted]}), NOW).pendingTabs, [])
})

test('the row label never says 暂停 and switches to 需人工处理 for operator phases', () => {
  const waiting = agentStopFenceNotice(agentWith('awaiting_node'), NOW)
  assert.equal(waiting.rowLabel, '待确认停止 · 暂不派新任务 · 已等待 13 小时')
  const manual = agentStopFenceNotice(agentWith('needs_operator'), NOW)
  assert.equal(manual.rowLabel, '待确认停止 · 需人工处理 · 已等待 13 小时')
  assert.equal(agentStopFenceNotice(agentWith('local_release_pending'), NOW).rowLabel, '')
  for (const notice of [waiting, manual]) assert.doesNotMatch(notice.rowLabel, /暂停/u)
})

test('confirm only covers superseded fences; tasks that still need action are listed separately', () => {
  const tasks = [fenceTask(), fenceTask({id: 'needs-action', status: 'needs_action', handoff_successor_task_id: null})]
  const notice = agentStopFenceNotice(agentWith('awaiting_node', {tasks}), NOW)
  assert.deepEqual(notice.supersededTasks.map(task => task.id), [fenceTask().id])
  assert.deepEqual(notice.actionTasks.map(task => task.id), ['needs-action'])
  assert.equal(notice.canConfirm, true)
  assert.deepEqual(notice.confirmTaskIds, [fenceTask().id])
})

// 服务端 tasks 每个节点最多 20 条；确认接口要求当前全部已转交围栏都在 expectedTaskIds 里。
function taskId(index) {
  return `2ffe3308-0000-4000-8000-${String(index).padStart(12, '0')}`
}

test('confirm sends every superseded fence id, not only the 20 listed rows', () => {
  const allIds = Array.from({length: 25}, (_, index) => taskId(index + 1))
  const tasks = allIds.slice(0, 20).map(id => fenceTask({id}))
  const notice = agentStopFenceNotice(agentWith('manual_only', {
    tasks,
    task_count: 25,
    superseded_count: 25,
    superseded_task_ids: allIds,
  }), NOW)
  assert.equal(notice.canConfirm, true)
  assert.equal(notice.supersededTasks.length, 20)
  assert.equal(notice.supersededCount, 25)
  assert.equal(notice.unlistedSupersededCount, 5)
  assert.deepEqual([...notice.confirmTaskIds].sort(), [...allIds].sort())
  assert.equal(new Set(notice.confirmTaskIds).size, 25, 'listed ids are not sent twice')
})

test('a superseded fence pushed out of the list by older needs_action rows can still be confirmed', () => {
  const supersededId = taskId(99)
  const tasks = Array.from({length: 20}, (_, index) =>
    fenceTask({id: taskId(index + 1), status: 'needs_action', handoff_successor_task_id: null}))
  for (const phase of ['awaiting_node', 'manual_only']) {
    const notice = agentStopFenceNotice(agentWith(phase, {
      tasks,
      task_count: 21,
      superseded_count: 1,
      action_required_count: 20,
      superseded_task_ids: [supersededId],
    }), NOW)
    assert.equal(notice.supersededTasks.length, 0)
    assert.equal(notice.canConfirm, true, `${phase} keeps the confirm button`)
    assert.deepEqual(notice.confirmTaskIds, [supersededId])
    assert.equal(notice.unlistedSupersededCount, 1)
  }
  assert.equal(agentStopFenceNotice(agentWith('awaiting_node', {
    tasks, task_count: 21, superseded_count: 1, superseded_task_ids: [supersededId],
  }), NOW).detail, '等待节点下一次心跳时核对旧采集页面')
  const found = findExecutionStopFence(supersededId, [agentWith('awaiting_node', {
    tasks, superseded_count: 1, superseded_task_ids: [supersededId],
  })])
  assert.equal(found?.task.id, supersededId, 'an unlisted fence still marks its execution')
  assert.equal(found?.task.status, 'superseded')
})

test('confirm ids ignore blanks and case duplicates; the confirm button follows the server count', () => {
  const notice = agentStopFenceNotice(agentWith('awaiting_node', {
    superseded_task_ids: ['', null, fenceTask().id.toUpperCase(), taskId(7)],
  }), NOW)
  assert.deepEqual(notice.confirmTaskIds, [fenceTask().id, taskId(7)])
  assert.equal(notice.supersededCount, 2)
  const actionOnly = agentStopFenceNotice(agentWith('task_action_required', {
    tasks: [fenceTask({status: 'needs_action'})],
    superseded_count: 0,
    superseded_task_ids: [],
  }), NOW)
  assert.equal(actionOnly.canConfirm, false)
  assert.deepEqual(actionOnly.confirmTaskIds, [])
  const released = agentStopFenceNotice(agentWith('local_release_pending', {superseded_count: 1}), NOW)
  assert.equal(released.canConfirm, false, 'nothing to confirm once released')
})

test('confirm is withheld with an explanation when the page does not hold every superseded fence id', () => {
  // 服务端没给 superseded_task_ids 且列表被截断：发出去必然被确认接口 409，按钮不可点并说明原因。
  const allIds = Array.from({length: 25}, (_, index) => taskId(index + 1))
  const truncated = agentStopFenceNotice(agentWith('manual_only', {
    tasks: allIds.slice(0, 20).map(id => fenceTask({id})),
    task_count: 25,
    superseded_count: 25,
  }), NOW)
  assert.equal(truncated.canConfirm, false)
  assert.equal(truncated.confirmTaskIds.length, 20)
  assert.match(truncated.confirmHint, /共有 25 个已转交任务，本页只拿到其中 20 个/)
  const pushedOut = agentStopFenceNotice(agentWith('awaiting_node', {
    tasks: Array.from({length: 20}, (_, index) =>
      fenceTask({id: taskId(index + 1), status: 'needs_action', handoff_successor_task_id: null})),
    task_count: 21,
    superseded_count: 1,
  }), NOW)
  assert.equal(pushedOut.canConfirm, false)
  assert.deepEqual(pushedOut.confirmTaskIds, [])
  assert.match(pushedOut.confirmHint, /本页只拿到其中 0 个/)
  const complete = agentStopFenceNotice(agentWith('manual_only', {
    tasks: allIds.slice(0, 20).map(id => fenceTask({id})),
    task_count: 25,
    superseded_count: 25,
    superseded_task_ids: allIds,
  }), NOW)
  assert.equal(complete.canConfirm, true)
  assert.equal(complete.confirmHint, '')
  const actionOnly = agentStopFenceNotice(agentWith('task_action_required', {
    tasks: [fenceTask({status: 'needs_action'})],
    superseded_count: 0,
  }), NOW)
  assert.equal(actionOnly.confirmHint, '', 'nothing superseded: the panel already explains the task action')
})

test('the confirm dialog flags fences that appear after it was opened, not ones released meanwhile', () => {
  const withIds = (ids, phase = 'awaiting_node') => agentStopFenceNotice(agentWith(phase, {
    tasks: ids.map(id => fenceTask({id})),
  }), NOW)
  const snapshot = withIds([taskId(1), taskId(2)])
  assert.equal(stopFenceConfirmDrift(null, snapshot), '')
  assert.equal(stopFenceConfirmDrift(snapshot, withIds([taskId(1), taskId(2)])), '')
  assert.equal(stopFenceConfirmDrift(snapshot, withIds([taskId(2).toUpperCase()])), '',
    'a fence released by the node while the dialog is open does not block the confirm')
  assert.match(stopFenceConfirmDrift(snapshot, withIds([taskId(1), taskId(2), taskId(3)])), /待确认任务有变化，请关闭后重新打开/)
  // 仍需处理的任务在对话框打开后被转交（北京 20:41:54 → 6 秒后 superseded）：也算变化。
  const beforeHandoff = agentStopFenceNotice(agentWith('awaiting_node', {
    tasks: [fenceTask({id: taskId(1)}), fenceTask({id: taskId(2), status: 'needs_action'})],
  }), NOW)
  assert.deepEqual(beforeHandoff.confirmTaskIds, [taskId(1)])
  assert.notEqual(stopFenceConfirmDrift(beforeHandoff, snapshot), '')
  assert.match(stopFenceConfirmDrift(snapshot, agentStopFenceNotice(agentWith('task_action_required', {
    tasks: [fenceTask({id: taskId(5), status: 'needs_action'})], superseded_count: 0,
  }), NOW)), /有变化/)
  assert.match(stopFenceConfirmDrift(snapshot, null), /停止保护已解除/)
  assert.match(stopFenceConfirmDrift(snapshot, withIds([taskId(1)], 'local_release_pending')), /停止保护已解除/)
})

test('local-release rows are never shown as pending fences or used to mark an execution', () => {
  const tasks = [fenceTask({id: 'released', kind: 'local_release'}), fenceTask({id: 'fenced'})]
  const agent = agentWith('awaiting_node', {tasks})
  assert.deepEqual(agentStopFenceNotice(agent, NOW).supersededTasks.map(task => task.id), ['fenced'])
  assert.equal(isExecutionStopFenced('released', [agent]), false)
  assert.equal(isExecutionStopFenced('fenced', [agent]), true)
  const releaseOnly = agentWith('local_release_pending', {tasks: [fenceTask({id: 'fenced'})]})
  assert.equal(isExecutionStopFenced('fenced', [releaseOnly]), false, 'a released agent no longer blocks')
})

test('execution lookup returns the owning agent and task by stop_fence ids only', () => {
  const agent = agentWith('node_retrying')
  const other = {id: 'agent-mars', stop_fence: null}
  const found = findExecutionStopFence(fenceTask().id, [other, agent])
  assert.equal(found.agent, agent)
  assert.equal(found.task.id, fenceTask().id)
  assert.equal(findExecutionStopFence('', [agent]), null)
  assert.equal(findExecutionStopFence('unknown', [agent]), null)
  assert.equal(isExecutionStopFenced(fenceTask().id, null), false)
})

test('elapsed time keeps counting past one day instead of degrading to a date', () => {
  assert.equal(formatStopFenceElapsed(-1), '')
  assert.equal(formatStopFenceElapsed(Number.NaN), '')
  assert.equal(formatStopFenceElapsed(20_000), '已等待不到 1 分钟')
  assert.equal(formatStopFenceElapsed(25 * MINUTE), '已等待 25 分钟')
  assert.equal(formatStopFenceElapsed(14 * HOUR + 20 * MINUTE), '已等待 14 小时')
  assert.equal(formatStopFenceElapsed(51 * HOUR), '已等待 2 天 3 小时')
  assert.equal(formatStopFenceElapsed(48 * HOUR), '已等待 2 天')
  const notice = agentStopFenceNotice(agentWith('offline', {since: '2026-09-23T21:03:00+08:00'}), NOW)
  assert.equal(notice.elapsedLabel, '已等待 1 天 12 小时')
})

test('since falls back to the earliest fenced task and is rendered with month and day', () => {
  const tasks = [fenceTask({fenced_at: '2026-09-24T22:00:00+08:00'}), fenceTask({id: 'b', fenced_at: FENCED_AT})]
  const notice = agentStopFenceNotice(agentWith('awaiting_node', {tasks, since: null}), NOW)
  assert.equal(notice.sinceLabel, formatStopFenceTime(FENCED_AT))
  const date = new Date(FENCED_AT)
  const pad = value => String(value).padStart(2, '0')
  assert.equal(formatStopFenceTime(FENCED_AT), `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`)
  assert.equal(formatStopFenceTime('not-a-date'), '')
  assert.equal(formatStopFenceTime(null), '')
})

test('reason labels cover the agent and server reason codes from the design table', () => {
  const labels = {
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
    proof_rejected: '节点回执不满足放行条件',
    invalid_result: '节点回执格式不正确，请升级扩展或人工确认',
    local_release_done: '节点已释放本机执行锁',
    local_lock_absent: '节点已释放本机执行锁',
  }
  for (const [reason, label] of Object.entries(labels)) assert.equal(stopFenceReasonLabel(reason), label, reason)
  assert.match(stopFenceReasonLabel('old_document_uninspectable'), /关闭或刷新下列页面（或重启 Chrome），系统会在 3 分钟内自动复核/u)
  assert.match(stopFenceReasonLabel('source_identity_unverifiable'), /无法确认旧采集页面身份/u)
  assert.equal(stopFenceReasonLabel(''), '')
  assert.equal(stopFenceReasonLabel('something_new'), '节点核对未通过（something_new）')
  assert.equal(stopFenceEvidenceLabel('tab_frozen'), '页面被冻结，无法检查')
  assert.equal(stopFenceEvidenceLabel(''), '')
})

test('presentation never infers a fence from the task error code', () => {
  // 976a0c6 隐式放行时不改错误码：只有服务端 stop_fence 才算围栏。
  const agent = {id: 'a', online: true, stop_fence: null, tasks: [{error: {code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'}}]}
  assert.equal(agentStopFenceNotice(agent, NOW), null)
  assert.equal(isAgentStopFenced(agent), false)
})

test('a confirmed node still dropping its local lock is not described as taking work', () => {
  // 服务端 summarizeAgentStopFence 与心跳同一判定：人工确认后、节点释放本机执行锁之前，不派新采集。
  const held = agentStopFenceNotice(agentWith('local_release_pending', {
    tasks: [], local_release_pending_count: 1, local_release_holds_new_work: true,
  }), NOW)
  assert.equal(held.blocking, false, 'the fence itself is released')
  assert.equal(held.holdsNewWork, true)
  assert.equal(held.guidance, '节点释放本机执行锁后开始接单')
  assert.doesNotMatch(`${held.guidance}${held.detail}`, /不影响派发/u)
  assert.match(held.detail, /释放本机执行锁之前暂不领新任务/u)
  assert.equal(held.rowLabel, '已人工确认 · 等待节点释放本机执行锁')
  assert.equal(held.canConfirm, false)
  assert.equal(isAgentStopFenced(agentWith('local_release_pending', {tasks: [], local_release_holds_new_work: true})), false)

  const free = agentStopFenceNotice(agentWith('local_release_pending', {
    tasks: [], local_release_pending_count: 1, local_release_holds_new_work: false,
  }), NOW)
  assert.equal(free.holdsNewWork, false)
  assert.equal(free.guidance, '不影响派发')
  assert.equal(free.rowLabel, '')
  // 围栏阶段不受这个字段影响。
  assert.equal(agentStopFenceNotice(agentWith('awaiting_node', {local_release_holds_new_work: true}), NOW).holdsNewWork, false)
})

test('pending tabs have one stable key per platform, evidence and title', () => {
  const tab = {platform: 'xiaohongshu', evidence: 'capture_still_active', title: '搜索 · 旧关键词'}
  assert.equal(stopFencePendingTabKey(tab), stopFencePendingTabKey({...tab, reason: 'x', platformLabel: '小红书'}))
  assert.notEqual(stopFencePendingTabKey(tab), stopFencePendingTabKey({...tab, evidence: 'probe_failed'}))
  assert.equal(stopFencePendingTabKey(null), stopFencePendingTabKey({}))
})

// docs/hotfix/20260925-needs-action-fence.md：「需要处理」的批次任务由运营在「确认旧页面已停止」里一并确认。
function releasableTask(overrides = {}) {
  return fenceTask({id: taskId(50), status: 'needs_action', handoff_successor_task_id: null, auto_checkable: false,
    operator_confirmable: true, release_disposition: 'return_to_pool', title: '金星 · 檐下秋意', ...overrides})
}

test('a needs_action batch child the server marks confirmable can be confirmed from the node panel', () => {
  const notice = agentStopFenceNotice(agentWith('task_action_required', {
    tasks: [releasableTask()], superseded_count: 0, superseded_task_ids: [],
    operator_confirmable_task_ids: [taskId(50)], operator_confirmable_count: 1,
  }), NOW)
  assert.equal(notice.canConfirm, true)
  assert.equal(notice.headline, '旧采集页面未确认停止 · 需人工确认')
  assert.equal(notice.guidance, '到该电脑检查后点「确认旧页面已停止」')
  assert.deepEqual(notice.confirmTaskIds, [taskId(50)])
  assert.deepEqual(notice.releasableTasks.map(task => task.id), [taskId(50)])
  assert.equal(notice.releasableCount, 1)
  assert.deepEqual(notice.actionTasks, [])
  assert.equal(notice.canRecheck, false, 'automatic checks never cover these rows')
  assert.match(notice.recheckHint, /不能自动核对；批次任务请到该电脑检查后点「确认旧页面已停止」/u)
  assert.match(notice.detail, /1 个批次任务停在「需要处理」，节点本机已无法继续/u)
  assert.match(notice.detail, /checkpoint_flush_not_ready/u)
  assert.match(notice.detail, /最稳妥是重启 Chrome/u)
  assert.match(notice.detail, /预计：未完成关键词退回任务池，由其它节点接力/u)
  assert.doesNotMatch(notice.detail, /升级 0\.4\.16|自动核对/u)
  assert.equal(notice.operatorRequired, true)

  // Other tasks still needing an action are counted separately.
  const mixed = agentStopFenceNotice(agentWith('task_action_required', {
    tasks: [releasableTask(), releasableTask({id: taskId(51), release_disposition: 'batch_retry'}),
      fenceTask({id: taskId(52), status: 'needs_action', parent_task_id: null})],
    superseded_count: 0, operator_confirmable_task_ids: [taskId(50), taskId(51)], operator_confirmable_count: 2,
  }), NOW)
  assert.deepEqual(mixed.actionTasks.map(task => task.id), [taskId(52)])
  assert.deepEqual(mixed.confirmTaskIds, [taskId(50), taskId(51)])
  assert.match(mixed.detail, /预计：未完成关键词退回任务池[\s\S]*；未完成关键词标为需处理/u)
  assert.match(mixed.detail, /另有 1 个任务仍需在任务上点「继续」或「停止」/u)
})

test('without the server field the needs_action rows behave exactly as before', () => {
  const notice = agentStopFenceNotice(agentWith('task_action_required', {
    tasks: [releasableTask({operator_confirmable: undefined, release_disposition: undefined})], superseded_count: 0,
  }), NOW)
  assert.equal(notice.canConfirm, false)
  assert.equal(notice.headline, '旧采集页面未确认停止 · 请处理该任务')
  assert.deepEqual(notice.confirmTaskIds, [])
  assert.deepEqual(notice.releasableTasks, [])
  assert.equal(notice.actionTasks.length, 1)
  assert.equal(notice.recheckHint, '该节点的停止保护来自仍需处理的任务，请在该任务上点「继续」或「停止」')
})

test('releasable ids beyond the list are sent, but never make up for missing superseded ids', () => {
  const unlisted = agentStopFenceNotice(agentWith('task_action_required', {
    tasks: [], task_count: 1, superseded_count: 0,
    operator_confirmable_task_ids: [taskId(60)], operator_confirmable_count: 1,
  }), NOW)
  assert.equal(unlisted.canConfirm, true)
  assert.deepEqual(unlisted.confirmTaskIds, [taskId(60)])
  assert.equal(unlisted.unlistedReleasableCount, 1)
  assert.match(unlisted.detail, /预计：未完成关键词按批次分配方式交回/u)
  const found = findExecutionStopFence(taskId(60), [agentWith('task_action_required', {
    tasks: [], operator_confirmable_task_ids: [taskId(60)]})])
  assert.equal(found?.task.operator_confirmable, true, 'an unlisted releasable child still marks its execution')

  // Two superseded fences but only one id reachable: the releasable id must not fill the gap.
  const incomplete = agentStopFenceNotice(agentWith('awaiting_node', {
    tasks: [fenceTask({id: taskId(1)}), releasableTask()],
    superseded_count: 2, superseded_task_ids: [taskId(1)],
    operator_confirmable_task_ids: [taskId(50)], operator_confirmable_count: 1,
  }), NOW)
  assert.equal(incomplete.confirmTaskIds.length, 2)
  assert.equal(incomplete.canConfirm, false)
  assert.match(incomplete.confirmHint, /共有 2 个已转交任务，本页只拿到其中 1 个/u)
  const complete = agentStopFenceNotice(agentWith('awaiting_node', {
    tasks: [fenceTask({id: taskId(1)}), releasableTask()],
    superseded_count: 1, superseded_task_ids: [taskId(1)],
    operator_confirmable_task_ids: [taskId(50)], operator_confirmable_count: 1,
  }), NOW)
  assert.equal(complete.canConfirm, true)
  assert.deepEqual(complete.confirmTaskIds, [taskId(1), taskId(50)])
})

test('a releasable child appearing after the dialog opened counts as a change', () => {
  const snapshot = agentStopFenceNotice(agentWith('task_action_required', {
    tasks: [releasableTask()], superseded_count: 0, operator_confirmable_task_ids: [taskId(50)],
  }), NOW)
  const same = agentStopFenceNotice(agentWith('task_action_required', {
    tasks: [releasableTask()], superseded_count: 0, operator_confirmable_task_ids: [taskId(50)],
  }), NOW)
  assert.equal(stopFenceConfirmDrift(snapshot, same), '')
  const grown = agentStopFenceNotice(agentWith('task_action_required', {
    tasks: [releasableTask(), releasableTask({id: taskId(51)})], superseded_count: 0,
    operator_confirmable_task_ids: [taskId(50), taskId(51)],
  }), NOW)
  assert.match(stopFenceConfirmDrift(snapshot, grown), /待确认任务有变化/u)
})

test('every expected destination has a full and a short label', () => {
  const expected = {
    return_to_pool: ['未完成关键词退回任务池，由其它节点接力（已达接力上限的改为可在批次里重试）', '退回任务池'],
    batch_retry: ['未完成关键词标为需处理，可在批次里「重试失败关键词」', '可在批次重试'],
    parent_stopped: ['所在批次已停止，关键词已取消，确认只解除停止保护', '批次已停止'],
    unknown: ['未完成关键词按批次分配方式交回', '按批次分配方式交回'],
  }
  for (const [code, [text, short]] of Object.entries(expected)) {
    assert.equal(stopFenceReleaseDispositionText(code), text, code)
    assert.equal(stopFenceReleaseDispositionShort(code), short, code)
  }
  assert.equal(stopFenceReleaseDispositionText('something_new'), expected.unknown[0])
  assert.equal(stopFenceReleaseDispositionShort(null), expected.unknown[1])
  const stopped = agentStopFenceNotice(agentWith('task_action_required', {
    tasks: [releasableTask({release_disposition: 'parent_stopped'})], superseded_count: 0,
  }), NOW)
  assert.match(stopped.detail, /预计：所在批次已停止，关键词已取消，确认只解除停止保护/u)
})
