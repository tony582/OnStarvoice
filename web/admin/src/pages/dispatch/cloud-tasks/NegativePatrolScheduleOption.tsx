import { DEFAULT_NEGATIVE_PATROL_STATUSES, NEGATIVE_PATROL_STATUS_OPTIONS, validNegativePatrolStatuses } from './unattendedNegativePatrol.mjs'

export function NegativePatrolScheduleOption({checked, disabled = false, onChange, triageStatuses = DEFAULT_NEGATIVE_PATROL_STATUSES, onStatusesChange}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  triageStatuses?: string[]
  onStatusesChange?: (statuses: string[]) => void
}) {
  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.035] px-3 py-3">
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
        <span>
          <span className="block text-xs font-semibold text-foreground">同时巡查近7天负面内容</span>
          <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">每轮选取启动前 7 天首次采集入库的负面内容，复查不刷新起算时间。窗口内每轮可查，当天查过也可再次巡查。关键词采集优先，节点空闲后逐篇接续；保留现有处理状态。</span>
        </span>
      </label>
      {checked && onStatusesChange && <fieldset disabled={disabled} className="mt-3 border-t border-primary/15 pt-3">
        <legend className="px-1 text-xs font-semibold text-foreground">纳入巡查的处理状态</legend>
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span className="text-muted-foreground">已选 {triageStatuses.length} 项</span>
          <button type="button" onClick={() => onStatusesChange(NEGATIVE_PATROL_STATUS_OPTIONS.map(option => option.value))} className="text-primary disabled:opacity-50">全选</button>
          <button type="button" onClick={() => onStatusesChange([])} className="text-muted-foreground disabled:opacity-50">取消全选</button>
          <button type="button" onClick={() => onStatusesChange([...DEFAULT_NEGATIVE_PATROL_STATUSES])} className="text-primary disabled:opacity-50">恢复默认</button>
        </div>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {NEGATIVE_PATROL_STATUS_OPTIONS.map(option => <label key={option.value} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[11px] leading-4 hover:bg-card/70">
            <input type="checkbox" value={option.value} checked={triageStatuses.includes(option.value)} onChange={event => onStatusesChange(event.target.checked ? [...triageStatuses, option.value] : triageStatuses.filter(status => status !== option.value))} className="h-3.5 w-3.5 shrink-0 accent-primary" />
            <span>{option.label}</span>
          </label>)}
        </div>
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">默认不巡查“已复核-非监控内容”，需要时可勾选纳入。已删除或不可访问的内容仍会排除。</p>
        {!validNegativePatrolStatuses(triageStatuses) && <p role="alert" className="mt-1 text-[11px] leading-5 text-status-red">{triageStatuses.length === 0 ? '请至少选择一种处理状态；如不需要负面巡查，可关闭上方开关。' : '存在无法识别的处理状态，请恢复默认后重新选择。'}</p>}
      </fieldset>}
    </div>
  )
}
