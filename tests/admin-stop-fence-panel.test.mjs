import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import {summarizeAgentStopFence} from '../server/services/capture-stop-fence.js'
import * as presentation from '../web/admin/src/pages/dispatch/cloud-tasks/stop-fence-presentation.mjs'

// 「确认旧页面已停止」对话框在打开期间会经历 /overview 的 15 秒轮询。这里把真实的 StopFencePanel.tsx
// 转成 CommonJS，用最小的 hooks / JSX 桩手动驱动「打开 → 轮询 → 提交」，数据来自真实的服务端摘要，
// 验证提交的 expectedTaskIds 是打开时那份快照，确认接口的 agent_stop_fence_changed 守卫才能起作用。

const ts = createRequire(new URL('../web/admin/package.json', import.meta.url))('typescript')
const source = readFileSync(new URL('../web/admin/src/pages/dispatch/cloud-tasks/StopFencePanel.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX},
}).outputText

// 每个组件实例一份 hooks 槽位；只用到 useState。
let currentScope = null
function useState(initial) {
  const scope = currentScope
  const index = scope.index++
  if (!(index in scope.slots)) scope.slots[index] = typeof initial === 'function' ? initial() : initial
  const set = value => {
    scope.slots[index] = typeof value === 'function' ? value(scope.slots[index]) : value
  }
  return [scope.slots[index], set]
}
function renderWith(scope, component, props) {
  const previous = currentScope
  currentScope = scope
  scope.index = 0
  try {
    return component(props)
  } finally {
    currentScope = previous
  }
}

const Fragment = Symbol('Fragment')
const element = (type, props, key) => ({type, props: props || {}, key})
const passthrough = name => Object.assign(props => props.children, {displayName: name})
const Button = Object.assign(() => null, {displayName: 'Button'})
const modules = {
  react: {useState},
  'react/jsx-runtime': {jsx: element, jsxs: element, Fragment},
  '@radix-ui/react-dialog': Object.fromEntries(
    ['Root', 'Portal', 'Overlay', 'Content', 'Title', 'Description', 'Close'].map(name => [name, passthrough(name)])),
  'lucide-react': new Proxy({}, {get: (_, name) => Object.assign(() => null, {displayName: String(name)})}),
  '@/components/ui/button': {Button},
  './lib': {isMobileAgent: agent => agent?.capabilities?.agentKind === 'android_mobile'},
  './stop-fence-presentation.mjs': presentation,
}
const panelModule = {exports: {}}
vm.runInThisContext(`(function (exports, require, module) {\n${compiled}\n})`)(
  panelModule.exports,
  name => {
    if (!(name in modules)) throw new Error(`unexpected import ${name}`)
    return modules[name]
  },
  panelModule,
)
const {StopFencePanel, ReleaseStopFenceDialog} = panelModule.exports

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach(child => walk(child, visit))
    return
  }
  visit(node)
  walk(node.props?.children, visit)
}
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}
function findAll(tree, predicate) {
  const hits = []
  walk(tree, node => {
    if (predicate(node)) hits.push(node)
  })
  return hits
}
const findButton = (tree, label) => findAll(tree, node => node.type === Button && textOf(node).includes(label))[0] || null
const findDialog = tree => findAll(tree, node => node.type === ReleaseStopFenceDialog)[0] || null

