import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('admin task diagnostics retain the plan total and identify task-level platform safety blocks', async () => {
  const source = await read('web/admin/src/pages/dispatch/cloud-tasks/lib.ts')

  assert.match(source, /export function isPlatformSafetyAttention\(task: CloudTask\)/u)
  assert.match(source, /error\.platformSafetyBlocked/u)
  assert.match(source, /PLATFORM_SAFETY_EVIDENCE_PATTERN/u)
  assert.match(
    source,
    /const keywordTotal = Math\.max\(items\.length, progress\.total, safeNumber\(counts\.total\)\)/u,
  )
  assert.match(
    source,
    /Number\.isFinite\(checkpointKeywordIndex\)[\s\S]*Math\.floor\(checkpointKeywordIndex\)\) \+ 1/u,
  )
  assert.match(source, /抖音页面要求完成人工安全验证/u)
  assert.match(source, /等待人工安全验证/u)
})

test('admin attention card names the original Agent and exposes explicit human resolution actions', async () => {
  const [card, diagnostics, page, orchestration, composer, navigation, admin] = await Promise.all([
    read('web/admin/src/pages/dispatch/cloud-tasks/TaskCard.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/TaskDiagnostics.tsx'),
    read('web/admin/src/pages/dispatch/DispatchPage.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/OrchestrationDetailWorkspace.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/OrchestrationComposerDrawer.tsx'),
    read('web/admin/src/lib/navigation.tsx'),
    read('web/admin/src/pages/AdminPages.tsx'),
  ])

  assert.match(card, /需要在原 Agent 人工处理/u)
  assert.match(card, /task\.agent_display_name \|\| '原 Agent'/u)
  assert.match(card, /验证完成，原设备继续/u)
  assert.match(card, /结束并保留结果/u)
  assert.match(card, /此前结果已保留/u)
  assert.match(diagnostics, /latestResultByIndex\.get\(index\) \|\| null/u)
  assert.match(diagnostics, /中断位置/u)
  assert.match(page, /后续关键词将不再执行，已经采集和保存的结果会保留/u)
  assert.match(page, /mode: 'remaining'/u)
  assert.match(page, /availableAgents=\{overview\?\.agents \|\| \[\]\}/u)
  assert.match(page, /params\?\.view === 'attention'/u)
  assert.match(page, /params\?\.orchestrationId/u)
  assert.match(orchestration, /验证码和安全审核不会自动换设备/u)
  assert.match(orchestration, /验证完成，原 Agent 继续/u)
  assert.match(orchestration, /结束并保留/u)
  assert.match(orchestration, /转交后续 \{attentionContext\.unstartedCount\} 个词/u)
  assert.match(orchestration, /sourceExecutionTaskId: attentionContext\.sourceTaskId/u)
  assert.match(orchestration, /targetAgentId/u)
  assert.match(orchestration, /crypto\.randomUUID\(\)/u)
  assert.match(
    orchestration,
    /candidate\.status === 'needs_action' &&[\s\S]*safetyDiagnostic\(candidate\.error\)/u,
  )
  assert.match(
    orchestration,
    /safetyDiagnostic\(candidate\.checkpoint\)[\s\S]*if \(status === 'needs_action'\) return true/u,
  )
  assert.match(orchestration, /metadata\.handoffSuccessorTaskId \|\| metadata\.recoveryTaskId/u)
  assert.match(orchestration, /executionStatus\(execution\) === 'superseded'/u)
  assert.match(orchestration, /HANDOFF_UNSTARTED_EXCLUDED_STATUSES/u)
  assert.match(orchestration, /原 Agent 已结束，可接力后续关键词/u)
  assert.match(composer, /允许空闲 Agent 接力/u)
  assert.match(composer, /allowIdleAgentHandoff/u)
  assert.match(composer, /验证码和安全审核不会自动换设备/u)
  assert.match(navigation, /new URLSearchParams\(window\.location\.search\)/u)
  assert.match(navigation, /publicLinkParams\.delete\('page'\)/u)
  assert.match(admin, /任务需人工介入通知邮箱/u)
  assert.match(admin, /settings\.capture_attention_email_to/u)
})

test('saving an attention recipient cannot overwrite a masked SMTP password', async () => {
  const [admin, route] = await Promise.all([
    read('web/admin/src/pages/AdminPages.tsx'),
    read('server/routes/admin.js'),
  ])

  assert.match(admin, /const smtpPass = settings\.smtp_pass/u)
  assert.match(
    admin,
    /if \(smtpPass && smtpPass !== '\*\*\*'\) body\.smtp_pass = smtpPass/u,
  )
  assert.match(
    route,
    /if \(settings\.smtp_pass === '\*\*\*'\) delete settings\.smtp_pass/u,
  )
})
