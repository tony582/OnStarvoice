import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const load = relativePath => readFile(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
)

const [
  creator,
  drawer,
  dispatchPage,
  monitoringTab,
  registrationDrawer,
  monitoringTasksTab,
  taskCard,
  taskLib,
] = await Promise.all([
  load('web/admin/src/pages/dispatch/cloud-tasks/OfficialCommentPatrolTaskCreator.tsx'),
  load('web/admin/src/pages/dispatch/cloud-tasks/CreateTaskDrawer.tsx'),
  load('web/admin/src/pages/dispatch/DispatchPage.tsx'),
  load('web/admin/src/pages/monitoring/OfficialCommentPatrolTab.tsx'),
  load('web/admin/src/pages/monitoring/OfficialAccountRegistrationDrawer.tsx'),
  load('web/admin/src/pages/monitoring/TasksTab.tsx'),
  load('web/admin/src/pages/dispatch/cloud-tasks/TaskCard.tsx'),
  load('web/admin/src/pages/dispatch/cloud-tasks/lib.ts'),
])

test('official comment patrol is created directly from an account homepage', () => {
  assert.match(creator, /\/capture-cloud\/official-comment-patrol\/tasks/u)
  assert.match(creator, /Agent 会打开账号主页，在指定日期范围内读取近期作品并采集当前可见评论/u)
  assert.match(creator, /publishDateFrom/u)
  assert.match(creator, /publishDateTo/u)
  assert.match(creator, /postsLimit/u)
  assert.match(creator, /commentsLimit/u)
  assert.doesNotMatch(creator, /candidates\/preview|recordIds|selectedIds|预览作品/u)
})

test('admin navigation no longer exposes an official discovery task', () => {
  assert.doesNotMatch(drawer, /official_discovery|官方账号作品发现/u)
  assert.doesNotMatch(dispatchPage, /official_discovery/u)
  assert.doesNotMatch(monitoringTab, /official_discovery|createDiscoveryTask|创建作品发现任务|发现近期作品/u)
  assert.doesNotMatch(registrationDrawer, /作品发现/u)
  assert.doesNotMatch(monitoringTasksTab, /作品发现/u)
  assert.doesNotMatch(taskLib, /official_discovery/u)
})

test('legacy official discovery tasks remain readable', () => {
  assert.match(taskCard, /official_account_post_discovery/u)
  assert.match(taskCard, /官方账号作品发现/u)
})
