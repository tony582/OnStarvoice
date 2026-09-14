import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ALL_POST_INTENTS, POST_INTENT_OPTIONS, postJudgment } from '@/lib/post-judgment'
import { StatusPill } from '@/components/ui/badge'

export function PostIntentFilter({ value, onChange, header = false }: {
  value: string[]
  onChange: (value: string[]) => void
  header?: boolean
}) {
  const allSelected = ALL_POST_INTENTS.every(intent => value.includes(intent))
  const selected = value
  const toggle = (next: string) => {
    const updated = selected.includes(next) ? selected.filter(item => item !== next) : [...selected, next]
    onChange(updated)
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={`意图筛选，${allSelected ? '全部' : `已选${value.length}项`}`}
          className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/20',
            header ? 'h-7 px-1.5 text-[11px]' : 'h-10 bg-muted px-3 text-[12px] lg:h-8',
            allSelected ? 'text-muted-foreground' : 'text-primary')}>
          意图{!allSelected && <span className="rounded bg-primary/15 px-1 text-[10px]">{value.length}</span>}<ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align={header ? 'end' : 'start'} sideOffset={5} collisionPadding={10}
          className="z-[100] min-w-44 rounded-lg border border-border bg-card p-1.5 text-foreground shadow-lg">
          <DropdownMenu.CheckboxItem checked={allSelected ? true : value.length ? 'indeterminate' : false}
            onCheckedChange={() => onChange(allSelected ? [] : [...ALL_POST_INTENTS])} onSelect={event => event.preventDefault()}
            className="flex min-h-10 cursor-default select-none items-center gap-2 rounded-md px-2.5 text-[12px] outline-none data-[highlighted]:bg-accent lg:min-h-8">
            <span className="flex-1">全选</span><span className="flex h-4 w-4 items-center justify-center rounded border border-border"><DropdownMenu.ItemIndicator>{allSelected ? <Check className="h-3 w-3 text-primary" /> : <Minus className="h-3 w-3 text-primary" />}</DropdownMenu.ItemIndicator></span>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {POST_INTENT_OPTIONS.map(option => (
            <DropdownMenu.CheckboxItem key={option.value} checked={selected.includes(option.value)}
              onCheckedChange={() => toggle(option.value)} onSelect={event => event.preventDefault()}
              className="flex min-h-10 cursor-default select-none items-center gap-2 rounded-md px-2.5 text-[12px] outline-none data-[highlighted]:bg-accent lg:min-h-8">
              <span className="flex-1">{option.label}</span><span className="flex h-4 w-4 items-center justify-center rounded border border-border"><DropdownMenu.ItemIndicator><Check className="h-3 w-3 text-primary" /></DropdownMenu.ItemIndicator></span>
            </DropdownMenu.CheckboxItem>
          ))}
          <p className="px-2.5 pt-1 text-[10px] leading-4 text-muted-foreground">{value.length ? '全部意图包含尚未判断的内容' : '未勾选意图，当前不显示任何内容'}</p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function PostIntentBadge({ record }: { record: unknown }) {
  return <StatusPill tone="neutral">{postJudgment(record).intentLabel}</StatusPill>
}

export function PostRelevanceBadge({ record }: { record: unknown }) {
  const judgment = postJudgment(record)
  return <span title={judgment.relevanceReason || '打开详情查看判断依据'}><StatusPill tone={judgment.relevanceTone}>{judgment.relevanceLabel}</StatusPill></span>
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
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">相关度</span><PostRelevanceBadge record={record} />{judgment.manual && <span className="text-muted-foreground">人工核实</span>}</div>
        <p className="whitespace-pre-wrap text-muted-foreground">{judgment.relevanceReason || '暂无相关度判断依据'}</p>
        {monitoringReason && <p className="whitespace-pre-wrap text-muted-foreground">{monitoringReason}</p>}
        {!judgment.manual && judgment.confidence !== null && <p className="text-[11px] text-muted-foreground">AI 判断置信度：{judgment.confidence}%（表示判断把握程度）</p>}
      </div>
      {judgment.evidence.length > 0 && <div className="space-y-2"><h5 className="text-[12px] font-medium">主帖证据</h5>{judgment.evidence.map((item, index) => <blockquote key={`${item.source}-${index}`} className="border-l-2 border-border pl-3 text-[12px] leading-5"><div className="mb-0.5 text-[11px] text-muted-foreground">{item.sourceLabel}{item.entity && ` · ${item.entity}`}</div><p className="whitespace-pre-wrap break-words">{item.quote}</p></blockquote>)}</div>}
    </section>
  )
}
