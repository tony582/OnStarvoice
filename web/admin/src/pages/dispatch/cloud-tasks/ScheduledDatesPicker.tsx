import { useId, useMemo, useState } from 'react'
import { CalendarDays, Plus, X } from 'lucide-react'
import { normalizeCloudTaskDateList, shanghaiToday } from './lib'

function formatDateLabel(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, 4))
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
  }).format(date)
  return `${month}月${day}日 · ${weekday}`
}

export function ScheduledDatesPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string | string[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const titleId = useId()
  const [candidate, setCandidate] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const today = shanghaiToday()
  const normalized = useMemo(() => normalizeCloudTaskDateList(value), [value])
  const dates = useMemo(() => normalized.dates.slice().sort(), [normalized.dates])
  const pendingCount = dates.filter(date => date >= today).length

  const commitDate = () => {
    if (!candidate) return
    if (candidate < today) {
      setAnnouncement('只能添加今天或未来的日期。')
      return
    }
    if (dates.includes(candidate)) {
      setCandidate('')
      setAnnouncement(`${formatDateLabel(candidate)} 已在计划中。`)
      return
    }
    if (dates.length >= 400) {
      setAnnouncement('一个计划最多可以指定 400 个日期。')
      return
    }
    const nextDates = [...dates, candidate].sort()
    onChange(nextDates.join('\n'))
    setCandidate('')
    setAnnouncement(`已添加 ${formatDateLabel(candidate)}。`)
  }

  const removeDate = (date: string) => {
    onChange(dates.filter(item => item !== date).join('\n'))
    setAnnouncement(`已移除 ${formatDateLabel(date)}。`)
  }

  return (
    <section className="rounded-xl border border-border/70 bg-muted/20 p-3.5" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 id={titleId} className="text-xs font-semibold text-foreground">选择运行日期</h4>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">从日历逐个加入；系统自动排序、去重。</p>
        </div>
        {dates.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground">
              已选 {dates.length} 天{pendingCount !== dates.length ? ` · 待运行 ${pendingCount} 天` : ''}
            </span>
            <button
              type="button"
              onClick={() => {
                onChange('')
                setAnnouncement('已清空全部指定日期。')
              }}
              disabled={disabled}
              className="text-[10px] font-medium text-muted-foreground transition-colors hover:text-status-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-45"
            >
              清空全部
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label className="min-w-0 flex-1 text-[11px] font-medium text-muted-foreground">
          添加日期
          <input
            type="date"
            value={candidate}
            min={today}
            onChange={event => {
              setCandidate(event.target.value)
              setAnnouncement('')
            }}
            onKeyDown={event => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              commitDate()
            }}
            disabled={disabled}
            className="mt-1.5 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-60"
          />
        </label>
        <button
          type="button"
          onClick={commitDate}
          disabled={disabled || !candidate || dates.length >= 400}
          className="mt-auto inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Plus className="h-3.5 w-3.5" />
          加入计划
        </button>
      </div>

      {dates.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-border bg-background/70 px-3 py-4 text-center">
          <CalendarDays className="mx-auto h-4 w-4 text-muted-foreground" />
          <p className="mt-1.5 text-[11px] text-muted-foreground">还没有指定日期，请先从上方日历添加。</p>
        </div>
      ) : (
        <div className="mt-3 grid max-h-44 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {dates.map(date => {
            const expired = date < today
            return (
              <div key={date} className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 ${expired ? 'border-border bg-muted/35' : 'border-primary/15 bg-background'}`}>
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${expired ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'}`}>
                  <CalendarDays className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-xs font-semibold ${expired ? 'text-muted-foreground' : 'text-foreground'}`}>{formatDateLabel(date)}</span>
                  <span className="mt-0.5 block text-[10px] tabular-nums text-muted-foreground">{date}{expired ? ' · 已过期' : ''}</span>
                </span>
                <button
                  type="button"
                  onClick={() => removeDate(date)}
                  disabled={disabled}
                  aria-label={`移除运行日期 ${date}`}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-status-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-45"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {normalized.invalidDates.length > 0 && (
        <div role="alert" className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] leading-4 text-status-red">
          <span>旧计划中有无法识别的日期：{normalized.invalidDates.slice(0, 3).join('、')}。</span>
          <button
            type="button"
            onClick={() => {
              onChange(dates.join('\n'))
              setAnnouncement('已清理无法识别的旧日期。')
            }}
            disabled={disabled}
            className="shrink-0 font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-45"
          >
            清理无效项
          </button>
        </div>
      )}
      <p aria-live="polite" className="mt-2 min-h-4 text-[11px] leading-4 text-muted-foreground">{announcement}</p>
    </section>
  )
}
