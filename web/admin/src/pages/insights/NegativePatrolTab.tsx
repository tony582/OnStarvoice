import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  CircleOff,
  Eye,
  Heart,
  Loader2,
  MessageCircle,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Star,
  TrendingUp,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useNav } from '@/lib/navigation'
import { cn, formatNumber, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusPill } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchSelect } from '@/components/shared/Workbench'
import { RecordDrawer } from '@/components/shared/RecordDrawer'

type RangePreset = 'today' | '7d' | '30d' | 'custom'
type NullableNumber = number | null
type PatrolStatus = 'available' | 'unavailable' | 'baseline_pending'

type PatrolSummary = {
  volume: number
  trackedRecords: number
  measuredRecords: number
  unmeasuredRecords: number
  unavailableCurrent: number
  newNegative: NullableNumber
  highRisk: NullableNumber
  likesDelta: NullableNumber
  commentsDelta: NullableNumber
  collectsDelta: NullableNumber
  sharesDelta: NullableNumber
  interactionDelta: NullableNumber
}

type TrendRow = {
  date: string
  label: string
  volume: number
  newNegative: NullableNumber
  measuredRecords: number
  unmeasuredRecords: number
  likesDelta: NullableNumber
  commentsDelta: NullableNumber
  collectsDelta: NullableNumber
  sharesDelta: NullableNumber
  interactionDelta: NullableNumber
}

type RisingRecord = {
  recordId: string
  title: string
  platform: string
  keyword: string
  availabilityStatus: string
  patrolStatus: PatrolStatus
  riskLevel: string
  endpoint: Record<string, unknown>
  baseline: Record<string, unknown> | null
  delta: Record<string, unknown> | null
}

type PatrolData = {
  summary: PatrolSummary
  trend: TrendRow[]
  status: Array<{ status: string; count: number }>
  platforms: Array<Record<string, unknown>>
  topics: Array<Record<string, unknown>>
  risingRecords: RisingRecord[]
}

const RANGE_OPTIONS: Array<{ id: RangePreset; label: string }> = [
  { id: 'today', label: '今日' },
  { id: '7d', label: '近 7 天' },
  { id: '30d', label: '近 30 天' },
  { id: 'custom', label: '自定义' },
]

const PLATFORM_OPTIONS = [
  { value: '', label: '全部平台' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'douyin', label: '抖音' },
  { value: 'weibo', label: '微博' },
]

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'available', label: '仍可访问' },
  { value: 'unavailable', label: '已删除或不可访问' },
  { value: 'baseline_pending', label: '待形成基线' },
]

const INTERACTION_SERIES = [
  { key: 'likesDelta', label: '点赞增加', color: '#2563EB', icon: Heart },
  { key: 'commentsDelta', label: '评论增加', color: '#DC2626', icon: MessageCircle },
  { key: 'collectsDelta', label: '收藏增加', color: '#D97706', icon: Star },
  { key: 'sharesDelta', label: '转发增加', color: '#7C3AED', icon: TrendingUp },
] as const

function inputDate(offsetDays = 0) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return date.toLocaleDateString('en-CA')
}

function dateBounds(preset: RangePreset, start: string, end: string) {
  const today = inputDate()
  const from = preset === 'today'
    ? today
    : preset === '7d'
      ? inputDate(-6)
      : preset === '30d'
        ? inputDate(-29)
        : start
  const to = preset === 'custom' ? end : today
  return {
    from,
    to,
    periodStart: new Date(`${from}T00:00:00`).toISOString(),
    periodEnd: new Date(`${to}T23:59:59.999`).toISOString(),
  }
}

function finiteNumber(value: unknown, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function nullableNumber(value: unknown): NullableNumber {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function firstValue(source: Record<string, unknown> | null | undefined, keys: string[]) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source[key] !== null) return source[key]
  }
  return null
}

