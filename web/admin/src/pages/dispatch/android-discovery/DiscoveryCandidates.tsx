import {useMemo, useRef, useState} from 'react'
import {ExternalLink, RotateCcw} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {reasonLabel, safeOriginalUrl, statusLabel} from './presentation'
import type {DiscoveryCandidate, DiscoveryEvent} from './types'

export function DiscoveryCandidates({candidates, events, writable, busy, onReprocess}: {
  candidates: DiscoveryCandidate[]; events: DiscoveryEvent[]; writable: boolean; busy: boolean
  onReprocess: (eventIds: string[], requestId: string) => Promise<boolean>
}) {
  const [selected, setSelected] = useState<string[]>([])
  const request = useRef<{key: string; id: string} | null>(null)
  const pending = useMemo(() => events.filter(event => event.resolutionStatus !== 'resolved' || !event.candidateId || event.deliveryMode === 'late_audit'), [events])
  const selectedIds = selected.filter(id => events.some(event => event.eventId === id))
  async function reprocess() {
    if (!selectedIds.length) return
    const key = [...selectedIds].sort().join(',')
    if (request.current?.key !== key) request.current = {key, id: crypto.randomUUID()}
    if (await onReprocess(selectedIds, request.current.id)) { setSelected([]); request.current = null }
  }
  return <section className="space-y-3" aria-label="发现候选内容">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-semibold">发现候选 <span className="ml-1 text-muted-foreground">{candidates.length}</span></h4>
      {writable && <Button size="sm" variant="outline" disabled={busy || !selectedIds.length} onClick={() => { void reprocess() }}>
        <RotateCcw className="h-3.5 w-3.5"/>重新处理 {selectedIds.length || ''}
      </Button>}
    </div>
    <p className="text-xs leading-5 text-muted-foreground">发现与正式入库分别记录。重新处理只处理所选内容，每次最多选择 5 条，保留原任务结果。</p>
    {candidates.length === 0 && <p className="rounded-xl border border-dashed p-5 text-center text-sm text-muted-foreground">尚未确认作品链接</p>}
    <div className="space-y-2">
      {candidates.map(candidate => {
        const source = events.find(event => event.candidateId === candidate.id)
        const url = safeOriginalUrl(candidate.canonicalUrl)
        return <article key={candidate.id} className="rounded-xl border border-border bg-card p-3">
          <div className="flex items-start gap-3">
            {writable && source && <input type="checkbox" aria-label={`选择 ${candidate.titleHint || '作品'}`} checked={selected.includes(source.eventId)} disabled={busy || (!selected.includes(source.eventId) && selectedIds.length >= 5)}
              onChange={event => setSelected(ids => event.target.checked ? [...ids, source.eventId] : ids.filter(id => id !== source.eventId))} className="mt-1 h-4 w-4"/>}
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium">{candidate.titleHint || '作品标题待补充'}</p>
              <p className="mt-1 text-xs text-muted-foreground">{candidate.authorHint || '作者待补充'} · {candidate.keyword}</p>
              <p className="mt-2 text-xs">{candidate.recordId && candidate.recordVisibility !== 'eligible' ? '已有记录，待审核' : statusLabel(candidate.status)}{candidate.demandStatus === 'canceled' ? ' · 本批需求已停止' : ''}</p>
              {candidate.reason && <p className="mt-1 text-xs text-amber-700">{reasonLabel(candidate.reason)}</p>}
            </div>
            {url && <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs text-primary">原帖<ExternalLink className="h-3 w-3"/></a>}
          </div>
        </article>
      })}
    </div>
    {pending.length > 0 && <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-amber-950">
      <h4 className="text-xs font-semibold">链接或交付待核对 · {pending.length}</h4>
      {pending.map(event => <label key={event.eventId} className="flex items-start gap-2 text-xs leading-5">
        {writable && <input type="checkbox" checked={selected.includes(event.eventId)} disabled={busy || (!selected.includes(event.eventId) && selectedIds.length >= 5)} className="mt-1"
          onChange={e => setSelected(ids => e.target.checked ? [...ids, event.eventId] : ids.filter(id => id !== event.eventId))}/>}
        <span>{event.titleHint || event.keyword} · {event.deliveryMode === 'late_audit' ? '迟到证据，保留供核对' : reasonLabel(event.resolutionError) || statusLabel(event.resolutionStatus)}</span>
      </label>)}
    </div>}
  </section>
}
