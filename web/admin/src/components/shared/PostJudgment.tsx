import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
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

function filterTriggerClass(header: boolean, active: boolean) {
  return cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/20 max-w-full min-w-0',
    header ? 'h-7 px-1.5 text-[11px]' : 'h-10 bg-muted px-3 text-[12px] lg:h-8',
    active ? 'text-primary' : 'text-muted-foreground')
}

export function PostIntentFilter({ value, onChange, header = false }: {
  value: string[]
  onChange: (value: string[]) => void
  header?: boolean
}) {
  const labels = POST_INTENT_OPTIONS.filter(option => value.includes(option.value)).map(option => option.label)
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" aria-label={`意图筛选，${labels.join('、') || '全部意图'}`} title={labels.join('、') || '全部意图'} className={filterTriggerClass(header, labels.length > 0)}>
        <span className="truncate">{postFilterSummary(labels, header ? '意图' : '全部意图')}</span><ChevronDown className="h-3 w-3 shrink-0" />
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

export function PostRelevanceFilter({ value, confidence, onChange, onConfidenceChange, header = false }: {
  value: string[]
  confidence: string[]
  onChange: (value: string[]) => void
  onConfidenceChange: (value: string[]) => void
  header?: boolean
}) {
  const labels = [...POST_RELEVANCE_OPTIONS.filter(option => value.includes(option.value)).map(option => option.label),
    ...POST_CONFIDENCE_OPTIONS.filter(option => confidence.includes(option.value)).map(option => option.shortLabel)]
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" aria-label={`相关性筛选，${labels.join('、') || '不限'}`} title={labels.join('、') || '相关性'} className={filterTriggerClass(header, labels.length > 0)}>
        <span className="truncate">{postFilterSummary(labels, '相关性')}</span><ChevronDown className="h-3 w-3 shrink-0" />
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

export function PostRelevanceBadge({ record }: { record: unknown }) {
  const judgment = postJudgment(record)
  return <span className="inline-flex flex-col items-start gap-1 whitespace-nowrap" title={judgment.relevanceReason || '打开详情查看判断依据'}><StatusPill tone={judgment.relevanceTone}>{judgment.relevanceLabel}</StatusPill>{(judgment.manual || judgment.relevance) && <span className="text-[10px] leading-4 text-muted-foreground">{judgment.manual ? '人工判断' : judgment.confidence !== null ? `置信度${judgment.confidence}%` : '暂无评分'}</span>}</span>
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
