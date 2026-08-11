import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { cn } from '@/lib/utils'

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // 浏览器策略可能禁用 Clipboard API，继续尝试兼容复制。
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

export function CopyTicketNumberButton({ value, className, label = '工单号' }: {
  value: string
  className?: string
  label?: string
}) {
  const number = value.trim()
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timerRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  if (!number) return null

  const handleCopy = async () => {
    const copied = await copyText(number)
    setFeedback(copied ? 'copied' : 'failed')
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setFeedback('idle'), 1600)
  }

  const copyLabel = feedback === 'copied'
    ? `${label}已复制`
    : feedback === 'failed'
      ? '复制失败，请重试'
      : `复制${label} ${number}`

  return (
    <button
      type="button"
      aria-label={copyLabel}
      title={copyLabel}
      onClick={event => {
        event.stopPropagation()
        void handleCopy()
      }}
      onPointerDown={event => event.stopPropagation()}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/65 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
        feedback === 'copied' && 'text-status-green hover:text-status-green',
        feedback === 'failed' && 'text-destructive hover:text-destructive',
        className,
      )}
    >
      {feedback === 'copied' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}
