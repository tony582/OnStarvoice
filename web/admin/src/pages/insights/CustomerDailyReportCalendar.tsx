import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ChevronDown, Loader2 } from 'lucide-react'
import { DayButton, DayPicker, type DayButtonProps } from 'react-day-picker'
import { zhCN } from 'react-day-picker/locale'
import 'react-day-picker/style.css'
import { api } from '@/lib/api'
import { DAILY_API, dailyError, type DailyCalendarMonth } from './CustomerDailyReport.types'
import './CustomerDailyReportCalendar.css'

function localDate(value: string) {
  const [year, month, day = 1] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}

function dateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function CalendarDayButton(props: DayButtonProps) {
  const { modifiers } = props
  return <DayButton {...props}>
    <span>{props.children}</span>
    {modifiers.holiday ? <span className="daily-calendar-tag text-rose-600">休</span> : modifiers.makeup ? <span className="daily-calendar-tag text-blue-700">班</span> : modifiers.pending ? <span className="daily-calendar-tag text-slate-400">?</span> : null}
    {modifiers.report && <span className="daily-calendar-report-dot" aria-hidden="true" />}
  </DayButton>
}

export function CustomerDailyReportCalendar({ date, today, disabled, refresh, onSelect }: {
  date: string; today: string; disabled: boolean; refresh: number; onSelect: (date: string) => void
}) {
  const [view, setView] = useState({ date, month: date.slice(0, 7) })
  if (view.date !== date) setView({ date, month: date.slice(0, 7) })
  const month = view.date === date ? view.month : date.slice(0, 7)
  const requestKey = `${month}:${refresh}`
  const [result, setResult] = useState<{ key: string; calendar: DailyCalendarMonth | null; error: string } | null>(null)
  const calendar = result?.key === requestKey ? result.calendar : null
  const error = result?.key === requestKey ? result.error : ''
  const loading = result?.key !== requestKey
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    let cancelled = false
    api.get<{ calendar: DailyCalendarMonth }>(`${DAILY_API}/calendar-month?month=${encodeURIComponent(month)}`)
      .then(data => { if (!cancelled) setResult({ key: requestKey, calendar: data.calendar, error: '' }) })
      .catch(value => { if (!cancelled) setResult({ key: requestKey, calendar: null, error: dailyError(value, '日历暂时无法读取') }) })
    return () => { cancelled = true }
  }, [month, requestKey])
  const days = useMemo(() => new Map((calendar?.month === month ? calendar.days : []).map(day => [day.date, day])), [calendar, month])
  const pending = Array.from(days.values()).some(day => day.calendarPending)
  return <aside className="daily-calendar min-w-0 self-start rounded-xl border border-slate-200 bg-white xl:sticky xl:top-4" aria-label="日报日历">
    <h3 className="hidden items-center gap-2 px-4 py-4 text-sm font-semibold text-slate-800 xl:flex"><CalendarDays className="h-4 w-4 text-blue-600" />日报日历</h3>
    <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left text-sm font-semibold text-slate-800 xl:hidden" aria-expanded={expanded} aria-controls="daily-calendar-panel" onClick={() => setExpanded(value => !value)}>
      <span className="flex items-center gap-2"><CalendarDays className="h-4 w-4 text-blue-600" />日报日历</span>
      <span className="flex items-center gap-2 text-xs font-normal text-slate-500 xl:hidden">{date}<ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} /></span>
    </button>
    <div id="daily-calendar-panel" className={`${expanded ? 'block' : 'hidden'} border-t border-slate-100 p-3 xl:block`}>
      <DayPicker mode="single" required locale={zhCN} weekStartsOn={1} month={localDate(`${month}-01`)} onMonthChange={value => setView({ date, month: dateKey(value).slice(0, 7) })}
        selected={localDate(date)} today={localDate(today)} endMonth={localDate(today)} disableNavigation={disabled}
        disabled={disabled ? true : [{ after: localDate(today) }, value => loading || !days.has(dateKey(value)) || days.get(dateKey(value))?.calendarPending === true]}
        onSelect={value => { if (value && !disabled) { onSelect(dateKey(value)); setExpanded(false) } }}
        modifiers={{
          holiday: value => days.get(dateKey(value))?.kind === 'holiday',
          makeup: value => days.get(dateKey(value))?.kind === 'makeup',
          report: value => days.get(dateKey(value))?.hasReport === true,
          pending: value => days.get(dateKey(value))?.calendarPending === true,
          rest: value => days.get(dateKey(value))?.kind === 'weekend',
        }} modifiersClassNames={{ rest: 'text-slate-400' }} components={{ DayButton: CalendarDayButton }}
        labels={{ labelNext: () => '下一月', labelPrevious: () => '上一月', labelDayButton: value => {
          const day = days.get(dateKey(value))
          const kind = day?.calendarPending ? '工作日历待公布' : day?.kind === 'holiday' ? '法定休假' : day?.kind === 'makeup' ? '调班工作日' : day?.kind === 'weekend' ? '周末休息' : day ? '工作日' : '日历加载中'
          return `${dateKey(value)}，${kind}，${day?.hasReport ? '已有日报' : '暂无日报'}`
        } }}
      />
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-slate-100 pt-3 text-[11px] text-slate-500"><span><b className="text-rose-600">休</b> 法定休假</span><span><b className="text-blue-700">班</b> 调班</span><span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-blue-600" />已有日报</span></div>
      {loading && <p role="status" className="mt-3 flex items-center gap-1.5 text-xs text-slate-500"><Loader2 className="h-3 w-3 animate-spin" />正在读取日历</p>}
      {error && <p role="alert" className="mt-3 text-xs leading-5 text-rose-700">{error}</p>}
      {pending && <p role="status" className="mt-3 text-xs leading-5 text-amber-800">部分日期的官方工作日历尚未公布，暂不能生成日报。</p>}
      <p className="mt-3 text-[11px] leading-5 text-slate-400">休息日采集合并到下一工作日。<br />蓝点表示这一天已有日报。</p>
    </div>
  </aside>
}
