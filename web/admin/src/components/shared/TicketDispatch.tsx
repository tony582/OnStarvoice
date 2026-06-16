import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export interface DispatchResult { priority: string; assigneeName: string; note: string }
interface AskOptions { title?: string; summary?: string; defaultPriority?: string }
interface DispatchState extends AskOptions { resolve: (v: DispatchResult | null) => void }

const PRIORITIES = [
  { value: 'urgent', label: '紧急' },
  { value: 'high', label: '高' },
  { value: 'normal', label: '普通' },
  { value: 'low', label: '低' },
]

/**
 * 转工单弹窗(分诊侧):选优先级、指派客服、写转单说明。
 * 用法:const { dispatch, dialog } = useTicketDispatch(); const r = await dispatch({summary}); if(r){...}
 * 确定返回 {priority, assigneeName, note},取消返回 null。
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
  const [priority, setPriority] = useState(state.defaultPriority || 'normal')
  const [assigneeName, setAssigneeName] = useState('')
  const [note, setNote] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 30)
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onConfirm({ priority, assigneeName, note })
    }
    window.addEventListener('keydown', h)
    return () => { clearTimeout(t); window.removeEventListener('keydown', h) }
  }, [priority, assigneeName, note, onCancel, onConfirm])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 animate-in fade-in duration-150" onMouseDown={onCancel}>
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl animate-in zoom-in-95 duration-150" onMouseDown={e => e.stopPropagation()}>
        <h3 className="text-sm font-bold">{state.title || '转工单'}</h3>
        <p className="mt-1 text-[12px] text-muted-foreground">转给客服团队处理,处理完会回执到「工单回执」待你确认</p>
        {state.summary && (
          <div className="mt-3 line-clamp-2 rounded-lg bg-muted/60 px-3 py-2 text-[12px] leading-5 text-muted-foreground">{state.summary}</div>
        )}

        <label className="mt-4 block text-[12px] font-semibold text-foreground">优先级</label>
        <div className="mt-1.5 inline-flex gap-1">
          {PRIORITIES.map(p => (
            <button key={p.value} type="button" onClick={() => setPriority(p.value)}
              className={`rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${priority === p.value ? 'bg-accent text-primary' : 'text-muted-foreground hover:bg-muted'}`}>
              {p.label}
            </button>
          ))}
        </div>

        <label className="mt-4 block text-[12px] font-semibold text-foreground">指派给(选填)</label>
        <Input value={assigneeName} onChange={e => setAssigneeName(e.target.value)} placeholder="客服姓名 / 小组,不填则进公共池" className="mt-1.5 h-9 text-[13px]" />

        <label className="mt-4 block text-[12px] font-semibold text-foreground">转单说明(选填)</label>
        <textarea ref={ref} value={note} onChange={e => setNote(e.target.value)} rows={3}
          placeholder="例如:用户投诉续费乱扣费,请尽快私信安抚并核实订单"
          className="mt-1.5 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-6 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20" />

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
          <Button size="sm" onClick={() => onConfirm({ priority, assigneeName, note })}>转工单</Button>
        </div>
      </div>
    </div>
  )
}
