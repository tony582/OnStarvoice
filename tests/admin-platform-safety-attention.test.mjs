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

test('admin waits visibly, retries one safety challenge across Agents, and escalates repeated safety blocks', async () => {
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
  assert.match(card, /验证已完成，继续本设备/u)
  assert.match(card, /停止本设备任务（保留结果）/u)
  assert.match(card, /此前结果已保留/u)
  assert.match(card, /其他未开始关键词由系统自动分配/u)
  assert.match(diagnostics, /latestResultByIndex\.get\(index\) \|\| null/u)
  assert.match(diagnostics, /中断位置/u)
  assert.match(page, /后续关键词将不再执行，已经采集和保存的结果会保留/u)
  assert.match(page, /mode: 'remaining'/u)
  assert.match(page, /availableAgents=\{operationalAgents\}/u)
  assert.match(
    page,
    /operationalAgents[\s\S]*agent\.status === 'active' \|\| agent\.status === 'paused'/u,
  )
  assert.match(page, /params\?\.view === 'attention'/u)
  assert.match(page, /params\?\.orchestrationId/u)
  assert.match(orchestration, /系统已经先做过原 Agent 分散重试，并尝试换一个账号复核/u)
  assert.match(orchestration, /login\[_ -\]\?required/u)
  assert.match(orchestration, /requiresManualAction/u)
  assert.match(orchestration, /验证完成，当前 Agent 继续/u)
  assert.match(orchestration, /已完成验证，更新账号状态/u)
  assert.match(orchestration, /停止这台 Agent（保留结果）/u)
  assert.match(orchestration, /系统正在按词分配后续/u)
  assert.match(orchestration, /其他未开始关键词仍会自动分配/u)
  assert.match(orchestration, /自动恢复实时状态/u)
  assert.match(orchestration, /恢复阻塞实时状态/u)
  assert.match(orchestration, /formatRecoveryCountdown/u)
  assert.match(orchestration, /formatAgentCooldownCountdown/u)
  assert.match(orchestration, /工作项已释放 · 换 Agent/u)
  assert.match(orchestration, /其他空闲 Agent 可立即领取/u)
  assert.match(orchestration, /仅隔离/u)
  assert.match(orchestration, /原账号可继续领取其他关键词/u)
  assert.match(orchestration, /原 Agent 已返回平台首页/u)
  assert.match(orchestration, /原 Agent 返回平台首页未确认/u)
  assert.match(orchestration, /waitingForSourceClosure/u)
  assert.match(orchestration, /等待原 Agent 关闭确认/u)
  assert.match(orchestration, /本地关闭证明/u)
  assert.match(orchestration, /recovery\.sourceAgentHoldUntil/u)
  assert.match(orchestration, /window\.setInterval\(refreshWhenVisible, 5_000\)/u)
  assert.doesNotMatch(orchestration, /handoffAttentionSource/u)
  assert.doesNotMatch(orchestration, /sourceExecutionTaskId: attentionContext\.sourceTaskId/u)
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
  assert.match(orchestration, /当前 Agent 已结束，后续关键词由系统自动接力/u)
  assert.match(composer, /离线不会拖住整批任务/u)
  assert.match(composer, /allowIdleAgentHandoff/u)
  assert.match(composer, /验证码或登录验证只暂停当前关键词/u)
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