function deltaValue(source: Record<string, unknown>, key: keyof Omit<PatrolSummary, 'volume' | 'trackedRecords' | 'measuredRecords' | 'unmeasuredRecords' | 'unavailableCurrent' | 'newNegative' | 'highRisk'>) {
  const aliases: Record<string, string[]> = {
    likesDelta: ['likesDelta', 'likes_delta', 'likes'],
    commentsDelta: ['commentsDelta', 'comments_delta', 'comments', 'comments_count'],
    collectsDelta: ['collectsDelta', 'collects_delta', 'collects'],
    sharesDelta: ['sharesDelta', 'shares_delta', 'shares'],
    interactionDelta: ['interactionDelta', 'interaction_delta', 'interactionTotal', 'interaction_total'],
  }
  const direct = firstValue(source, aliases[key] || [key])
  if (direct !== null && typeof direct !== 'object') return direct
  const nested = (
    source.interactionDelta && typeof source.interactionDelta === 'object'
      ? source.interactionDelta
      : source.interaction_delta && typeof source.interaction_delta === 'object'
        ? source.interaction_delta
        : null
  ) as Record<string, unknown> | null
  return firstValue(nested, aliases[key] || [key])
}

function unavailableCount(raw: Record<string, unknown>) {
  const direct = firstValue(raw, ['unavailableCurrent', 'unavailable_current'])
  if (direct !== null) return finiteNumber(direct)
  const availability = (
    raw.availability && typeof raw.availability === 'object'
      ? raw.availability
      : null
  ) as Record<string, unknown> | null
  if (!availability) return 0
  return ['deleted', 'page_unavailable', 'unavailable', 'not_found']
    .reduce((sum, key) => sum + finiteNumber(availability[key]), 0)
}

function normalizeSummary(raw: Record<string, unknown> = {}): PatrolSummary {
  const volume = finiteNumber(firstValue(raw, [
    'volume',
    'negativeVolume',
    'negative_volume',
    'negativePostVolume',
    'negative_post_volume',
  ]))
  return {
    volume,
    trackedRecords: finiteNumber(firstValue(raw, [
      'trackedRecords',
      'tracked_records',
      'negativePostVolume',
      'negative_post_volume',
    ]), volume),
    measuredRecords: finiteNumber(firstValue(raw, ['measuredRecords', 'measured_records', 'measuredPosts', 'measured_posts'])),
    unmeasuredRecords: finiteNumber(firstValue(raw, ['unmeasuredRecords', 'unmeasured_records', 'unmeasuredPosts', 'unmeasured_posts'])),
    unavailableCurrent: unavailableCount(raw),
    newNegative: nullableNumber(firstValue(raw, ['newNegative', 'new_negative', 'newRecords', 'new_records'])),
    highRisk: nullableNumber(firstValue(raw, ['highRisk', 'high_risk', 'criticalRecords', 'critical_records'])),
    likesDelta: nullableNumber(deltaValue(raw, 'likesDelta')),
    commentsDelta: nullableNumber(deltaValue(raw, 'commentsDelta')),
    collectsDelta: nullableNumber(deltaValue(raw, 'collectsDelta')),
    sharesDelta: nullableNumber(deltaValue(raw, 'sharesDelta')),
    interactionDelta: nullableNumber(deltaValue(raw, 'interactionDelta')),
  }
}

function normalizeTrendRow(raw: Record<string, unknown>): TrendRow {
  const date = String(firstValue(raw, ['date', 'day', 'bucket']) || '')
  return {
    date,
    label: String(firstValue(raw, ['label']) || (date ? date.slice(5, 10) : '—')),
    volume: finiteNumber(firstValue(raw, [
      'volume',
      'negativeVolume',
      'negative_volume',
      'negativePostVolume',
      'negative_post_volume',
    ])),
    newNegative: nullableNumber(firstValue(raw, ['newNegative', 'new_negative', 'newRecords', 'new_records'])),
    measuredRecords: finiteNumber(firstValue(raw, ['measuredRecords', 'measured_records', 'measuredPosts', 'measured_posts'])),
    unmeasuredRecords: finiteNumber(firstValue(raw, ['unmeasuredRecords', 'unmeasured_records', 'unmeasuredPosts', 'unmeasured_posts'])),
    likesDelta: nullableNumber(deltaValue(raw, 'likesDelta')),
    commentsDelta: nullableNumber(deltaValue(raw, 'commentsDelta')),
    collectsDelta: nullableNumber(deltaValue(raw, 'collectsDelta')),
    sharesDelta: nullableNumber(deltaValue(raw, 'sharesDelta')),
    interactionDelta: nullableNumber(deltaValue(raw, 'interactionDelta')),
  }
}

