import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('workspace badges no longer project monitor history into global attention', async () => {
  const workspace = await read('server/routes/workspace.js')

  assert.match(workspace, /monitorAttention: 0/u)
  assert.doesNotMatch(workspace, /AS monitor_attention/u)
  assert.doesNotMatch(workspace, /status <> 'deleted' AND COALESCE\(last_error, ''\) <> ''/u)
})

test('monitor subscription API exposes one actionable failure projection', async () => {
  const route = await read('server/routes/monitor.js')

  assert.match(route, /latest_execution\.status AS latest_execution_status/u)
  assert.match(route, /LEFT JOIN LATERAL[\s\S]*ORDER BY execution\.created_at DESC, execution\.id DESC/u)
  assert.match(route, /latest_execution\.status = 'failed'[\s\S]*AS attention_required/u)
  assert.match(route, /attentionRequired: Boolean\(row\.attention_required\)/u)
  assert.match(route, /latestExecutionError: row\.latest_execution_error/u)
})

test('navigation never turns a historical monitor error into a global badge', async () => {
  const [mobile, sidebar, tasks] = await Promise.all([
    read('web/admin/src/mobile/MobileApp.tsx'),
    read('web/admin/src/components/layout/Sidebar.tsx'),
    read('web/admin/src/pages/monitoring/TasksTab.tsx'),
  ])

  assert.doesNotMatch(mobile, /item\.key === 'monitor' \? badges\.monitorAttention/u)
  assert.doesNotMatch(mobile, /个监测任务需要检查/u)
  assert.match(sidebar, /\{ id: 'monitoring', label: '关注博主', icon: UserCheck \}/u)
  assert.doesNotMatch(sidebar, /label: '关注博主'[^\n]*monitorAttention/u)
  assert.match(tasks, /followedCreatorSubs\.filter\(isAttentionRequired\)/u)
  assert.match(tasks, /subscription\.attentionRequired === true \|\| subscription\.attention_required === true/u)
})
