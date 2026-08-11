import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

export interface StatusChangeValues {
  note: string
  feishuTableNo: string
}

interface StatusChangePromptOptions {
  statusLabel: string
  batchCount?: number
  requireFeishuTableNo?: boolean
  defaultFeishuTableNo?: string
}

interface PromptState extends StatusChangePromptOptions {
  resolve: (value: StatusChangeValues | null) => void
}

export function useStatusChangePrompt() {
  const [state, setState] = useState<PromptState | null>(null)

  const ask = useCallback((options: StatusChangePromptOptions) => (
    new Promise<StatusChangeValues | null>(resolve => setState({ ...options, resolve }))
  ), [])

  const close = useCallback((value: StatusChangeValues | null) => {
    setState(current => {
      current?.resolve(value)
      return null
    })
  }, [])

  return {
    ask,
    dialog: state ? (
      <StatusChangeModal
        state={state}
        onCancel={() => close(null)}
        onConfirm={value => close(value)}
      />
    ) : null,
  }
}

function StatusChangeModal({ state, onCancel, onConfirm }: {
  state: PromptState
  onCancel: () => void
  onConfirm: (value: StatusChangeValues) => void
}) {
  const [feishuTableNo, setFeishuTableNo] = useState(state.defaultFeishuTableNo || '')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const numberRef = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  const submit = useCallback(() => {
    const normalizedNumber = feishuTableNo.trim()
    if (state.requireFeishuTableNo && !normalizedNumber) {
      setError('请填写飞书表号')
      numberRef.current?.focus()
      return
    }
    setError('')
    onConfirm({ note: note.trim(), feishuTableNo: normalizedNumber })
  }, [feishuTableNo, note, onConfirm, state.requireFeishuTableNo])

  // 自动聚焦只在弹窗首次打开时执行；不能跟随 note/feishuTableNo 更新，
  // 否则输入备注时会被异步抢回飞书表号输入框。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (state.requireFeishuTableNo) numberRef.current?.focus()
      else noteRef.current?.focus()
    }, 30)
    return () => window.clearTimeout(timer)
  }, [state.requireFeishuTableNo])

  // 键盘监听与首次聚焦分开，允许提交函数随表单值更新而不触发重新聚焦。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel, submit])

  const targetDescription = state.batchCount && state.batchCount > 1
    ? `将 ${state.batchCount} 条内容改为“${state.statusLabel}”。`
    : `将当前内容改为“${state.statusLabel}”。`

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4 animate-in fade-in duration-150" onMouseDown={onCancel}>
      <div role="dialog" aria-modal="true" aria-labelledby="status-change-title" className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-xl sm:p-5 animate-in zoom-in-95 duration-150" onMouseDown={event => event.stopPropagation()}>
        <h3 id="status-change-title" className="text-sm font-bold">确认修改处理状态</h3>
        <p className="mt-1 text-[12px] text-muted-foreground">{targetDescription}</p>

        {state.requireFeishuTableNo && (
          <div className="mt-4">
            <label htmlFor="status-change-feishu-number" className="text-[12px] font-semibold text-foreground">
              飞书表号 <span className="text-destructive">*</span>
            </label>
            <input
              ref={numberRef}
              id="status-change-feishu-number"
              value={feishuTableNo}
              maxLength={100}
              onChange={event => {
                setFeishuTableNo(event.target.value)
                if (error && event.target.value.trim()) setError('')
              }}
              placeholder="请输入飞书表号"
              aria-invalid={Boolean(error)}
              className="mt-1.5 flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
            />
            {error && <p className="mt-1.5 text-[12px] font-medium text-destructive">{error}</p>}
          </div>
        )}

        <div className="mt-4">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="status-change-note" className="text-[12px] font-semibold text-foreground">备注（选填）</label>
            <span className="text-[10px] tabular-nums text-muted-foreground">{note.length}/2000</span>
          </div>
          <textarea
            ref={noteRef}
            id="status-change-note"
            value={note}
            maxLength={2000}
            rows={4}
            onChange={event => setNote(event.target.value)}
            placeholder="填写本次状态变更的说明…"
            className="mt-1.5 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-6 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
          <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
          <Button size="sm" onClick={submit}>确认修改</Button>
        </div>
      </div>
    </div>
  )
}
