import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronRight, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CloudAgent } from './lib'
import { isMobileAgent } from './lib'
import type { StopFenceNotice } from './stop-fence-presentation.mjs'
import {
  agentStopFenceNotice,
  formatStopFenceTime,
  stopFenceConfirmDrift,
  stopFencePendingTabKey,
  stopFencePlatformLabel,
  stopFenceReasonLabel,
  stopFenceTaskStatusLabel,
} from './stop-fence-presentation.mjs'

// 停止保护面板：节点因“旧采集页面未能安全停止”暂停接单时，说明原因、核对进度和需要谁做什么。
// 阶段一律取服务端 /overview 的 stop_fence.phase；这里只负责展示和两个后台操作入口。
// 本文件只导出组件（react-refresh），纯函数在 stop-fence-presentation.mjs。

const CONFIRMATION_TEXT = '确认旧页面已停止'

export function StopFencePanel({
  agent,
  writable,
  compact,
  busy = false,
  onRecheck,
  onConfirm,
  onOpenOrchestration,
}: {
  agent: CloudAgent
  writable: boolean
  compact: boolean
  busy?: boolean
  onRecheck: (agent: CloudAgent) => Promise<void>
  onConfirm: (agent: CloudAgent, expectedTaskIds: string[], note: string) => Promise<void>
  onOpenOrchestration?: (orchestrationId: string) => void
}) {
  // 确认对话框打开那一刻的 notice。对话框只展示、只提交这份快照：/overview 每 15 秒刷新，
  // 若直接用最新一次，运营没看到的新围栏会被一并放行，确认接口的 agent_stop_fence_changed 也就拦不住。
  const [confirmSnapshot, setConfirmSnapshot] = useState<StopFenceNotice | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState('')
  const [rechecking, setRechecking] = useState(false)
  const [recheckError, setRecheckError] = useState('')
  const notice = agentStopFenceNotice(agent)
  const confirmDrift = stopFenceConfirmDrift(confirmSnapshot, notice)

  const confirm = async (note: string) => {
    if (!confirmSnapshot) return
    setConfirmError('')
    setConfirming(true)
    try {
      // 带上快照里该节点全部已转交围栏（含没列出的）；之后新出现的由服务端以「待确认任务已变化」拒绝。
      await onConfirm(agent, confirmSnapshot.confirmTaskIds, note)
      setConfirmSnapshot(null)
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : '确认旧页面已停止失败')
    } finally {
      setConfirming(false)
    }
  }

  // 围栏在对话框打开期间解除时，对话框仍按快照留着并提示已变化，不会在运营眼前突然消失。
  // 要确认的任务取快照；节点最新的核对结果（待处理页面、说明）取最新一次轮询，不能被快照盖住。
  const releaseDialog = confirmSnapshot ? (
    <ReleaseStopFenceDialog
      agent={agent}
      notice={confirmSnapshot}
      live={notice}
      drift={confirmDrift}
      confirming={confirming}
      error={confirmError}
      onOpenChange={open => {
        if (confirming || open) return
        setConfirmSnapshot(null)
        setConfirmError('')
      }}
      onConfirm={note => void confirm(note)}
    />
  ) : null

  if (!notice) return releaseDialog

  // 已人工确认、只等节点释放本机锁：围栏已解除，只留一行说明（释放完成前服务端暂不派新采集时 guidance 会写明）。
  if (!notice.blocking) {
    return (
      <>
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-border/70 bg-muted/30 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-green" />
          <span>{notice.headline}（{notice.guidance}）{notice.detail ? `：${notice.detail}` : ''}</span>
        </div>
        {releaseDialog}
      </>
    )
  }

  const mobileAgent = isMobileAgent(agent)
  const actionBusy = busy || rechecking || confirming
  const totalTaskCount = Number(agent.stop_fence?.task_count || 0)
  const listedTaskCount = notice.supersededTasks.length + notice.actionTasks.length
  const tone = notice.urgent
    ? 'border-status-red/30 bg-status-red/[0.05] text-status-red'
    : 'border-status-orange/30 bg-status-orange/[0.06] text-amber-700 dark:text-amber-300'

  const recheck = async () => {
    setRecheckError('')
    setRechecking(true)
    try {
      await onRecheck(agent)
    } catch (err) {
      setRecheckError(err instanceof Error ? err.message : '请求节点重新核对失败')
    } finally {
      setRechecking(false)
    }
  }

  return (
    <section role="alert" aria-label="旧采集页面未确认停止" className={`mt-3 rounded-xl border px-3.5 py-3 ${tone}`}>
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-bold">{notice.headline}</h3>
          {(notice.sinceLabel || notice.elapsedLabel) && (
            <p className="mt-0.5 text-[11px] opacity-80">
              {notice.sinceLabel ? `自 ${notice.sinceLabel} 起暂停接单` : '暂停接单'}{notice.elapsedLabel ? ` · ${notice.elapsedLabel}` : ''}
            </p>
          )}
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-5 text-foreground">
        {notice.supersededCount > 0
          ? '关键词已转给其它节点。为防止同一浏览器里两条采集同时运行，在确认旧采集页面已停止前，暂不向该节点派发新任务。'
          : '该节点的旧任务仍待处理，旧采集页面尚未确认停止。为防止同一浏览器里两条采集同时运行，暂不向该节点派发新任务。'}
      </p>
      {notice.detail && <p className="mt-1.5 text-[11px] font-medium leading-5">{notice.detail}</p>}
      {notice.guidance && notice.phase !== 'manual_only' && <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{notice.guidance}</p>}

      {notice.pendingTabs.length > 0 && (
        <div className="mt-2 rounded-lg border border-border/60 bg-background/70 px-2.5 py-2">
          <p className="text-[11px] font-semibold text-foreground">待处理页面（最近一次核对）</p>
          <ul className="mt-1 space-y-0.5 text-[11px] leading-4 text-muted-foreground">
            {notice.pendingTabs.map(tab => (
              <li key={`${tab.platform}:${tab.evidence}:${tab.title}`} className="break-words">
                · {tab.platformLabel} · {tab.title}{tab.reason ? ` · ${tab.reason}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="mt-2 space-y-1.5">
        {[...notice.supersededTasks, ...notice.actionTasks].map(task => {
          const lastResult = task.check?.last_result || null
          const failureCount = Number(task.check?.failure_count || 0)
          const resultLabel = lastResult
            ? stopFenceReasonLabel(lastResult.reason) || lastResult.message || ''
            : task.check?.issued_at ? '已请求节点核对，等待返回结果' : ''
          const fencedAt = formatStopFenceTime(task.fenced_at)
          return (
            <li key={task.id} className="rounded-lg border border-border/60 bg-background/70 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-semibold text-foreground">{task.title || '采集任务'}</span>
                <span className="shrink-0">{stopFenceTaskStatusLabel(task.status)}</span>
              </div>
              <p className="mt-0.5">
                {stopFencePlatformLabel(task.platform)}{fencedAt ? ` · 自 ${fencedAt}` : ''}
                {task.status === 'superseded' && task.auto_checkable === false ? ' · 无法定位节点本机记录，需人工确认' : ''}
              </p>
              {task.status !== 'superseded' ? (
                <p className="mt-0.5 text-status-red">该任务仍待处理，请在任务或批次里点「继续」或「停止」（停止即放弃该任务）；停止或接力后本节点即可继续接单或进入自动核对。</p>
              ) : resultLabel ? (
                <p className="mt-0.5">节点核对：{resultLabel}{failureCount > 0 && lastResult?.accepted !== true ? `（已 ${failureCount} 次未通过）` : ''}</p>
              ) : null}
              {task.parent_task_id && onOpenOrchestration && (
                <button type="button" onClick={() => onOpenOrchestration(String(task.parent_task_id))}
                  className="mt-1 inline-flex items-center gap-0.5 font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                  查看批次 <ChevronRight className="h-3 w-3" />
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {totalTaskCount > listedTaskCount && listedTaskCount > 0 && (
        <p className="mt-1 text-[10px] text-muted-foreground">仅列出前 {listedTaskCount} 个，共 {totalTaskCount} 个任务。</p>
      )}

      {!mobileAgent && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span title={!writable ? '当前账号为只读权限' : notice.recheckHint || undefined}>
            <Button variant="outline" size="sm" onClick={() => void recheck()}
              disabled={!writable || !notice.canRecheck || actionBusy}
              className={compact ? 'min-h-11' : 'min-h-9'}>
              {rechecking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {notice.recheckLabel}
            </Button>
          </span>
          <span title={!writable ? '当前账号为只读权限' : notice.confirmHint || undefined}>
            <Button size="sm" onClick={() => {
              setConfirmError('')
              setConfirmSnapshot(notice)
            }}
              disabled={!writable || !notice.canConfirm || actionBusy}
              className={compact ? 'min-h-11' : 'min-h-9'}>
              <ShieldCheck className="h-3.5 w-3.5" /> 确认旧页面已停止
            </Button>
          </span>
        </div>
      )}
      {recheckError && <p role="alert" className="mt-2 text-[11px] leading-4 text-status-red">{recheckError}</p>}
      {!mobileAgent && notice.confirmHint && <p className="mt-2 text-[11px] leading-4 text-status-red">{notice.confirmHint}</p>}
      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
        「分配任务」仍可用：分配后会排队，确认旧页面已停止后执行。值守告警只在值守窗口内发出，窗口外以此处为准。
      </p>

      {releaseDialog}
    </section>
  )
}

export function ReleaseStopFenceDialog({
  agent,
  notice,
  live = null,
  drift,
  confirming,
  error,
  onOpenChange,
  onConfirm,
}: {
  agent: CloudAgent | null
  /** 打开时的快照；待确认任务和提交的 id 都取它。 */
  notice: StopFenceNotice
  /** 最新一次轮询的 notice；节点的最新核对结果（说明、待处理页面）取它。 */
  live?: StopFenceNotice | null
  /** 快照之后的变化说明（stopFenceConfirmDrift），非空时禁止提交。 */
  drift: string
  confirming: boolean
  error: string
  onOpenChange: (open: boolean) => void
  onConfirm: (note: string) => void
}) {
  // 勾选时记下当时看到的待处理页面；之后节点又报告了新的页面（例如旧采集仍在运行），勾选自动失效，需看过后重新勾选。
  const [checkedTabKeys, setCheckedTabKeys] = useState<string[] | null>(null)
  const [note, setNote] = useState('')
  const evidence = live && live.blocking ? live : notice
  const tabKeys = evidence.pendingTabs.map(stopFencePendingTabKey)
  const snapshotTabKeys = new Set(notice.pendingTabs.map(stopFencePendingTabKey))
  const newSinceOpen = tabKeys.some(key => !snapshotTabKeys.has(key))
  const newSinceChecked = checkedTabKeys !== null && tabKeys.some(key => !checkedTabKeys.includes(key))
  const checked = checkedTabKeys !== null && !newSinceChecked

  return (
    <Dialog.Root open={Boolean(agent)} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/35 backdrop-blur-[1px] data-[state=closed]:animate-out data-[state=open]:animate-in" />
        <Dialog.Content aria-describedby="release-stop-fence-description"
          className="fixed left-1/2 top-1/2 z-[91] max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl outline-none">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-status-orange/10 text-amber-700 dark:text-amber-300">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <Dialog.Title className="text-base font-bold text-foreground">{CONFIRMATION_TEXT}</Dialog.Title>
              <Dialog.Description id="release-stop-fence-description" className="mt-1 text-xs leading-5 text-muted-foreground">
                人工确认后，系统解除该节点的停止保护并恢复派发任务。
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-border/70 bg-muted/30 px-3.5 py-3">
            <p className="truncate text-sm font-semibold text-foreground">{agent?.display_name || '未命名节点'}</p>
            {evidence.detail && <p className="mt-1 text-[11px] leading-5 text-muted-foreground">节点最新状态：{evidence.detail}</p>}
            <p className="mt-2 text-[11px] font-semibold text-foreground">待确认任务（{notice.supersededCount}）</p>
            <ul className="mt-1 space-y-0.5 text-[11px] leading-5 text-muted-foreground">
              {notice.supersededTasks.map(task => (
                <li key={task.id} className="truncate">
                  · {task.title || '采集任务'} · {stopFencePlatformLabel(task.platform)}{task.fenced_at ? ` · 自 ${formatStopFenceTime(task.fenced_at)}` : ''}
                </li>
              ))}
            </ul>
            {notice.unlistedSupersededCount > 0 && (
              <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
                {notice.supersededTasks.length > 0 ? `仅列出 ${notice.supersededTasks.length} 个；` : ''}共 {notice.supersededCount} 个已转交任务，本次确认一并放行。
              </p>
            )}
            {evidence.pendingTabs.length > 0 && (
              <>
                <p className="mt-2 text-[11px] font-semibold text-foreground">最近一次核对列出的待处理页面</p>
                {newSinceOpen && (
                  <p role="alert" className="mt-0.5 text-[11px] leading-5 text-status-red">打开此窗口后节点报告了新的待处理页面，请先到该电脑处理后再确认。</p>
                )}
                <ul className="mt-1 space-y-0.5 text-[11px] leading-5 text-muted-foreground">
                  {evidence.pendingTabs.map(tab => (
                    <li key={`${tab.platform}:${tab.evidence}:${tab.title}`} className="break-words">
                      · {tab.platformLabel} · {tab.title}{tab.reason ? ` · ${tab.reason}` : ''}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {notice.actionTasks.length > 0 && (
              <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                另有 {notice.actionTasks.length} 个仍需处理的任务不会被本次确认放行，请在任务上点「继续」或「停止」。
              </p>
            )}
          </div>

          <div role="alert" className="mt-3 rounded-xl border border-status-orange/25 bg-status-orange/8 px-3.5 py-3 text-[11px] leading-5 text-amber-700 dark:text-amber-300">
            <ul className="space-y-1">
              <li>· 请先到这台电脑检查：没有仍在自动搜索或滚动的小红书、抖音、微博采集页（可直接关闭或刷新，最稳妥是重启 Chrome）。</li>
              <li>· 确认后系统立即恢复向该节点派发任务；如果旧页面仍在运行，同一浏览器里会有两条采集同时操作同一账号，可能触发平台风控。</li>
              <li>· 操作人和时间会记入任务事件与审计日志。</li>
            </ul>
          </div>

          <label className="mt-4 flex items-start gap-2 text-xs font-semibold text-foreground">
            <input type="checkbox" checked={checked} onChange={event => setCheckedTabKeys(event.target.checked ? tabKeys : null)} disabled={confirming}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
            我已在该电脑检查，旧采集页面已停止或已关闭
          </label>
          {newSinceChecked && (
            <p role="alert" className="mt-1.5 text-[11px] leading-5 text-status-red">勾选后节点又报告了新的待处理页面，请核对上面的列表后重新勾选。</p>
          )}
          <label className="mt-3 block text-xs font-medium text-muted-foreground">
            备注（可选）
            <textarea value={note} onChange={event => setNote(event.target.value.slice(0, 200))} disabled={confirming}
              rows={2} maxLength={200} placeholder="例如：已重启 Chrome"
              className="mt-1.5 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-55" />
          </label>
          {drift && <p role="alert" className="mt-3 rounded-xl bg-destructive/8 px-3.5 py-2.5 text-[11px] leading-5 text-destructive">{drift}</p>}
          {error && <p role="alert" className="mt-3 rounded-xl bg-destructive/8 px-3.5 py-2.5 text-[11px] leading-5 text-destructive">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="outline" size="sm" disabled={confirming}>取消</Button>
            </Dialog.Close>
            <Button size="sm" onClick={() => onConfirm(note.trim())}
              disabled={confirming || !checked || !notice.canConfirm || Boolean(drift)}>
              {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              确认放行
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