function normalizeRecord(raw: Record<string, unknown>): RisingRecord {
  const endpoint = (
    raw.endpoint && typeof raw.endpoint === 'object'
      ? raw.endpoint
      : {}
  ) as Record<string, unknown>
  const baseline = (
    raw.baseline && typeof raw.baseline === 'object'
      ? raw.baseline
      : null
  ) as Record<string, unknown> | null
  const delta = (
    raw.delta && typeof raw.delta === 'object'
      ? raw.delta
      : null
  ) as Record<string, unknown> | null
  const availabilityStatus = String(
    firstValue(raw, ['availabilityStatus', 'availability_status']) || 'unknown',
  ).toLowerCase()
  const explicitPatrolStatus = String(
    firstValue(raw, ['patrolStatus', 'patrol_status']) || '',
  ).toLowerCase()
  const patrolStatus: PatrolStatus = (
    ['available', 'unavailable', 'baseline_pending'].includes(explicitPatrolStatus)
      ? explicitPatrolStatus
      : isUnavailable(availabilityStatus)
        ? 'unavailable'
        : delta
          ? 'available'
          : 'baseline_pending'
  ) as PatrolStatus
  return {
    recordId: String(firstValue(raw, ['recordId', 'record_id', 'id']) || ''),
    title: String(firstValue(raw, ['title']) || '未命名负面内容'),
    platform: String(firstValue(raw, ['platform']) || ''),
    keyword: String(firstValue(raw, ['keyword']) || ''),
    availabilityStatus,
    patrolStatus,
    riskLevel: String(firstValue(raw, ['riskLevel', 'risk_level']) || ''),
    endpoint,
    baseline,
    delta,
  }
}

function normalizePatrol(raw: Record<string, unknown> | null | undefined): PatrolData | null {
  if (!raw || typeof raw !== 'object') return null
  const summary = normalizeSummary((raw.summary || {}) as Record<string, unknown>)
  const status = Array.isArray(raw.status)
    ? raw.status.map(item => ({
      status: String((item as Record<string, unknown>).status || ''),
      count: finiteNumber((item as Record<string, unknown>).count),
    }))
    : []
  const risingRecords = Array.isArray(raw.risingRecords)
    ? raw.risingRecords.map(item => normalizeRecord(item as Record<string, unknown>))
    : []
  if (summary.highRisk === null) {
    const statusHighRisk = status
      .filter(item => ['high_risk', 'high', 'critical'].includes(item.status))
      .reduce((sum, item) => sum + item.count, 0)
    const recordHighRisk = risingRecords.filter(item => ['high', 'critical'].includes(item.riskLevel)).length
    if (statusHighRisk || recordHighRisk) summary.highRisk = statusHighRisk || recordHighRisk
  }
  return {
    summary,
    trend: Array.isArray(raw.trend)
      ? raw.trend.map(item => normalizeTrendRow(item as Record<string, unknown>))
      : [],
    status,
    platforms: Array.isArray(raw.platforms) ? raw.platforms as Array<Record<string, unknown>> : [],
    topics: Array.isArray(raw.topics) ? raw.topics as Array<Record<string, unknown>> : [],
    risingRecords,
  }
}

function recordDelta(record: RisingRecord, key: string): NullableNumber {
  const aliases: Record<string, string[]> = {
    likesDelta: ['likesDelta', 'likes_delta', 'likes'],
    commentsDelta: ['commentsDelta', 'comments_delta', 'comments', 'comments_count'],
    collectsDelta: ['collectsDelta', 'collects_delta', 'collects'],
    sharesDelta: ['sharesDelta', 'shares_delta', 'shares'],
    interactionDelta: ['interactionDelta', 'interaction_delta', 'interactionTotal', 'interaction_total'],
  }
  return nullableNumber(firstValue(record.delta, aliases[key] || [
    key,
    key.replace(/[A-Z]/g, match => `_${match.toLowerCase()}`),
  ]))
}

