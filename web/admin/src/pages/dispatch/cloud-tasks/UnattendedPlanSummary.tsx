import { Loader2, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { UnattendedPlan } from './lib'
import {
  PLAN_MODE_LABELS,
  PLATFORM_LABELS,
  PUBLISH_TIME_OPTIONS,
  SORT_OPTIONS,
  STATUS_LABELS,
  formatTime,
  hasConfiguredUnattendedPlan,
  isUnattendedPlanEnded,
  safeNumber,
  unattendedPlanDates,
} from './lib'

export function UnattendedPlanSummary({
  plan,
  mirroredAt,
  title = '本地无人值守计划',
  onEdit,
  editDisabled = false,
  editTitle,
  onDelete,
  deleteDisabled = false,
  deleteTitle,
  deleting = false,
}: {
  plan?: UnattendedPlan | null
  mirroredAt?: string | null
  title?: string
  onEdit?: () => void
  editDisabled?: boolean
  editTitle?: string
  onDelete?: () => void
  deleteDisabled?: boolean
  deleteTitle?: string
  deleting?: boolean
}) {
  if (!plan) {
    return (
      <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-2.5">
        <div className="text-xs font-semibold text-foreground">{title}</div>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">该 Agent 尚未上报本地计划。</p>
      </div>
    )
  }

  const keywords = Array.isArray(plan.keywords)
    ? plan.keywords.map(value => String(value || '').trim()).filter(Boolean)
    : []
  const keywordCount = Math.max(keywords.length, safeNumber(plan.keywordCount))
  // 旧后端归一化可能没有保留 configured；本地计划只要有更新时间、
  // 已启用或含关键词，就可判定为真实配置，而空镜像应显示“尚未配置”。
  const configured = hasConfiguredUnattendedPlan(plan)
  const ended = isUnattendedPlanEnded(plan)
  const customDates = unattendedPlanDates(plan)
  const maxRounds = Math.max(1, safeNumber(plan.maxRounds) || 1)
  const roundGapMin = safeNumber(plan.roundGapMin)
  const mode = PLAN_MODE_LABELS[String(plan.mode || '')] || String(plan.mode || '本地设置')
  const sortLabel = SORT_OPTIONS.find(option => option.value === plan.searchFilters?.sort)?.label || '综合排序'
  const publishTimeLabel = PUBLISH_TIME_OPTIONS.find(option => option.value === plan.searchFilters?.publishTime)?.label || '不限时间'
  const lastRunStatus = STATUS_LABELS[String(plan.lastRunStatus || '')] || String(plan.lastRunStatus || '')
  const captureSettings = plan.captureSettings
  const keywordMaxDetectedItems = Number(plan.keywordMaxDetectedItems)
  const hasKeywordMaxDetectedItems = Number.isSafeInteger(keywordMaxDetectedItems) && keywordMaxDetectedItems > 0
  const enhancementItems = captureSettings?.autoDetailCaptureAfterListCapture
    ? [
        captureSettings.autoSyncAfterDetailCapture ? '自动同步' : '',
        captureSettings.enableAiRelevancePrefilter ? 'AI 筛选' : '',
        captureSettings.includeBloggerMetricsOnDetailCapture ? '博主数据' : '',
        captureSettings.enableLowFollowerHitFilterOnDetailCapture
          ? `低粉爆款（≤ ${safeNumber(captureSettings.lowFollowerHitThresholdOnDetailCapture).toLocaleString('zh-CN')} 粉）`
          : '',
        captureSettings.includeCommentsOnDetailCapture
          ? `评论 ${Math.max(1, safeNumber(captureSettings.detailCommentsMaxDetectedItems) || 50)} 条`
          : '',
        captureSettings.enableCommentLeadsFilterOnDetailCapture ? '评论客资筛选' : '',
        captureSettings.skipAlreadyCapturedOnDetailCapture ? '跳过已增强' : '',
      ].filter(Boolean)
    : []
  const stateLabel = deleting
    ? '删除中'
    : !configured
      ? '尚未配置'
      : ended
        ? '已结束'
        : plan.enabled
          ? '已启用'
          : '未启用'
  const stateClassName = deleting
    ? 'bg-primary/10 text-primary'
    : plan.enabled && !ended
      ? 'bg-status-green/10 text-status-green'
      : 'bg-muted text-muted-foreground'

  return (
    <div className="mt-3 rounded-lg border border-border/70 bg-card/70 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-foreground">{title}</div>
        <div className="flex items-center gap-1.5">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${stateClassName}`}>
            {stateLabel}
          </span>
          {onEdit && (
            <span title={editTitle}>
              <Button variant="ghost" size="sm" onClick={onEdit} disabled={editDisabled} className="h-7 px-2 text-[11px]">
                <Pencil className="h-3 w-3" /> 编辑
              </Button>
            </span>
          )}
          {onDelete && (
            <span title={deleteTitle}>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                disabled={deleteDisabled || deleting}
                className="h-7 px-2 text-[11px] text-status-red hover:bg-status-red/8 hover:text-status-red"
              >
                {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                {deleting ? '删除中' : '删除'}
              </Button>
            </span>
          )}
        </div>
      </div>
      <div className="mt-2 grid gap-x-3 gap-y-1 text-[11px] leading-4 text-muted-foreground sm:grid-cols-2">
        <div>平台：<span className="text-foreground">{PLATFORM_LABELS[plan.platform || 'unknown'] || plan.platform || '未设置'}</span></div>
        <div>关键词：<span className="text-foreground">{keywordCount} 个</span></div>
        <div>执行：<span className="text-foreground">{ended ? `${mode} · 已结束` : plan.enabled ? `${mode}${plan.startTime ? ` · ${plan.startTime}` : ''}` : '当前不自动执行'}</span></div>
        <div>循环：<span className="text-foreground">{maxRounds} 轮{maxRounds > 1 ? ` · 间隔 ${roundGapMin} 分钟` : ''}</span></div>
        {customDates.length > 0 && (
          <div className="sm:col-span-2">
            运行日期：<span className="text-foreground">{customDates.join('、')}</span>
          </div>
        )}
        <div>排序：<span className="text-foreground">{sortLabel}</span></div>
        <div>时间：<span className="text-foreground">{publishTimeLabel}</span></div>
        <div className="sm:col-span-2">采集数量：<span className="text-foreground">{hasKeywordMaxDetectedItems ? `每个关键词最多 ${keywordMaxDetectedItems} 条` : '每词上限使用设备本地设置'}</span></div>
        <div>下次运行：<span className="text-foreground">{ended ? '无后续排期' : formatTime(plan.nextRunAt)}</span></div>
        <div>上次运行：<span className="text-foreground">{formatTime(plan.lastRunAt)}{lastRunStatus ? ` · ${lastRunStatus}` : ''}</span></div>
        {captureSettings && (
          <div className="sm:col-span-2">采集增强：<span className="text-foreground">{captureSettings.autoDetailCaptureAfterListCapture ? enhancementItems.join(' · ') || '已开启' : '未开启'}</span></div>
        )}
        <div className="sm:col-span-2">计划同步：<span className="text-foreground">{formatTime(mirroredAt || plan.updatedAt)}</span></div>
      </div>
      {keywords.length > 0 && (
        <div className="mt-2">
          <div className="mb-1.5 text-[11px] text-muted-foreground">关键词列表</div>
          <div className="flex flex-wrap gap-1.5">
          {keywords.map(keyword => (
            <span key={keyword} className="max-w-full truncate rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground">{keyword}</span>
          ))}
          </div>
        </div>
      )}
    </div>
  )
}
