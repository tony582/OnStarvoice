import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { filterTriggerClass as pillTriggerClass } from '@/lib/filter-trigger'
import { POST_INTENT_OPTIONS, POST_RELEVANCE_OPTIONS, POST_CONFIDENCE_OPTIONS, postFilterSummary, postJudgment } from '@/lib/post-judgment'
import { StatusPill } from '@/components/ui/badge'

const menuItemClass = 'flex min-h-10 cursor-default select-none items-center gap-2 rounded-md px-2.5 text-[12px] outline-none data-[highlighted]:bg-accent lg:min-h-8'

function FilterChoices({ options, value, onChange, resetLabel }: {
  options: readonly { value: string; label: string }[]
  value: string[]
  onChange: (value: string[]) => void
  resetLabel: string
}) {
  return <>
    <DropdownMenu.Item onSelect={event => { event.preventDefault(); onChange([]) }} className={menuItemClass}>
      <span className="flex-1">{resetLabel}</span>{value.length === 0 && <Check className="h-3 w-3 text-primary" />}
    </DropdownMenu.Item>
    {options.map(option => <DropdownMenu.CheckboxItem key={option.value} checked={value.includes(option.value)}
      onCheckedChange={() => onChange(value.includes(option.value) ? value.filter(item => item !== option.value) : [...value, option.value])}
      onSelect={event => event.preventDefault()} className={menuItemClass}>
      <span className="flex-1">{option.label}</span><span className="flex h-4 w-4 items-center justify-center rounded border border-border"><DropdownMenu.ItemIndicator><Check className="h-3 w-3 text-primary" /></DropdownMenu.ItemIndicator></span>
    </DropdownMenu.CheckboxItem>)}
  </>
}

// 表头内的紧凑触发器保留原样；筛选条里的 pill 与其它筛选共用 filterTriggerClass。
function filterTriggerClass(header: boolean, active: boolean, className?: string) {
  if (!header) return pillTriggerClass(active, className)
  return cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/20 max-w-full min-w-0',
    'h-7 px-1.5 text-[11px]',
    active ? 'text-primary' : 'text-muted-foreground',
    className)
}

export function PostIntentFilter({ value, onChange, header = false, className }: {
  value: string[]
  onChange: (value: string[]) => void
  header?: boolean
  className?: string
}) {
  const labels = POST_INTENT_OPTIONS.filter(option => value.includes(option.value)).map(option => option.label)
  const text = header
    ? postFilterSummary(labels, '意图')
    : labels.length ? `意图：${postFilterSummary(labels, '')}` : '意图'
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" aria-label={`意图筛选，${labels.join('、') || '全部意图'}`} title={labels.join('、') || '全部意图'} className={filterTriggerClass(header, labels.length > 0, className)}>
        <span className="truncate">{text}</span><ChevronDown className="h-3 w-3 shrink-0" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content align={header ? 'end' : 'start'} sideOffset={5} collisionPadding={10}
      className="z-[100] min-w-48 max-w-[calc(100vw-20px)] rounded-lg border border-border bg-card p-1.5 text-foreground shadow-lg">
      <DropdownMenu.Label className="px-2.5 py-1 text-[11px] text-muted-foreground">意图 · 可多选</DropdownMenu.Label>
      <FilterChoices options={POST_INTENT_OPTIONS} value={value} onChange={onChange} resetLabel="全部意图" />
      <p className="px-2.5 pt-1 text-[10px] leading-4 text-muted-foreground">未选择时不限意图，包含尚未判断的内容</p>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}

