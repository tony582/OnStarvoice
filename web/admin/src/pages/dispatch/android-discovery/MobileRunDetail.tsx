import {Pause, Play} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {DiscoveryCandidates} from './DiscoveryCandidates'
import {canResumeRun, canStopDiscovery, durationLabel, reasonLabel, runResultLabel, statusLabel} from './presentation'
import {RecoveryPanel} from './RecoveryPanel'
import type {DiscoveryRunDetail} from './types'

export function MobileRunDetail({detail, writable, busy, onStop, onResume, onReprocess}: {
  detail: DiscoveryRunDetail; writable: boolean; busy: boolean
  onStop: (scope: 'discovery' | 'batch') => void; onResume: () => void
  onReprocess: (eventIds: string[], requestId: string) => Promise<boolean>
}) {
  const {run, items, candidates, events, recovery} = detail
  const nodeUnavailable = recovery?.resumeError === 'MOBILE_AGENT_NOT_FOUND'
  return <div className="space-y-5">
    <header>
      <p className="text-xs font-medium text-primary">手机发现</p>
      <h3 className="mt-1 text-lg font-bold">{run.title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{run.stopRequested && canStopDiscovery(run.status) ? '正在停止，等待执行端确认' : runResultLabel(detail)}</p>
    </header>
    <div className="grid grid-cols-2 gap-3">
      <div className="rounded-xl bg-muted/40 p-3"><p className="text-xs text-muted-foreground">关键词发现</p>
        <p className="mt-1 text-xl font-semibold tabular-nums">{run.progress.completed}<span className="text-sm text-muted-foreground"> / {run.progress.total}</span></p></div>
      <div className="rounded-xl bg-muted/40 p-3"><p className="text-xs text-muted-foreground">已有正式记录</p>
        <p className="mt-1 text-xl font-semibold tabular-nums">{candidates.filter(candidate => candidate.recordId && candidate.recordVisibility === 'eligible').length}<span className="text-sm text-muted-foreground"> / {candidates.length} 个候选</span></p></div>
    </div>
    {recovery && <RecoveryPanel recovery={recovery}/>}
    {writable && <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy || nodeUnavailable || !canStopDiscovery(run.status) || run.stopRequested} onClick={() => onStop('discovery')}><Pause className="h-3.5 w-3.5"/>停止手机发现</Button>
      <Button size="sm" variant="outline" disabled={busy || nodeUnavailable || (run.stopRequested && run.stopScope === 'batch')} onClick={() => onStop('batch')}>停止整批采集</Button>
      {canResumeRun(run.status) && <Button size="sm" disabled={busy || run.stopRequested || !recovery?.canResume} onClick={onResume}><Play className="h-3.5 w-3.5"/>{recovery?.canResume && !recovery.deviceReady ? '排队恢复' : '恢复发现'}</Button>}
    </div>}
    {!recovery && canResumeRun(run.status) && <p role="status" className="text-xs text-amber-700">恢复检查尚未返回，请刷新后再试。</p>}
    <p className="text-xs leading-5 text-muted-foreground">停止手机发现后，已找到的内容可继续补详情；停止整批会同时撤销本批的详情需求。</p>
    <ul className="space-y-2 text-xs" aria-label="关键词执行状态">
      {items.map(item => <li key={item.id} className="flex flex-wrap justify-between gap-2 rounded-lg border border-border px-3 py-2">
        <span className="font-medium">{item.keyword}</span><span>{statusLabel(item.status)}</span>
        {item.stats && <p className="w-full text-muted-foreground">最近回执：{item.stats.links ?? '—'} 个作品 · {item.stats.cards ?? '—'} 张卡片
          {item.stats.keywordElapsedMs !== undefined && ` · 关键词耗时 ${durationLabel(item.stats.keywordElapsedMs)}`}
          {(item.attemptCount || 0) > 1 && ` · 第 ${item.attemptCount} 次执行`}</p>}
        {item.reason && <p className="w-full text-muted-foreground">{reasonLabel(item.reason)}</p>}
      </li>)}
    </ul>
    <DiscoveryCandidates key={run.id} candidates={candidates} events={events} writable={writable} busy={busy} onReprocess={onReprocess}/>
  </div>
}