const NOW = Date.parse('2026-09-25T12:00:00.000Z')
const ago = minutes => new Date(NOW - minutes * 60_000).toISOString()
const taskId = index => `2ffe3308-0000-4000-8000-${String(index).padStart(12, '0')}`
function fenceRow(index, overrides = {}) {
  return {
    kind: 'fence', id: taskId(index), parent_task_id: null, agent_id: 'agent-beijing', status: 'superseded',
    platform: 'xiaohongshu', title: `关键词 ${index}`,
    error: {code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED', message: '旧采集页面未能安全停止'},
    message: '', fenced_at: ago(200 - index), request_id: `request-${index}`, attempt_id: `attempt-${index}`,
    stop_fence_check: null, local_release_expires_at: null,
    ...overrides,
  }
}
const baseAgent = {id: 'agent-beijing', display_name: '北京', status: 'active', online: true, dispatch_ready: true,
  app_version: '0.4.15', capabilities: {}}
const agentWith = rows => ({
  ...baseAgent,
  stop_fence: summarizeAgentStopFence(baseAgent, rows, {now: NOW, autoCheckEnabled: true}),
})
// 与确认接口（POST /agents/:id/stop-fence/confirm）同一判定：当前已转交围栏里有没带上的 id 就 409。
const confirmGuardRejects = (rows, expectedTaskIds) => {
  const expected = new Set(expectedTaskIds.map(id => String(id).toLowerCase()))
  return rows.filter(row => row.status === 'superseded').some(row => !expected.has(row.id.toLowerCase()))
}

// 面板挂在一个假的 /overview 上：render(rows) 相当于一次轮询，确认接口按当前 rows 执行守卫。
function mountPanel() {
  const panelScope = {slots: [], index: 0}
  const dialogScope = {slots: [], index: 0}
  const sent = []
  let serverRows = []
  const props = agent => ({
    agent, writable: true, compact: false,
    onRecheck: async () => {},
    onConfirm: async (_agent, expectedTaskIds, note) => {
      sent.push({expectedTaskIds: [...expectedTaskIds], note})
      if (confirmGuardRejects(serverRows, expectedTaskIds)) throw new Error('该节点的待确认任务已变化，请刷新后重新确认')
      serverRows = serverRows.filter(row => row.status !== 'superseded')
    },
  })
  const renderDialog = dialog => renderWith(dialogScope, ReleaseStopFenceDialog, dialog.props)
  return {
    sent,
    render(rows) {
      serverRows = rows
      const tree = renderWith(panelScope, StopFencePanel, props(agentWith(rows)))
      const dialog = findDialog(tree)
      if (!dialog) dialogScope.slots = []
      return {tree, dialog, dialogTree: dialog ? renderDialog(dialog) : null}
    },
    // 勾选「我已在该电脑检查」后重新渲染对话框。
    tick(view) {
      const checkbox = findAll(view.dialogTree, node => node.type === 'input' && node.props.type === 'checkbox')[0]
      checkbox.props.onChange({target: {checked: true}})
      return renderDialog(view.dialog)
    },
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('a task handed off while the confirm dialog is open is neither shown as confirmed nor sent', async () => {
  const panel = mountPanel()
  // 快照 A：任务 1 已转交，任务 2 仍需处理——对话框明确说任务 2 不会被本次确认放行。
  const rowsA = [fenceRow(1), fenceRow(2, {status: 'needs_action'})]
  let view = panel.render(rowsA)
  const openButton = findButton(view.tree, '确认旧页面已停止')
  assert.equal(openButton.props.disabled, false)
  openButton.props.onClick()
  view = panel.render(rowsA)
  assert.deepEqual(view.dialog.props.notice.confirmTaskIds, [taskId(1)])
  assert.equal(view.dialog.props.drift, '')
  assert.match(textOf(view.dialogTree), /另有 1 个仍需处理的任务不会被本次确认放行/)

  // 15 秒后的轮询：任务 2 被转给其它节点（北京 20:41:54 → 6 秒后 superseded）。
  const rowsB = [fenceRow(1), fenceRow(2)]
  view = panel.render(rowsB)
  assert.ok(view.dialog, 'the dialog stays open across the poll')
  assert.deepEqual(view.dialog.props.notice.confirmTaskIds, [taskId(1)], 'the dialog keeps what the operator saw')
  assert.match(view.dialog.props.drift, /待确认任务有变化，请关闭后重新打开/)
  const dialogTree = panel.tick(view)
  assert.equal(findButton(dialogTree, '确认放行').props.disabled, true, 'submit is disabled once the fence set changed')
  assert.match(textOf(dialogTree), /待确认任务有变化/)

  // 即使绕过禁用直接提交，发出的也只是快照里的任务，确认接口以 agent_stop_fence_changed 拒绝，错误留在对话框里。
  view.dialog.props.onConfirm('')
  await settle()
  assert.deepEqual(panel.sent.map(call => call.expectedTaskIds), [[taskId(1)]])
  view = panel.render(rowsB)
  assert.ok(view.dialog, 'a rejected confirm keeps the dialog open')
  assert.equal(view.dialog.props.error, '该节点的待确认任务已变化，请刷新后重新确认')

  // 关闭后重新打开：拿最新快照，两条都列出、都发送，守卫放行。
  view.dialog.props.onOpenChange(false)
  view = panel.render(rowsB)
  assert.equal(view.dialog, null)
  findButton(view.tree, '确认旧页面已停止').props.onClick()
  view = panel.render(rowsB)
  assert.deepEqual(view.dialog.props.notice.confirmTaskIds, [taskId(1), taskId(2)])
  assert.equal(view.dialog.props.drift, '')
  assert.equal(view.dialog.props.error, '', 'reopening clears the earlier rejection')
  const submit = findButton(panel.tick(view), '确认放行')
  assert.equal(submit.props.disabled, false)
  submit.props.onClick()
  await settle()
  assert.deepEqual(panel.sent.at(-1), {expectedTaskIds: [taskId(1), taskId(2)], note: ''})
  assert.equal(panel.render([]).dialog, null, 'a successful confirm closes the dialog')
})

test('a fence released by the node while the dialog is open keeps the dialog and says so', () => {
  const panel = mountPanel()
  const rows = [fenceRow(1)]
  let view = panel.render(rows)
  findButton(view.tree, '确认旧页面已停止').props.onClick()
  view = panel.render(rows)
  assert.equal(view.dialog.props.drift, '')
  // 节点自动核对通过、围栏解除：/overview 不再有 stop_fence。
  view = panel.render([])
  assert.ok(view.dialog, 'the dialog does not vanish under the operator')
  assert.match(view.dialog.props.drift, /停止保护已解除/)
  assert.equal(findButton(panel.tick(view), '确认放行').props.disabled, true)
  view.dialog.props.onOpenChange(false)
  assert.equal(panel.render([]).dialog, null)
  assert.equal(panel.sent.length, 0)
})

test('a snapshot fence released meanwhile does not block confirming the rest', async () => {
  const panel = mountPanel()
  let view = panel.render([fenceRow(1), fenceRow(2)])
  findButton(view.tree, '确认旧页面已停止').props.onClick()
  view = panel.render([fenceRow(2)])
  assert.equal(view.dialog.props.drift, '')
  const submit = findButton(panel.tick(view), '确认放行')
  assert.equal(submit.props.disabled, false)
  submit.props.onClick()
  await settle()
  assert.deepEqual(panel.sent[0].expectedTaskIds, [taskId(1), taskId(2)])
  assert.equal(panel.render([]).dialog, null, 'the guard accepted the extra id and the dialog closed')
})

test('new node evidence shown while the dialog is open is shown in the dialog and needs a fresh tick', () => {
  // 0.4.16 节点：打开对话框时正在核对、没有待处理页面；随后的轮询带回“旧采集仍在运行”的页面。
  const agent416 = {...baseAgent, app_version: '0.4.16', capabilities: {previousCaptureStopCheckV1: true}}
  const liveAgentWith = rows => ({...agent416,
    stop_fence: summarizeAgentStopFence(agent416, rows, {now: NOW, autoCheckEnabled: true})})
  const checking = {version: 1, checkId: 'c1', round: 1, firstIssuedAt: ago(2), issuedAt: ago(2),
    expiresAt: new Date(NOW + 8 * 60_000).toISOString(), lastOfferedAt: ago(1), failureCount: 0}
  const stillRunning = {...checking, failureCount: 1, nextIssueAt: new Date(NOW + 3 * 60_000).toISOString(),
    lastResult: {checkId: 'c1', at: ago(0), accepted: false, reason: 'capture_still_active', retryable: true,
      pendingTabCount: 1, pendingTabs: [{platform: 'xiaohongshu', evidence: 'capture_still_active', title: '搜索 · 旧关键词'}]}}
  const panelScope = {slots: [], index: 0}
  const dialogScope = {slots: [], index: 0}
  const props = agent => ({agent, writable: true, compact: false, onRecheck: async () => {}, onConfirm: async () => {}})
  const render = rows => {
    const tree = renderWith(panelScope, StopFencePanel, props(liveAgentWith(rows)))
    const dialog = findDialog(tree)
    return {tree, dialog, dialogTree: dialog ? renderWith(dialogScope, ReleaseStopFenceDialog, dialog.props) : null}
  }
  const tick = view => {
    findAll(view.dialogTree, node => node.type === 'input' && node.props.type === 'checkbox')[0]
      .props.onChange({target: {checked: true}})
    return renderWith(dialogScope, ReleaseStopFenceDialog, view.dialog.props)
  }
  const rowsA = [fenceRow(1, {stop_fence_check: checking})]
  const rowsB = [fenceRow(1, {stop_fence_check: stillRunning})]
  let view = render(rowsA)
  assert.equal(liveAgentWith(rowsA).stop_fence.phase, 'node_checking')
  findButton(view.tree, '确认旧页面已停止').props.onClick()
  view = render(rowsA)
  // 先勾选，再来一次轮询。
  let dialogTree = tick(view)
  assert.equal(findButton(dialogTree, '确认放行').props.disabled, false)
  view = render(rowsB)
  assert.equal(view.dialog.props.drift, '', 'the id set did not change')
  assert.deepEqual(view.dialog.props.notice.confirmTaskIds, [taskId(1)], 'the ids still come from the snapshot')
  const text = textOf(view.dialogTree)
  assert.match(text, /搜索 · 旧关键词/, 'the page the node just reported is listed')
  assert.match(text, /已发送停止信号，尚未结束/)
  assert.match(text, /打开此窗口后节点报告了新的待处理页面/)
  assert.match(text, /节点最新状态：第 1 次核对未通过：已向旧采集发送精确停止信号/)
  assert.match(text, /勾选后节点又报告了新的待处理页面，请核对上面的列表后重新勾选/)
  assert.equal(findAll(view.dialogTree, node => node.type === 'input' && node.props.type === 'checkbox')[0].props.checked, false,
    'the earlier tick no longer counts')
  assert.equal(findButton(view.dialogTree, '确认放行').props.disabled, true)
  // 看过之后重新勾选才可提交。
  dialogTree = tick(view)
  assert.equal(findButton(dialogTree, '确认放行').props.disabled, false)
  assert.doesNotMatch(textOf(dialogTree), /勾选后节点又报告了新的待处理页面/)
})

test('a needs_action batch child is explained in the panel and released through the same dialog', async () => {
  // 金星现场：弹性批次子任务停在「需要处理」+ 围栏码，0.4.14 节点，没有已转交围栏。
  const child = fenceRow(7, {status: 'needs_action', parent_task_id: '7a0e0000-0000-4000-8000-000000000009',
    task_type: 'unattended_keyword_capture', title: '小红书~日常巡检 · 檐下秋意',
    parent_state: {status: 'running', distributionMode: 'elastic_pool', operatorStopped: null}})
  const root = fenceRow(8, {status: 'needs_action', title: '本机任务'})
  const panel = mountPanel()
  let view = panel.render([child, root])
  const text = textOf(view.tree)
  assert.match(text, /旧采集页面未确认停止 · 需人工确认/)
  assert.match(text, /节点本机无法继续该任务；检查后点「确认旧页面已停止」，确认后未完成关键词退回任务池，由其它节点接力/)
  assert.match(text, /节点侧栏的「停止」「结束并保留」会放弃这些关键词/)
  assert.match(text, /该任务仍待处理，请在任务或批次里点「继续」或「停止」/, 'the root task keeps its own advice')
  assert.equal(findButton(view.tree, '让节点重新核对').props.disabled, true)
  const open = findButton(view.tree, '确认旧页面已停止')
  assert.equal(open.props.disabled, false)
  open.props.onClick()
  view = panel.render([child, root])
  assert.deepEqual(view.dialog.props.notice.confirmTaskIds, [taskId(7)])
  const dialogText = textOf(view.dialogTree)
  assert.match(dialogText, /待确认任务（1）/)
  assert.match(dialogText, /小红书~日常巡检 · 檐下秋意 · 小红书 · 需要处理 · 预计：退回任务池/)
  assert.match(dialogText, /「需要处理」的批次任务确认后即结束，未完成关键词按上述方式交回批次；节点侧栏里该任务仍显示「需要处理」，不必再点「继续」/)
  assert.match(dialogText, /最稳妥是重启 Chrome/)
  assert.match(dialogText, /另有 1 个仍需处理的任务不会被本次确认放行/)
  const submit = findButton(panel.tick(view), '确认放行')
  assert.equal(submit.props.disabled, false)
  submit.props.onClick()
  await settle()
  assert.deepEqual(panel.sent.at(-1), {expectedTaskIds: [taskId(7)], note: ''})
})
