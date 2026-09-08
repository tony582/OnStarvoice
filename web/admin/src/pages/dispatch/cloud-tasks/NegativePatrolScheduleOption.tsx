export function NegativePatrolScheduleOption({checked, disabled = false, onChange}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-primary/20 bg-primary/[0.035] px-3 py-3">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
      <span>
        <span className="block text-xs font-semibold text-foreground">同时巡查近7天负面内容</span>
        <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">每轮按帖子发布时间选取此前 7 天的负面内容。关键词采集优先，节点空闲后逐篇接续；沿用现有处理状态，不重新打开已处理事项。</span>
      </span>
    </label>
  )
}
