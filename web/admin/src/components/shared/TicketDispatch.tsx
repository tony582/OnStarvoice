import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { WorkbenchSelect } from '@/components/shared/Workbench'
import { useAuth } from '@/lib/auth'

export interface DispatchResult { externalTicketNo: string; priority: string; assigneeUserId: string; assigneeName: string; note: string }
interface AskOptions { title?: string; summary?: string; defaultPriority?: string; sourceType?: 'content' | 'comment' }
interface DispatchState extends AskOptions { resolve: (v: DispatchResult | null) => void }
interface Assignee { userId: string; name: string; email: string; role: string }

const PRIORITIES = [
  { value: 'urgent', label: '紧急' },
  { value: 'high', label: '高' },
  { value: 'normal', label: '普通' },
  { value: 'low', label: '低' },
]

/**
 * 转工单弹窗(分诊侧):选优先级、从本租户成员里下拉指派客服、写转单说明。
 * 用法:const { dispatch, dialog } = useTicketDispatch(); const r = await dispatch({summary}); if(r){...}
 */
export function useTicketDispatch() {
  const [state, setState] = useState<DispatchState | null>(null)

  const dispatch = useCallback((opts: AskOptions = {}) => {
    return new Promise<DispatchResult | null>((resolve) => setState({ ...opts, resolve }))
  }, [])

  const close = useCallback((value: DispatchResult | null) => {
    setState((cur) => { cur?.resolve(value); return null })
  }, [])

  const dialog = state ? <DispatchModal state={state} onCancel={() => close(null)} onConfirm={(v) => close(v)} /> : null
  return { dispatch, dialog }
}

function DispatchModal({ state, onCancel, onConfirm }: { state: DispatchState; onCancel: () => void; onConfirm: (v: DispatchResult) => void }) {
  const { user } = useAuth()
  const [priority, setPriority] = useState(state.defaultPriority || 'normal')
  const [assigneeUserId, setAssigneeUserId] = useState(user?.id || '')
  const [assignees, setAssignees] = useState<Assignee[]>([])
  const [externalTicketNo, setExternalTicketNo] = useState('')
  const [note, setNote] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    api.get<{ items: Assignee[] }>('/tickets/assignees')
      .then(d => { if (alive) setAssignees(d.items || []) })
      .catch(() => { if (alive) setAssignees([]) })
    return () => { alive = false }
  }, [])

  const submit = () => {
    const name = assigneeUserId === user?.id
      ? (user?.name || '本人')
      : (assignees.find(a => a.userId === assigneeUserId)?.name || '')
    onConfirm({ externalTicketNo: externalTicketNo.trim(), priority, assigneeUserId, assigneeName: name, note })
  }

  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 30)
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
    }
    window.addEventListener('keydown', h)
    return () => { clearTimeout(t); window.removeEventListener('keydown', h) }
  }, [externalTicketNo, priority, assigneeUserId, note, assignees]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4 animate-in fade-in duration-150" onMouseDown={onCancel}>
      <div role="dialog" aria-modal="true" aria-labelledby="ticket-dispatch-title" className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-xl sm:p-5 animate-in zoom-in-95 duration-150" onMouseDown={e => e.stopPropagation()}>
        <h3 id="ticket-dispatch-title" className="text-sm font-bold">{state.title || '转工单'}</h3>
        {state.summary && (
          <div className="mt-3 line-clamp-2 rounded-lg bg-muted/60 px-3 py-2 text-[12px] leading-5 text-muted-foreground">{state.summary}</div>
        )}

        <label htmlFor="ticket-dispatch-number" className="mt-4 block text-[12px] font-semibold text-foreground">工单号码（选填）</label>
        <input
          id="ticket-dispatch-number"
          ref={ref}
          value={externalTicketNo}
          maxLength={100}
          onChange={event => setExternalTicketNo(event.target.value)}
          placeholder="填写客户 Excel 中的工单号"
          className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-3 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary focus:ring-2 focus:ring-primary/10"
        />
        <label className="mt-4 block text-[12px] font-semibold text-foreground">优先级</label>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {PRIORITIES.map(p => (
            <button key={p.value} type="button" onClick={() => setPriority(p.value)}
              className={`rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${priority === p.value ? 'bg-accent text-primary' : 'text-muted-foreground hover:bg-muted'}`}>
              {p.label}
            </button>
          ))}
        </div>

        <label htmlFor="ticket-dispatch-assignee" className="mt-4 block text-[12px] font-semibold text-foreground">处理人</label>
        <WorkbenchSelect id="ticket-dispatch-assignee" value={assigneeUserId} onChange={e => setAssigneeUserId(e.target.value)} className="mt-1.5 h-9 w-full border border-border bg-background">
          <option value={user?.id || ''}>本人跟进{user?.name ? ` · ${user.name}` : ''}</option>
          {assignees.filter(a => a.userId !== user?.id).map(a => <option key={a.userId} value={a.userId}>{a.name}{a.email ? ` · ${a.email}` : ''}</option>)}
        </WorkbenchSelect>

        <label htmlFor="ticket-dispatch-note" className="mt-4 block text-[12px] font-semibold text-foreground">转单说明(选填)</label>
        <textarea id="ticket-dispatch-note" value={note} onChange={e => setNote(e.target.value)} rows={3}
          placeholder="例如:用户投诉续费乱扣费,请尽快私信安抚并核实订单"
          className="mt-1.5 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-6 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20" />

        <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
          <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
          <Button size="sm" onClick={submit}>转工单</Button>
        </div>
      </div>
    </div>
  )
}
