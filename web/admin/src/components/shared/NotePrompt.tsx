import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

interface AskOptions {
  title?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  required?: boolean
  requiredMessage?: string
  helpText?: string
}
interface PromptState extends AskOptions { resolve: (v: string | null) => void }

/**
 * 替代原生 window.prompt 的样式化备注弹窗。
 * 用法:const { ask, dialog } = useNotePrompt();  const note = await ask({...});  并在 JSX 渲染 {dialog}
 * 确定返回输入字符串,取消/ESC/点遮罩返回 null(与 prompt 语义一致)。
 */
export function useNotePrompt() {
  const [state, setState] = useState<PromptState | null>(null)

  const ask = useCallback((opts: AskOptions = {}) => {
    return new Promise<string | null>((resolve) => setState({ ...opts, resolve }))
  }, [])

  const close = useCallback((value: string | null) => {
    setState((cur) => { cur?.resolve(value); return null })
  }, [])

  const dialog = state ? <NoteModal state={state} onCancel={() => close(null)} onConfirm={(v) => close(v)} /> : null

  return { ask, dialog }
}

function NoteModal({ state, onCancel, onConfirm }: { state: PromptState; onCancel: () => void; onConfirm: (v: string) => void }) {
  const [value, setValue] = useState(state.defaultValue || '')
  const [error, setError] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const submit = useCallback(() => {
    const trimmed = value.trim()
    if (state.required && !trimmed) {
      setError(state.requiredMessage || '请填写原因后再确认')
      ref.current?.focus()
      return
    }
    setError('')
    onConfirm(state.required ? trimmed : value)
  }, [onConfirm, state.required, state.requiredMessage, value])

  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 30)
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
    }
    window.addEventListener('keydown', h)
    return () => { clearTimeout(t); window.removeEventListener('keydown', h) }
  }, [onCancel, submit])

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4 animate-in fade-in duration-150" onMouseDown={onCancel}>
      <div className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-xl sm:p-5 animate-in zoom-in-95 duration-150" onMouseDown={e => e.stopPropagation()}>
        <h3 className="text-sm font-bold">{state.title || '处理备注'}</h3>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {state.helpText || (state.required ? '必填，请说明本次操作的具体原因' : '选填，记录如何处理 / 原因，便于回看留痕')}
        </p>
        <textarea
          ref={ref}
          value={value}
          onChange={e => {
            setValue(e.target.value)
            if (error && e.target.value.trim()) setError('')
          }}
          placeholder={state.placeholder || '例如：已私信用户跟进 / 已转交售后 / 与本品牌无关'}
          rows={4}
          aria-invalid={Boolean(error)}
          className={`mt-3 w-full resize-none rounded-lg border bg-background px-3 py-2 text-[13px] leading-6 outline-none transition focus:ring-2 ${
            error ? 'border-destructive focus:border-destructive focus:ring-destructive/15' : 'border-border focus:border-primary focus:ring-primary/20'
          }`}
        />
        {error && <p className="mt-1.5 text-[12px] font-medium text-destructive">{error}</p>}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
          <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
          <Button size="sm" onClick={submit}>{state.confirmLabel || '确定'}</Button>
        </div>
      </div>
    </div>
  )
}
