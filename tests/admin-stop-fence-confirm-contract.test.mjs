import assert from 'node:assert/strict'
import test from 'node:test'
import {summarizeAgentStopFence} from '../server/services/capture-stop-fence.js'
import {agentStopFenceNotice} from '../web/admin/src/pages/dispatch/cloud-tasks/stop-fence-presentation.mjs'

// 管理端「确认旧页面已停止」发送的 expectedTaskIds 必须覆盖服务端当前全部已转交围栏：
// 确认接口（POST /agents/:id/stop-fence/confirm）只要有一条已转交围栏不在 expectedTaskIds 里就返回 409，
// 而 /overview 的 stop_fence.tasks 每个节点最多列 20 条。这里用真实的服务端摘要喂给真实的管理端展示函数。
// 对话框打开后又出现新围栏的情形在 admin-stop-fence-panel.test.mjs 里按「打开 → 轮询 → 提交」驱动真实面板验证。

const NOW = Date.parse('2026-09-25T12:00:00.000Z')
const ago = minutes => new Date(NOW - minutes * 60_000).toISOString()
const oldExtensionAgent = {id: 'agent-beijing', status: 'active', online: true, dispatch_ready: true,
  app_version: '0.4.15', capabilities: {}}
const currentAgent = {...oldExtensionAgent, app_version: '0.4.16', capabilities: {previousCaptureStopCheckV1: true}}

function taskId(index) {
  return `2ffe3308-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function fenceRow(index, overrides = {}) {
  return {
    kind: 'fence', id: taskId(index), parent_task_id: null, agent_id: 'agent-beijing', status: 'superseded',
    platform: 'xiaohongshu', title: `关键词 ${index}`,
    error: {code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED', message: '旧采集页面未能安全停止'},
    message: '', fenced_at: ago(2000 - index), request_id: `request-${index}`, attempt_id: `attempt-${index}`,
    stop_fence_check: null, local_release_expires_at: null,
    ...overrides,
  }
}

// 与确认接口的守卫同一判定：当前已转交围栏里有没带上的 id 就拒绝。
function confirmGuardRejects(rows, expectedTaskIds) {
  const expected = new Set(expectedTaskIds.map(id => String(id).toLowerCase()))
  return rows
    .filter(row => row.kind === 'fence' && row.status === 'superseded')
    .some(row => !expected.has(String(row.id).toLowerCase()))
}

function adminConfirmPayload(agent, rows) {
  const stopFence = summarizeAgentStopFence(agent, rows, {now: NOW, autoCheckEnabled: true})
  const notice = agentStopFenceNotice({...agent, stop_fence: stopFence}, NOW)
  return {stopFence, notice}
}

test('an old-extension node with more than 20 superseded fences can be released from the admin', () => {
  const rows = Array.from({length: 25}, (_, index) => fenceRow(index + 1))
  const {stopFence, notice} = adminConfirmPayload(oldExtensionAgent, rows)
  assert.equal(stopFence.phase, 'manual_only')
  assert.equal(stopFence.tasks.length, 20, 'the listing itself stays bounded')
  assert.equal(notice.canConfirm, true)
  assert.equal(notice.supersededCount, 25)
  assert.equal(notice.confirmTaskIds.length, 25)
  assert.equal(confirmGuardRejects(rows, notice.confirmTaskIds), false)
})

test('a superseded fence behind 20 older needs_action rows keeps the confirm button and passes the guard', () => {
  const rows = [
    ...Array.from({length: 20}, (_, index) => fenceRow(index + 1, {status: 'needs_action'})),
    fenceRow(99, {fenced_at: ago(1)}),
  ]
  for (const agent of [currentAgent, oldExtensionAgent]) {
    const {stopFence, notice} = adminConfirmPayload(agent, rows)
    assert.ok(['awaiting_node', 'manual_only'].includes(stopFence.phase))
    assert.equal(notice.canConfirm, true, `${stopFence.phase} keeps the confirm button`)
    assert.deepEqual(notice.confirmTaskIds, [taskId(99)])
    assert.equal(confirmGuardRejects(rows, notice.confirmTaskIds), false)
  }
})

// docs/hotfix/20260925-needs-action-fence.md：确认接口额外放行运营显式带上的「需要处理」批次任务
// （服务端 stopFenceOperatorReleasable）；已转交围栏仍须全部带上。
function serverReleasable(row) {
  return row.kind === 'fence' && row.status === 'needs_action' && Boolean(row.parent_task_id) &&
    row.task_type === 'unattended_keyword_capture'
}

test('a needs_action batch child from the real server summary is sent with every superseded fence', () => {
  const batchChild = index => fenceRow(index, {status: 'needs_action', parent_task_id: '7a0e0000-0000-4000-8000-000000000009',
    task_type: 'unattended_keyword_capture', parent_state: {status: 'running', distributionMode: 'elastic_pool'}})
  const rows = [
    ...Array.from({length: 21}, (_, index) => batchChild(index + 1)),
    fenceRow(40, {status: 'needs_action', task_type: 'unattended_keyword_capture'}),
    fenceRow(41, {fenced_at: ago(1)}),
  ]
  for (const agent of [currentAgent, oldExtensionAgent]) {
    const {stopFence, notice} = adminConfirmPayload(agent, rows)
    assert.equal(notice.canConfirm, true)
    assert.equal(confirmGuardRejects(rows, notice.confirmTaskIds), false)
    const sent = new Set(notice.confirmTaskIds)
    const releasable = rows.filter(serverReleasable).map(row => row.id)
    assert.equal(releasable.length, 21)
    assert.ok(releasable.every(id => sent.has(id)), `${stopFence.phase}: every releasable child, listed or not`)
    assert.equal(sent.has(taskId(40)), false, 'a root task is never sent')
    assert.equal(sent.has(taskId(41)), true)
  }
  const onlyChildren = adminConfirmPayload(oldExtensionAgent, rows.filter(serverReleasable))
  assert.equal(onlyChildren.stopFence.phase, 'task_action_required')
  assert.equal(onlyChildren.notice.canConfirm, true)
  assert.equal(onlyChildren.notice.confirmTaskIds.length, 21)
})
