import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('mobile monitor is a compact directory with one dispatch entry', async () => {
  const mobile = await read('web/admin/src/mobile/MobileApp.tsx')
  const monitorHub = mobile.slice(mobile.indexOf('function MonitorHub'), mobile.indexOf('function InsightsHub'))

  assert.match(monitorHub, /任务与设备[\s\S]*调度中心/u)
  assert.doesNotMatch(monitorHub, /BETA/u)
  assert.match(mobile, /title="Agent 今日运行"/u)
  assert.match(mobile, /title="关注博主"[\s\S]*页内查看博主新动态/u)
  assert.match(mobile, /title="风险事件"/u)
  assert.doesNotMatch(mobile, /function MonitorCard/u)
  assert.doesNotMatch(mobile, /title="关注对象的新内容"/u)
})

test('mobile navigation does not decorate dispatch or opinion analysis as preview features', async () => {
  const mobile = await read('web/admin/src/mobile/MobileApp.tsx')
  const insightsHub = mobile.slice(mobile.indexOf('function InsightsHub'), mobile.indexOf('function MoreHub'))

  assert.match(insightsHub, />舆情剖析</u)
  assert.doesNotMatch(insightsHub, /舆情剖析[\s\S]{0,300}>NEW</u)
  assert.doesNotMatch(mobile, /pageId === 'dispatch'[^\n]*>BETA</u)
})

test('mobile dispatch separates task and device workspaces explicitly', async () => {
  const [mobile, dispatch] = await Promise.all([
    read('web/admin/src/mobile/MobileApp.tsx'),
    read('web/admin/src/pages/dispatch/DispatchPage.tsx'),
  ])

  assert.match(mobile, /<DispatchPage surface="mobile" \/>/u)
  assert.match(dispatch, /surface = 'desktop'[\s\S]*surface\?: 'desktop' \| 'mobile'/u)
  assert.match(dispatch, /useState<'tasks' \| 'agents'>\('tasks'\)/u)
  assert.match(dispatch, /aria-label="调度工作区"/u)
  assert.match(dispatch, /mobileWorkspace !== 'tasks' \? 'hidden '/u)
  assert.match(dispatch, /mobileWorkspace !== 'agents' \? 'hidden '/u)
  assert.match(dispatch, /<AgentRail[\s\S]*surface=\{surface\}/u)
  assert.match(dispatch, /const focusMobileTaskView = useCallback[\s\S]*setMobileWorkspace\('tasks'\)[\s\S]*setTaskView\(view\)[\s\S]*scrollTo\(\{ top: 0 \}\)/u)
  assert.match(dispatch, /createdTaskType === 'unattended_plan'[\s\S]*focusMobileTaskView\(createdTaskType === 'unattended_plan' \? 'plans' : 'active'\)/u)
  assert.match(dispatch, /onDispatched=\{async result => \{[\s\S]*focusMobileTaskView\(result\.schedule \? 'plans' : 'active'\)/u)
})

test('mobile task and agent cards keep platform and assignment readable', async () => {
  const [taskCard, agentRail, history] = await Promise.all([
    read('web/admin/src/pages/dispatch/cloud-tasks/TaskCard.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/AgentRail.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/HistoryView.tsx'),
  ])

  assert.match(taskCard, /surface\?: 'desktop' \| 'mobile'/u)
  assert.match(taskCard, /等待兼容 Agent 分配/u)
  assert.match(taskCard, /task\.agent_host_label \|\| '未分配设备'/u)
  assert.match(taskCard, /PLATFORM_LABELS\[task\.platform\]/u)
  assert.match(taskCard, /const mobilePrimaryAction = orchestration/u)
  assert.match(taskCard, /const hasMobileSecondaryActions =/u)
  assert.match(taskCard, /resumable && !commandPending && mobilePrimaryAction !== 'resume'/u)
  assert.match(taskCard, /其他操作/u)
  assert.match(agentRail, /const compact = surface === 'mobile'/u)
  assert.match(agentRail, /compact=\{compact\}/u)
  assert.match(agentRail, /compact \? 'h-11 w-11'/u)
  assert.match(agentRail, /compact \? 'mr-1 h-11 w-11' : 'mr-2 h-8 w-8'/u)
  assert.match(history, /<TaskCard[\s\S]*surface=\{surface\}/u)
})
