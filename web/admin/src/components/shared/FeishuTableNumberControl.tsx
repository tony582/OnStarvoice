import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { CopyTicketNumberButton } from '@/components/shared/CopyTicketNumberButton'

export interface FeishuTableNumberSaveResult {
  ok: boolean
  message?: string
}

export function FeishuTableNumberControl({ value, onSave, disabled = false, className, inputClassName }: {
  value?: string | null
  onSave?: (value: string) => Promise<FeishuTableNumberSaveResult>
  disabled?: boolean
  className?: string
  inputClassName?: string
}) {
  const number = String(value || '').trim()
  const display = number || '待填写'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(number)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)

  const cancel = () => {
    setDraft(number)
    setError('')
    setEditing(false)
  }

  const save = async () => {
    const normalized = draft.trim()
    if (!onSave || savingRef.current) return
    if (!normalized) {
      cancel()
      return
    }
    if (normalized === number) {
      setEditing(false)
      return
    }
    savingRef.current = true
    setSaving(true)
    setError('')
    const result = await onSave(normalized)
    if (result.ok) setEditing(false)
    else setError(result.message || '飞书表号保存失败')
    setSaving(false)
    savingRef.current = false
  }

  if (editing && onSave && !disabled) {
    return (
      <div className={cn('inline-flex max-w-full flex-col items-start', className)}>
        <form
          onSubmit={event => { event.preventDefault(); event.stopPropagation(); void save() }}
          onClick={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
          className="inline-flex h-8 max-w-full items-center gap-1.5"
        >
          <span className="shrink-0 text-[11px] font-medium text-primary">飞书表号</span>
          <input
            autoFocus
            value={draft}
            maxLength={100}
            autoComplete="off"
            aria-label="飞书表号"
            placeholder="输入飞书表号"
            disabled={saving}
            onChange={event => { setDraft(event.target.value); setError('') }}
            onBlur={() => {
              if (draft.trim()) void save()
              else cancel()
            }}
            onKeyDown={event => {
              event.stopPropagation()
              if (event.key === 'Escape') {
                event.preventDefault()
                cancel()
              }
            }}
            className={cn(
              'ticket-number-input h-8 w-40 min-w-0 border-0 border-b border-primary bg-transparent px-0.5 text-[13px] font-semibold text-foreground outline-none disabled:opacity-60',
              error && 'border-destructive',
              inputClassName,
            )}
          />
          {saving && <Loader2 aria-label="正在保存飞书表号" className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
        </form>
        {error && <span role="alert" className="mt-1 max-w-60 truncate text-[10px] font-medium text-destructive">{error}</span>}
      </div>
    )
  }

  return (
    <div className={cn('inline-flex h-7 min-w-0 max-w-full items-center gap-0.5 text-[11px] tabular-nums', className)} title={`飞书表号：${display}`}>
      <button
        type="button"
        disabled={disabled || !onSave}
        aria-label={onSave ? `修改飞书表号：${display}` : `飞书表号：${display}`}
        onClick={event => {
          event.stopPropagation()
          setDraft(number)
          setError('')
          setEditing(true)
        }}
        onPointerDown={event => event.stopPropagation()}
        onDragStart={event => event.preventDefault()}
        className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded px-0.5 outline-none transition-colors enabled:hover:bg-muted enabled:hover:text-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <span className="shrink-0 font-medium text-primary">飞书表号</span>
        <span className={cn('max-w-60 truncate font-semibold', number ? 'text-foreground' : 'text-destructive')}>{display}</span>
      </button>
      <CopyTicketNumberButton value={number} label="飞书表号" className="h-6 w-6" />
    </div>
  )
}