export function PostRelevanceFilter({ value, confidence, onChange, onConfidenceChange, header = false, className }: {
  value: string[]
  confidence: string[]
  onChange: (value: string[]) => void
  onConfidenceChange: (value: string[]) => void
  header?: boolean
  className?: string
}) {
  const labels = [...POST_RELEVANCE_OPTIONS.filter(option => value.includes(option.value)).map(option => option.label),
    ...POST_CONFIDENCE_OPTIONS.filter(option => confidence.includes(option.value)).map(option => option.shortLabel)]
  const text = header
    ? postFilterSummary(labels, '相关性')
    : labels.length ? `相关性：${postFilterSummary(labels, '')}` : '相关性'
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" aria-label={`相关性筛选，${labels.join('、') || '不限'}`} title={labels.join('、') || '相关性'} className={filterTriggerClass(header, labels.length > 0, className)}>
        <span className="truncate">{text}</span><ChevronDown className="h-3 w-3 shrink-0" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content align={header ? 'end' : 'start'} sideOffset={5} collisionPadding={10}
      className="z-[100] min-w-52 max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[calc(100vw-20px)] overflow-y-auto rounded-lg border border-border bg-card p-1.5 text-foreground shadow-lg">
      <DropdownMenu.Label className="px-2.5 py-1 text-[11px] text-muted-foreground">相关性 · 可多选</DropdownMenu.Label>
      <FilterChoices options={POST_RELEVANCE_OPTIONS} value={value} onChange={onChange} resetLabel="全部" />
      <DropdownMenu.Separator className="my-1 h-px bg-border" />
      <DropdownMenu.Label className="px-2.5 py-1 text-[11px] text-muted-foreground">置信度 · 可多选</DropdownMenu.Label>
      <FilterChoices options={POST_CONFIDENCE_OPTIONS} value={confidence} onChange={onConfidenceChange} resetLabel="不限" />
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}

export function PostIntentBadge({ record }: { record: unknown }) {
  return <StatusPill tone="neutral">{postJudgment(record).intentLabel}</StatusPill>
}

/**
 * 相关性胶囊。默认在胶囊下方另起一行显示置信度；compact 时把置信度并进胶囊，
 * 供列表等单行场景使用。
 */
export function PostRelevanceBadge({ record, compact = false }: { record: unknown; compact?: boolean }) {
  const judgment = postJudgment(record)
  const detail = judgment.manual
    ? '人工判断'
    : judgment.relevance
      ? judgment.confidence !== null ? `置信度${judgment.confidence}%` : '暂无评分'
      : ''
  const title = judgment.relevanceReason || '打开详情查看判断依据'
  if (compact) {
    const suffix = judgment.manual ? '人工' : judgment.relevance && judgment.confidence !== null ? `${judgment.confidence}%` : ''
    return (
      <StatusPill tone={judgment.relevanceTone} className="gap-1" >
        <span title={title}>{judgment.relevanceLabel}</span>
        {suffix && <span className="font-medium opacity-70" title={detail}>{suffix}</span>}
      </StatusPill>
    )
  }
  return <span className="inline-flex flex-col items-start gap-1 whitespace-nowrap" title={title}><StatusPill tone={judgment.relevanceTone}>{judgment.relevanceLabel}</StatusPill>{detail && <span className="text-[10px] leading-4 text-muted-foreground">{detail}</span>}</span>
}

export function PostJudgmentDetails({ record }: { record: unknown }) {
  const judgment = postJudgment(record)
  const monitoringReason = !judgment.manual ? judgment.monitoringReason : ''
  return (
    <section aria-label="内容判断依据" className="space-y-3 rounded-xl border border-border/70 bg-card p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[13px] font-semibold">判断依据</h4>
      </div>
      <p className="text-[11px] leading-5 text-muted-foreground">依据主帖标题、正文和可核验的媒体内容判断；评论区与采集关键词不作为主帖品牌或车型证据。</p>
      <div className="space-y-1 text-[12px] leading-5">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">意图</span><PostIntentBadge record={record} /></div>
        <p className="whitespace-pre-wrap text-muted-foreground">{judgment.intentReason || '暂无意图判断依据'}</p>
      </div>
      <div className="space-y-1 text-[12px] leading-5">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">相关性</span><PostRelevanceBadge record={record} /></div>
        <p className="whitespace-pre-wrap text-muted-foreground">{judgment.relevanceReason || '暂无相关性判断依据'}</p>
        {monitoringReason && <p className="whitespace-pre-wrap text-muted-foreground">{monitoringReason}</p>}
        {!judgment.manual && judgment.confidence !== null && <p className="text-[11px] text-muted-foreground">AI 判断置信度：{judgment.confidence}%。表示 AI 对当前相关性结论的自评把握，不代表相关程度或实际准确率。</p>}
      </div>
      {judgment.evidence.length > 0 && <div className="space-y-2"><h5 className="text-[12px] font-medium">主帖证据</h5>{judgment.evidence.map((item, index) => <blockquote key={`${item.source}-${index}`} className="border-l-2 border-border pl-3 text-[12px] leading-5"><div className="mb-0.5 text-[11px] text-muted-foreground">{item.sourceLabel}{item.entity && ` · ${item.entity}`}</div><p className="whitespace-pre-wrap break-words">{item.quote}</p></blockquote>)}</div>}
    </section>
  )
}
