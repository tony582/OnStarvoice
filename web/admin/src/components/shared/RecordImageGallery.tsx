import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ImageOff, Loader2, RotateCcw, ScanText, ZoomIn } from 'lucide-react'
import { api } from '@/lib/api'

export function RecordImageGallery({
  images,
  imageRefs,
  onOpen,
  recordId,
  canRefresh = false,
}: {
  images: string[]
  imageRefs?: string[]
  onOpen: (url: string) => void
  recordId?: string
  canRefresh?: boolean
}) {
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [results, setResults] = useState<Record<number, ImageTextState>>({})
  const [busyIndex, setBusyIndex] = useState<number | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<{ index: number; ok: boolean } | null>(null)
  const requestSequence = useRef(0)
  const busyRef = useRef(false)
  const copyTimer = useRef<number | null>(null)
  const resultPanelRef = useRef<HTMLDivElement>(null)
  const visible = images
    .map((url, index) => ({ url, index, key: `${url}-${index}` }))
    .filter(item => !failed.has(item.key))
  const activeResult = activeIndex == null ? null : results[activeIndex]

  useEffect(() => () => {
    requestSequence.current += 1
    busyRef.current = false
    if (copyTimer.current != null) window.clearTimeout(copyTimer.current)
  }, [])

  useEffect(() => {
    if (activeIndex == null || !activeResult) return
    const frame = window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      resultPanelRef.current?.scrollIntoView({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'nearest',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeIndex, activeResult])

  const extractText = async (imageIndex: number, refresh = false) => {
    const imageRef = imageRefs?.[imageIndex] || ''
    if (!recordId || !imageRef || busyRef.current) return
    const current = results[imageIndex]
    if (!refresh && current?.status === 'success') {
      setActiveIndex(imageIndex)
      return
    }

    busyRef.current = true
    const sequence = ++requestSequence.current
    setActiveIndex(imageIndex)
    setBusyIndex(imageIndex)
    setCopyFeedback(null)
    setResults(previous => ({
      ...previous,
      [imageIndex]: {
        status: 'loading',
        text: '',
        cached: false,
        truncated: false,
        error: '',
      },
    }))

    try {
      const response = await api.post<ImageTextResponse>(
        `/records/${recordId}/image-text`,
        { imageRef, refresh },
      )
      if (requestSequence.current !== sequence) return
      setResults(previous => ({
        ...previous,
        [imageIndex]: {
          status: 'success',
          text: response.text || '',
          cached: response.cached === true,
          truncated: response.truncated === true,
          error: '',
        },
      }))
    } catch (error) {
      if (requestSequence.current !== sequence) return
      const message = imageTextErrorMessage(error)
      setResults(previous => ({
        ...previous,
        [imageIndex]: refresh && current?.status === 'success'
          ? { ...current, error: `${message}，已保留上次结果` }
          : {
              status: 'error',
              text: '',
              cached: false,
              truncated: false,
              error: message,
            },
      }))
    } finally {
      if (requestSequence.current === sequence) {
        busyRef.current = false
        setBusyIndex(null)
      }
    }
  }

  const copyResult = async (imageIndex: number, text: string) => {
    if (!text) return
    let ok = false
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text)
        ok = true
      } catch {
        // 企业浏览器策略或非安全上下文可能拒绝 Clipboard API，继续尝试兼容复制。
      }
    }
    if (!ok) {
      let textarea: HTMLTextAreaElement | null = null
      try {
        textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        ok = document.execCommand('copy')
      } catch {
        ok = false
      } finally {
        textarea?.remove()
      }
    }
    setCopyFeedback({ index: imageIndex, ok })
    if (copyTimer.current != null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopyFeedback(null), 2200)
  }

  if (images.length === 0) return null

  return (
    <section aria-label="内容图片">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h4 className="text-[13px] font-semibold text-foreground">图片</h4>
        {failed.size > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <ImageOff className="h-3.5 w-3.5" />
            {failed.size} 张平台原图已失效
          </span>
        )}
      </div>

      {visible.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {visible.map(item => (
            <div key={item.key}
              className="overflow-hidden rounded-lg border border-border bg-card">
              <button type="button" onClick={() => onOpen(item.url)} title="点击放大"
                aria-label={`放大第 ${item.index + 1} 张图片`}
                className="group relative block aspect-square w-full cursor-zoom-in overflow-hidden bg-muted">
                <img src={item.url} alt="" className="h-full w-full object-cover transition group-hover:scale-105"
                  referrerPolicy="no-referrer"
                  onError={() => setFailed(current => {
                    const next = new Set(current)
                    next.add(item.key)
                    return next
                  })} />
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/20 group-hover:opacity-100">
                  <ZoomIn className="h-4 w-4 text-white" />
                </span>
              </button>
              {recordId && imageRefs?.[item.index] && (
                <button type="button"
                  onClick={() => extractText(item.index)}
                  disabled={busyIndex !== null}
                  aria-label={`提取第 ${item.index + 1} 张图片的文字`}
                  className="flex h-10 w-full items-center justify-center gap-1.5 border-t border-border/70 bg-background px-2 text-[11px] font-semibold text-foreground transition hover:bg-primary/[0.05] hover:text-primary disabled:cursor-wait disabled:opacity-70">
                  {busyIndex === item.index ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  ) : (
                    <ScanText className="h-3.5 w-3.5 text-primary" />
                  )}
                  {busyIndex === item.index
                    ? '识别中'
                    : results[item.index]?.status === 'success'
                      ? '查看文字'
                      : results[item.index]?.status === 'error'
                        ? '重试识别'
                        : '提取文字'}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex min-h-20 items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-4 text-[12px] text-muted-foreground">
          <ImageOff className="h-4 w-4" />
          平台原图已失效，重新采集后可恢复
        </div>
      )}

      {recordId && activeIndex != null && activeResult && (
        <div ref={resultPanelRef}
          className="mt-3 scroll-m-3 overflow-hidden rounded-xl border border-primary/20 bg-primary/[0.025]"
          aria-live="polite">
          <div className="flex items-center gap-2 border-b border-primary/10 px-3 py-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ScanText className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-foreground">第 {activeIndex + 1} 张图片文字</div>
              <div className="text-[10px] text-muted-foreground">
                {activeResult.status === 'loading'
                  ? '千问正在读取图片'
                  : activeResult.status === 'success' && activeResult.cached
                    ? '已读取保存的识别结果'
                    : '按图片原有顺序保留换行'}
              </div>
            </div>
            {activeResult.status === 'success' && (
              <div className="flex shrink-0 items-center gap-1">
                {canRefresh && (
                  <button type="button"
                    onClick={() => extractText(activeIndex, true)}
                    disabled={busyIndex !== null}
                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition hover:bg-background hover:text-foreground disabled:opacity-50">
                    <RotateCcw className="h-3.5 w-3.5" />
                    重新识别
                  </button>
                )}
                <button type="button"
                  onClick={() => copyResult(activeIndex, activeResult.text)}
                  disabled={!activeResult.text}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45">
                  {copyFeedback?.index === activeIndex && copyFeedback.ok
                    ? <Check className="h-3.5 w-3.5" />
                    : <Copy className="h-3.5 w-3.5" />}
                  {copyFeedback?.index === activeIndex
                    ? (copyFeedback.ok ? '已复制' : '复制失败')
                    : '复制文字'}
                </button>
              </div>
            )}
          </div>

          {activeResult.status === 'loading' ? (
            <div className="flex min-h-24 items-center justify-center gap-2 px-4 py-6 text-[12px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              正在提取，只处理这一张图片
            </div>
          ) : activeResult.status === 'error' ? (
            <div className="px-3 py-3">
              <p className="text-[12px] leading-5 text-destructive">{activeResult.error}</p>
              <button type="button" onClick={() => extractText(activeIndex)}
                className="mt-2 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-[11px] font-semibold hover:bg-muted">
                <RotateCcw className="h-3.5 w-3.5" />
                再试一次
              </button>
            </div>
          ) : (
            <div>
              {activeResult.error && (
                <p className="border-b border-destructive/10 bg-destructive/[0.04] px-3 py-2 text-[11px] leading-5 text-destructive">
                  {activeResult.error}
                </p>
              )}
              {copyFeedback?.index === activeIndex && !copyFeedback.ok && (
                <p className="border-b border-border/60 bg-muted/40 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
                  自动复制未成功，可直接选中文字后复制。
                </p>
              )}
              {activeResult.truncated && (
                <p className="border-b border-amber-200/70 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
                  图片文字较多，本次结果可能不完整。可点击“重新识别”再试一次。
                </p>
              )}
              {activeResult.text ? (
                <pre className="m-0 max-h-64 select-text overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-sans text-[13px] leading-6 text-foreground selection:bg-primary/20">
                  {activeResult.text}
                </pre>
              ) : (
                <p className="px-3 py-4 text-[12px] text-muted-foreground">这张图片没有识别到可复制的文字。</p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

interface ImageTextResponse {
  ok: boolean
  text?: string
  cached?: boolean
  truncated?: boolean
}

type ImageTextState = {
  status: 'loading' | 'success' | 'error'
  text: string
  cached: boolean
  truncated: boolean
  error: string
}

function imageTextErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : ''
  if (!message) return '图片文字识别失败，请稍后重试'
  if (/请求超时，云端暂未完成分配/.test(message)) return '图片文字识别超时，请稍后重试'
  if (/failed to fetch|load failed|network|networkerror/i.test(message)) return '网络异常，请稍后重试'
  if (/abort|timeout/i.test(message)) return '图片文字识别超时，请稍后重试'
  return /[\u3400-\u9fff]/.test(message) ? message : '图片文字识别失败，请稍后重试'
}
