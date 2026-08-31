import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { resolveRecordOriginalUrl } from '@/lib/record-display'

type SourceOpenState = 'idle' | 'queued' | 'opened' | 'failed'

interface SourceOpenResponse {
  sourceOpen?: {
    taskId?: string
    state?: string
    status?: string
    message?: string
    reason?: string
    agent?: { name?: string }
  }
}

interface RecordSourceActionProps {
  record: any
  compact?: boolean
  className?: string
}

function wait(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

export function RecordSourceAction({
  record,
  compact = false,
  className = '',
}: RecordSourceActionProps) {
  const platform = String(record?.platform || '').trim().toLowerCase()
  const hasXhsUrl = [record?.url, record?.canonical_url]
    .some(url => /(^|\.)xiaohongshu\.com(?:\/|$)/iu.test(String(url || '').replace(/^https?:\/\//iu, '')))
  const isXhs = platform === 'xiaohongshu' || hasXhsUrl
  const originalUrl = resolveRecordOriginalUrl(record)
  const [state, setState] = useState<SourceOpenState>('idle')
  const [message, setMessage] = useState('')
  const mounted = useRef(true)
  const requestGeneration = useRef(0)

  useEffect(() => {
    mounted.current = true
    requestGeneration.current += 1
    setState('idle')
    setMessage('')
    return () => {
      mounted.current = false
      requestGeneration.current += 1
    }
  }, [record?.id])

  if (!isXhs) {
    if (!originalUrl) return null
    return (
      <a
        href={originalUrl}
        target="_blank"
        rel="noreferrer"
        onClick={event => event.stopPropagation()}
        className={cn('inline-flex shrink-0 items-center gap-0.5 font-medium text-primary hover:underline', className)}
      >
        <ExternalLink className={compact ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5'} />原文
      </a>
    )
  }

  const available = record?.source_open_available !== false && Boolean(record?.id)
  const openSource = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (!available || state === 'queued') return
    const recordId = String(record.id)
    const operationGeneration = requestGeneration.current + 1
    requestGeneration.current = operationGeneration
    const isCurrentOperation = () => (
      mounted.current && requestGeneration.current === operationGeneration
    )
    setState('queued')
    setMessage('正在选择在线小红书节点并刷新链接')
    try {
      const created = await api.post<SourceOpenResponse>(
        `/triage/records/${recordId}/source-open`,
        {},
      )
      const taskId = String(created.sourceOpen?.taskId || '')
      const agentName = String(created.sourceOpen?.agent?.name || '')
      if (!taskId) throw new Error('服务端未返回实时打开任务')
      if (isCurrentOperation()) {
        setMessage(agentName ? `已交给 ${agentName}，等待打开` : '已下发，等待节点打开')
      }
      for (let index = 0; index < 60; index += 1) {
        await wait(1000)
        if (!isCurrentOperation()) return
        const status = await api.get<SourceOpenResponse>(
          `/triage/records/${recordId}/source-open/${taskId}`,
        )
        const sourceOpen = status.sourceOpen || {}
        if (sourceOpen.state === 'opened') {
          if (isCurrentOperation()) {
            setState('opened')
            setMessage(sourceOpen.message || '已在采集节点的登录 Profile 中打开原文')
          }
          return
        }
        if (sourceOpen.state === 'failed') {
          if (isCurrentOperation()) {
            setState('failed')
            setMessage(sourceOpen.message || '实时打开失败，可再次尝试')
          }
          return
        }
      }
      throw new Error('节点响应超时；若浏览器已打开搜索页，可在该页人工确认')
    } catch (error) {
      if (isCurrentOperation()) {
        setState('failed')
        setMessage(error instanceof Error ? error.message : '实时打开失败，可再次尝试')
      }
    }
  }

  const label = state === 'queued'
    ? '刷新中'
    : state === 'opened'
      ? '已打开'
      : state === 'failed'
        ? '重试原文'
        : '原文'

  return (
    <button
      type="button"
      onClick={openSource}
      disabled={!available || state === 'queued'}
      title={message || '在在线小红书采集节点中刷新链接并打开原文'}
      aria-label={message || '实时刷新并打开小红书原文'}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50',
        state === 'failed' && 'text-destructive',
        className,
      )}
    >
      {state === 'queued'
        ? <Loader2 className={cn(compact ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5', 'animate-spin')} />
        : state === 'failed'
          ? <RefreshCw className={compact ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5'} />
          : <ExternalLink className={compact ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5'} />}
      {label}
    </button>
  )
}