function recordInteractionDelta(record: RisingRecord) {
  const total = recordDelta(record, 'interactionDelta')
  if (total !== null) return total
  const values = ['likesDelta', 'commentsDelta', 'collectsDelta', 'sharesDelta'].map(key => recordDelta(record, key))
  if (values.every(value => value === null)) return null
  return values.reduce<number>((sum, value) => sum + (value || 0), 0)
}

function isUnavailable(status: string) {
  return ['deleted', 'page_unavailable', 'unavailable', 'not_found'].includes(status)
}

function availabilityLabel(record: RisingRecord) {
  if (record.patrolStatus === 'baseline_pending') return '待形成基线'
  if (record.availabilityStatus === 'deleted') return '原帖已删除'
  if (record.patrolStatus === 'unavailable') return '已删除或不可访问'
  return '仍可访问'
}

function matchesStatus(record: RisingRecord, status: string) {
  if (!status) return true
  return record.patrolStatus === status
}

function signed(value: NullableNumber) {
  if (value === null) return '待形成基线'
  return `${value > 0 ? '+' : ''}${formatNumber(value)}`
}

function interactionTooltip(value: unknown, name: unknown) {
  const matched = INTERACTION_SERIES.find(item => item.key === name)
  const parsed = nullableNumber(value)
  return [parsed === null ? '待形成基线' : signed(parsed), matched?.label || String(name)]
}

function PatrolPanel({
  title,
  eyebrow,
  action,
  children,
  className,
}: {
  title: string
  eyebrow?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div>
          {eyebrow && <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">{eyebrow}</div>}
          <h3 className={cn('text-sm font-bold', eyebrow && 'mt-1')}>{title}</h3>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = 'blue',
}: {
  label: string
  value: React.ReactNode
  detail?: string
  icon: React.ElementType
  tone?: 'blue' | 'red' | 'amber' | 'purple' | 'grey'
}) {
  const toneClass = {
    blue: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300',
    red: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
    purple: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
    grey: 'bg-muted text-muted-foreground',
  }[tone]
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-xs font-semibold text-muted-foreground">{label}</div>
        <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', toneClass)}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-3 min-h-9 text-2xl font-black tabular-nums text-foreground">{value}</div>
      {detail && <div className="mt-1 text-[11px] leading-5 text-muted-foreground">{detail}</div>}
    </div>
  )
}

