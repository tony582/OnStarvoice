import { useCallback, useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown, Layers, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { triageLoadError, withTriageReadDeadline } from '@/lib/triage-load'
import { formatDate, platformName } from '@/lib/utils'
import { crossPostSelectedIds, defaultCrossPostSelection, normalizeCrossPostGroup, type CrossPostGroup, type CrossPostMember } from '@/lib/cross-posts'
import { CrossPostPlatformIcon } from './CrossPostBadge'
import { RecordTriageStatus } from './RecordTriageStatus'
import { Button } from '@/components/ui/button'

interface Props {
  record: { id: string; triage_status?: string; archived_at?: string | null }
  canWrite: boolean
  modes: Array<{ value: string; label: string }>
  onOpenRecord: (member: CrossPostMember) => Promise<void>
  onBatchStatus?: (ids: string[], status: string) => Promise<boolean>
  onGroupChanged?: () => Promise<void> | void
  onBusyChange: (busy: boolean) => void
}

export function CrossPostSection({ record, canWrite, modes, onOpenRecord, onBatchStatus, onGroupChanged, onBusyChange }: Props) {
  const [group, setGroup] = useState<CrossPostGroup>({ groupId: null, members: [] })
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef({ sequence: 0, controller: null as AbortController | null })
  const load = useCallback((reset = false) => {
    const pending = request.current
    const seq = ++pending.sequence
    pending.controller?.abort()
    const controller = new AbortController()
    pending.controller = controller
    return withTriageReadDeadline(signal => api.request<CrossPostGroup>(
      `/triage/records/${encodeURIComponent(record.id)}/cross-posts`, { signal },
    ), controller).then(result => {
      if (seq !== pending.sequence) return
      const next = normalizeCrossPostGroup(result)
      setGroup(next)
      setSelected(current => reset ? defaultCrossPostSelection(next.members, record.id) : crossPostSelectedIds(next.members, current))
      setError('')
    }).catch(err => {
      if (seq === pending.sequence) setError(triageLoadError(err))
    }).finally(() => {
      if (seq === pending.sequence) setLoading(false)
    })
  }, [record.id])

  useEffect(() => {
    const pending = request.current
    void load(true)
    return () => { pending.sequence++; pending.controller?.abort() }
  }, [load])

  const refresh = () => {
    setLoading(true)
    return load()
  }

  const members = group.members.map(member => member.id === record.id
    ? { ...member, triage_status: record.triage_status || member.triage_status, archived_at: record.archived_at ?? member.archived_at }
    : member)
  const selectedIds = crossPostSelectedIds(members, selected)
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    onBusyChange(true)
    setError('')
    try { await action() }
    catch (err) { setError(err instanceof Error ? err.message : '操作失败，请重试') }
    finally { setBusy(false); onBusyChange(false) }
  }
  const changeStatus = (status: string) => run(async () => {
    if (!onBatchStatus || !selectedIds.length) return
    if (await onBatchStatus(selectedIds, status)) await refresh()
  })
  const exclude = (member: CrossPostMember) => run(async () => {
    await api.post(`/triage/records/${encodeURIComponent(record.id)}/cross-posts/exclude`, { recordId: member.id })
    await refresh()
    await onGroupChanged?.()
  })

  if (!loading && !error && (!group.groupId || members.length < 2)) return null
  return (
    <section aria-label="其它平台同发" className="mt-3.5 border-t border-border/60 pt-3">
      <h3 className="flex items-center gap-1.5 text-[12px] font-semibold"><Layers className="h-3.5 w-3.5" />其它平台同发</h3>
      <p className="mt-1 text-[11px] text-muted-foreground">处理状态各自独立；只修改勾选的内容。</p>
      {loading && <p role="status" className="mt-2 text-[11px] text-muted-foreground">正在读取同发内容…</p>}
      {error && <div role="alert" className="mt-2 text-[12px] text-destructive">{error}
        <button type="button" disabled={busy || loading} className="ml-2 underline" onClick={() => void refresh()}>重试</button>
      </div>}
      <ul className="mt-2 space-y-1.5">
        {members.map(member => {
          const current = member.id === record.id
          const title = Array.from(member.title || '未提供标题').slice(0, 40).join('')
          return (
            <li key={member.id} className="flex items-start gap-2 rounded-lg bg-muted/40 p-2">
              {canWrite && <input type="checkbox" aria-label={`选择${current ? '当前内容' : title}`}
                checked={selectedIds.includes(member.id)} disabled={busy || loading || Boolean(member.archived_at)}
                onChange={event => setSelected(ids => event.target.checked ? [...new Set([...ids, member.id])] : ids.filter(id => id !== member.id))}
                className="mt-1 h-4 w-4 shrink-0 accent-primary" />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                  <CrossPostPlatformIcon platform={member.platform} /><span>{platformName(member.platform)}</span>
                  <span className="max-w-32 truncate">{member.author || '未知作者'}</span>
                  <span>{formatDate(member.published_at || member.created_at)}</span>
                  <RecordTriageStatus record={member} />
                  {member.archived_at && <span>已归档</span>}
                </div>
                {current ? <p className="mt-1 text-[12px] leading-5">{title}<span className="ml-1.5 text-[10px] text-muted-foreground">当前内容</span></p>
                  : <button type="button" disabled={busy || loading} onClick={() => void run(() => onOpenRecord(member))}
                    className="mt-1 text-left text-[12px] leading-5 text-primary hover:underline disabled:opacity-50">{title}</button>}
                {!current && canWrite && <button type="button" disabled={busy || loading} onClick={() => void exclude(member)}
                  className="mt-1 block text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-50">不是同一内容</button>}
              </div>
            </li>
          )
        })}
      </ul>
      {canWrite && onBatchStatus && members.length >= 2 && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button variant="outline" size="sm" className="mt-2" disabled={!selectedIds.length || busy || loading}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}一起处理（{selectedIds.length}）<ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" sideOffset={5} className="z-[90] min-w-44 rounded-lg border border-border bg-popover p-1.5 shadow-xl">
              {modes.map(mode => <DropdownMenu.Item key={mode.value} onSelect={() => void changeStatus(mode.value)}
                className="cursor-pointer rounded px-2.5 py-2 text-[12px] outline-none data-[highlighted]:bg-accent">{mode.label}</DropdownMenu.Item>)}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </section>
  )
}