function NegativeVolumeChart({ rows }: { rows: TrendRow[] }) {
  if (!rows.length) {
    return <EmptyState icon={Activity} title="暂无负面声量趋势" description="产生巡查快照后会按天展示负面内容声量。" />
  }
  return (
    <div className="h-[280px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ left: 0, right: 8, top: 12, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--muted-fg)' }} />
          <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--muted-fg)' }} width={34} allowDecimals={false} />
          <Tooltip
            contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
            formatter={(value, name) => [formatNumber(Number(value)), name === 'newNegative' ? '新增负面' : '负面声量']}
          />
          <Area dataKey="volume" type="monotone" stroke="#DC2626" fill="#DC2626" fillOpacity={0.12} strokeWidth={2.4} />
          {rows.some(row => row.newNegative !== null) && (
            <Area dataKey="newNegative" type="monotone" stroke="#D97706" fill="#D97706" fillOpacity={0.08} strokeWidth={2} />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function InteractionTrendChart({ rows }: { rows: TrendRow[] }) {
  const hasBaseline = rows.some(row => INTERACTION_SERIES.some(series => row[series.key] !== null))
  if (!rows.length || !hasBaseline) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="首轮巡查已建立基线"
        description="下一轮巡查起会显示点赞、评论、收藏与转发的真实增量；当前不以 0 代替缺失基线。"
      />
    )
  }
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-x-4 gap-y-2">
        {INTERACTION_SERIES.map(series => (
          <div key={series.key} className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: series.color }} />
            {series.label}
          </div>
        ))}
      </div>
      <div className="h-[244px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ left: 0, right: 8, top: 12, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--muted-fg)' }} />
            <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--muted-fg)' }} width={42} allowDecimals={false} />
            <Tooltip
              contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
              formatter={interactionTooltip}
            />
            {INTERACTION_SERIES.map(series => (
              <Line
                key={series.key}
                dataKey={series.key}
                type="monotone"
                connectNulls={false}
                stroke={series.color}
                strokeWidth={2.2}
                dot={{ r: 2.5, fill: series.color, strokeWidth: 0 }}
                activeDot={{ r: 4 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}

function RecordDeltaChips({ record }: { record: RisingRecord }) {
  const values = INTERACTION_SERIES
    .map(series => ({ ...series, value: recordDelta(record, series.key) }))
    .filter(item => item.value !== null)
  if (!values.length) {
    return <StatusPill tone="pending">待形成基线</StatusPill>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map(item => {
        const Icon = item.icon
        return (
          <span key={item.key} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] font-semibold tabular-nums text-muted-foreground">
            <Icon className="h-3 w-3" />
            {signed(item.value)}
          </span>
        )
      })}
    </div>
  )
}

function RisingRecords({
  rows,
  onOpen,
  busyId,
}: {
  rows: RisingRecord[]
  onOpen: (recordId: string) => void
  busyId: string
}) {
  if (!rows.length) {
    return <EmptyState icon={Sparkles} title="当前筛选下暂无升温内容" description="互动增长明显的负面内容会出现在这里。" />
  }
  return (
    <div className="divide-y divide-border">
      {rows.slice(0, 12).map((record, index) => {
        const unavailable = record.patrolStatus === 'unavailable'
        const baselinePending = record.patrolStatus === 'baseline_pending'
        return (
          <button
            key={`${record.recordId}-${index}`}
            type="button"
            data-record-detail-trigger
            disabled={!record.recordId || busyId === record.recordId}
            onClick={() => onOpen(record.recordId)}
            className="group grid w-full gap-3 py-4 text-left transition-colors first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-rose-50 text-[11px] font-black text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                  {index + 1}
                </span>
                <span className="min-w-0 truncate text-[13px] font-bold text-foreground group-hover:text-primary">{record.title}</span>
                <StatusPill tone={unavailable ? 'negative' : baselinePending ? 'pending' : 'active'}>{availabilityLabel(record)}</StatusPill>
                {['high', 'critical'].includes(record.riskLevel) && <StatusPill tone="critical">高风险</StatusPill>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-8 text-[11px] text-muted-foreground">
                <span>{platformName(record.platform || 'unknown')}</span>
                {record.keyword && <span>关键词 · {record.keyword}</span>}
                <span>互动净增 · {signed(recordInteractionDelta(record))}</span>
              </div>
              <div className="mt-2 pl-8"><RecordDeltaChips record={record} /></div>
            </div>
            <div className="flex items-center justify-end gap-2 text-xs font-semibold text-primary">
              {busyId === record.recordId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
              查看内容
              <ChevronRight className="h-4 w-4" />
            </div>
          </button>
        )
      })}
    </div>
  )
}

export function NegativePatrolOverview({
  data,
  onOpen,
}: {
  data: Record<string, unknown> | null | undefined
  onOpen?: () => void
}) {
  const patrol = normalizePatrol(data)
  const summary = patrol?.summary
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-rose-600">Negative Patrol</div>
          <h3 className="mt-1 flex items-center gap-2 text-sm font-bold">
            <ShieldAlert className="h-4 w-4 text-rose-600" />
            舆情巡查
          </h3>
        </div>
        <Button size="sm" variant="outline" onClick={onOpen}>
          查看巡查
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
      {!summary ? (
        <div className="flex flex-wrap items-center justify-between gap-3 p-5 text-[12px] text-muted-foreground">
          <span>尚无巡查快照。开始巡查后，这里会展示负面声量与互动变化。</span>
          <StatusPill tone="muted">等待数据</StatusPill>
        </div>
      ) : (
        <div className="grid divide-y divide-border sm:grid-cols-4 sm:divide-x sm:divide-y-0">
          <CompactMetric label="负面内容声量" value={formatNumber(summary.volume)} />
          <CompactMetric label="互动净增" value={signed(summary.interactionDelta)} pending={summary.interactionDelta === null} />
          <CompactMetric label="不可访问" value={formatNumber(summary.unavailableCurrent)} />
          <CompactMetric
            label="待形成基线"
            value={formatNumber(summary.unmeasuredRecords)}
            hint={summary.unmeasuredRecords > 0 ? '下一轮起产生增量' : '基线完整'}
          />
        </div>
      )}
    </section>
  )
}

function CompactMetric({
  label,
  value,
  hint,
  pending = false,
}: {
  label: string
  value: string
  hint?: string
  pending?: boolean
}) {
  return (
    <div className="min-w-0 px-5 py-4">
      <div className="text-[11px] font-semibold text-muted-foreground">{label}</div>
      <div className={cn('mt-1 truncate text-xl font-black tabular-nums', pending ? 'text-amber-600' : 'text-foreground')}>{value}</div>
      {hint && <div className="mt-1 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

export function NegativePatrolTab() {
  const { canWrite } = useAuth()
  const { navigate } = useNav()
  const [range, setRange] = useState<RangePreset>('7d')
  const [start, setStart] = useState(inputDate(-6))
  const [end, setEnd] = useState(inputDate())
  const [platform, setPlatform] = useState('')
  const [status, setStatus] = useState('')
  const [data, setData] = useState<PatrolData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [drawerRecord, setDrawerRecord] = useState<Record<string, unknown> | null>(null)
  const [drawerBusyId, setDrawerBusyId] = useState('')

  const load = useCallback(() => Promise.resolve().then(async () => {
    setLoading(true)
    setError('')
    const bounds = dateBounds(range, start, end)
    try {
      const params = new URLSearchParams({
        periodStart: bounds.periodStart,
        periodEnd: bounds.periodEnd,
      })
      if (platform) params.set('platform', platform)
      if (status) params.set('status', status)
      const response = await api.get<Record<string, unknown>>(`/capture-cloud/negative-patrol/analytics?${params}`)
      const patrol = normalizePatrol((response.negativePatrol || response) as Record<string, unknown>)
      if (!patrol) throw new Error('巡查分析响应缺少数据')
      setData(patrol)
    } catch (directError) {
      if (platform || status) {
        setData(null)
        setError(directError instanceof Error ? directError.message : '舆情巡查筛选加载失败')
        return
      }
      try {
        const fallback = new URLSearchParams({
          range: 'custom',
          start: bounds.from,
          end: bounds.to,
        })
        const dashboard = await api.get<Record<string, unknown>>(`/analytics/dashboard?${fallback}`)
        const snapshot = dashboard.snapshot as Record<string, unknown> | undefined
        const patrol = normalizePatrol(snapshot?.negativePatrol as Record<string, unknown> | undefined)
        if (!patrol) throw directError
        setData(patrol)
      } catch {
        setData(null)
        setError(directError instanceof Error ? directError.message : '舆情巡查加载失败')
      }
    } finally {
      setLoading(false)
    }
  }), [range, start, end, platform, status])

  useEffect(() => { void load() }, [load])

  const filteredRecords = useMemo(() => {
    return (data?.risingRecords || [])
      .filter(record => !platform || record.platform === platform)
      .filter(record => matchesStatus(record, status))
      .sort((a, b) => (recordInteractionDelta(b) ?? -1) - (recordInteractionDelta(a) ?? -1))
  }, [data, platform, status])

  const openRecord = async (recordId: string) => {
    if (!recordId || drawerBusyId) return
    setDrawerBusyId(recordId)
    try {
      const response = await api.get<{ record?: Record<string, unknown> }>(`/opinion-analysis/records/${recordId}/detail`)
      if (response.record) setDrawerRecord(response.record)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '打开原帖详情失败')
    } finally {
      setDrawerBusyId('')
    }
  }

  const summary = data?.summary
  const period = dateBounds(range, start, end)

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-5 duration-300">
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-rose-600">
              <ShieldAlert className="h-4 w-4" />
              Negative Patrol
            </div>
            <h2 className="mt-2 text-2xl font-bold tracking-normal text-foreground">舆情巡查</h2>
            <p className="mt-2 max-w-2xl text-[12px] leading-5 text-muted-foreground">
              追踪负面内容声量、互动变化与可访问状态。互动增量来自相邻巡查快照，首轮只建立基线，不会以 0 冒充变化。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            刷新
          </Button>
        </div>
        <div className="border-t border-border px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap rounded-lg border border-border bg-muted p-1">
              {RANGE_OPTIONS.map(option => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setRange(option.id)}
                  className={cn(
                    'h-8 rounded-md px-3 text-xs font-semibold transition',
                    range === option.id ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <WorkbenchSelect value={platform} onChange={event => setPlatform(event.target.value)} aria-label="平台筛选">
              {PLATFORM_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </WorkbenchSelect>
            <WorkbenchSelect value={status} onChange={event => setStatus(event.target.value)} aria-label="巡查状态筛选">
              {STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </WorkbenchSelect>
            <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              {period.from} 至 {period.to}
            </span>
          </div>
          {range === 'custom' && (
            <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
              <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">
                开始日期
                <Input type="date" className="w-[170px]" value={start} max={end} onChange={event => setStart(event.target.value)} />
              </label>
              <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">
                结束日期
                <Input type="date" className="w-[170px]" value={end} min={start} onChange={event => setEnd(event.target.value)} />
              </label>
            </div>
          )}
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !summary ? (
        <PatrolPanel title="暂无巡查数据" eyebrow="Baseline">
          <EmptyState icon={ShieldAlert} title="尚未形成舆情巡查快照" description="完成一次负面巡查后，这里会开始记录声量；第二轮起展示真实互动变化。" />
        </PatrolPanel>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <MetricCard label="巡查负面声量" value={formatNumber(summary.volume)} detail={`跟踪 ${formatNumber(summary.trackedRecords)} 条内容`} icon={ShieldAlert} tone="red" />
            <MetricCard label="新增负面" value={summary.newNegative === null ? '—' : formatNumber(summary.newNegative)} detail={summary.newNegative === null ? '当前接口未提供新增口径' : '本周期首次进入巡查'} icon={Sparkles} tone="amber" />
            <MetricCard label="互动净增" value={signed(summary.interactionDelta)} detail={summary.interactionDelta === null ? '首轮快照只建立基线' : `${formatNumber(summary.measuredRecords)} 条已有对比`} icon={TrendingUp} tone="purple" />
            <MetricCard label="已删除或不可访问" value={formatNumber(summary.unavailableCurrent)} detail="巡查时无法再打开的内容" icon={CircleOff} tone="grey" />
            <MetricCard label="高风险" value={summary.highRisk === null ? '—' : formatNumber(summary.highRisk)} detail={summary.highRisk === null ? '等待风险分级数据' : '建议优先人工复核'} icon={AlertTriangle} tone="red" />
          </section>

          {summary.unmeasuredRecords > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
              <span>
                有 <strong>{formatNumber(summary.unmeasuredRecords)}</strong> 条内容刚建立基线，暂不计入互动增量。
              </span>
              <StatusPill tone="pending">下一轮起可比较</StatusPill>
            </div>
          )}

          <section className="grid gap-4 xl:grid-cols-2">
            <PatrolPanel title="负面声量趋势" eyebrow="Volume">
              <NegativeVolumeChart rows={data.trend} />
            </PatrolPanel>
            <PatrolPanel title="互动增量趋势" eyebrow="Acceleration">
              <InteractionTrendChart rows={data.trend} />
            </PatrolPanel>
          </section>

          <PatrolPanel
            title="升温负面内容"
            eyebrow="Rising Content"
            action={<StatusPill tone="negative">{filteredRecords.length} 条</StatusPill>}
          >
            <RisingRecords rows={filteredRecords} onOpen={openRecord} busyId={drawerBusyId} />
          </PatrolPanel>
        </>
      )}

      {drawerRecord && (
        <RecordDrawer
          record={drawerRecord}
          onClose={() => setDrawerRecord(null)}
          canWrite={canWrite()}
          onLinkIssue={() => {
            setDrawerRecord(null)
            navigate('workbench', { queue: 'triage' })
          }}
        />
      )}
    </div>
  )
}
