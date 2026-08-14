import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, Pencil, Play, Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { CaptureEnhancementSettings, CloudAgent } from './lib'
import {
  PLATFORM_LABELS,
  PUBLISH_TIME_OPTIONS,
  SORT_OPTIONS,
  agentCreatePlatforms,
  hasConfiguredUnattendedPlan,
  normalizeCloudTaskDateList,
  safeNumber,
  shanghaiToday,
} from './lib'
import { ScheduledDatesPicker } from './ScheduledDatesPicker'

export function AgentTaskCreator({
  agent,
  writable,
  onCreated,
  initialExecutionMode = 'one_time',
  forceOpen = false,
  editExistingInitially = false,
  hideLauncher = false,
  lockExecutionMode = false,
}: {
  agent: CloudAgent
  writable: boolean
  onCreated: () => Promise<void>
  initialExecutionMode?: 'one_time' | 'unattended_plan'
  forceOpen?: boolean
  editExistingInitially?: boolean
  hideLauncher?: boolean
  lockExecutionMode?: boolean
}) {
  const remoteTaskCreate = agent.capabilities?.remoteTaskCreate === true
  const remoteUnattendedPlanWrite = agent.capabilities?.remoteUnattendedPlanWrite === true
  const remoteTaskEnhancementOptions = agent.capabilities?.remoteTaskEnhancementOptions === true
  const remoteTaskKeywordPostLimit = agent.capabilities?.remoteTaskKeywordPostLimit === true
  const availablePlatforms = useMemo(() => agentCreatePlatforms(agent), [agent])
  const [open, setOpen] = useState(forceOpen)
  const [executionMode, setExecutionMode] = useState<'one_time' | 'unattended_plan'>(initialExecutionMode)
  const [taskTitle, setTaskTitle] = useState('')
  const [platform, setPlatform] = useState(availablePlatforms[0] || '')
  const [keywordText, setKeywordText] = useState('')
  const [sort, setSort] = useState('comprehensive')
  const [publishTime, setPublishTime] = useState('all')
  const [maxRounds, setMaxRounds] = useState(1)
  const [roundGapMin, setRoundGapMin] = useState(10)
  const [planMode, setPlanMode] = useState<'daily' | 'custom_dates'>('daily')
  const [startTime, setStartTime] = useState('09:00')
  const [randomOffsetMin, setRandomOffsetMin] = useState(20)
  const [customDates, setCustomDates] = useState('')
  const [keywordMaxDetectedItems, setKeywordMaxDetectedItems] = useState(50)
  const [keywordLimitOverrideEnabled, setKeywordLimitOverrideEnabled] = useState(true)
  const [enhancementEnabled, setEnhancementEnabled] = useState(false)
  const [captureSettingsOverrideEnabled, setCaptureSettingsOverrideEnabled] = useState(true)
  const [autoSyncAfterEnhancement, setAutoSyncAfterEnhancement] = useState(false)
  const [aiRelevancePrefilter, setAiRelevancePrefilter] = useState(false)
  const [includeBloggerMetrics, setIncludeBloggerMetrics] = useState(false)
  const [lowFollowerHitFilter, setLowFollowerHitFilter] = useState(false)
  const [lowFollowerHitThreshold, setLowFollowerHitThreshold] = useState(10_000)
  const [includeComments, setIncludeComments] = useState(false)
  const [commentLimit, setCommentLimit] = useState(50)
  const [commentLeadsFilter, setCommentLeadsFilter] = useState(false)
  const [skipAlreadyEnhanced, setSkipAlreadyEnhanced] = useState(true)
  const [editingExistingPlan, setEditingExistingPlan] = useState(false)
  const [keywordLimitDefaultedFromLegacyPlan, setKeywordLimitDefaultedFromLegacyPlan] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const pendingSubmission = useRef<{ fingerprint: string; requestKey: string } | null>(null)
  const selectedPlatform = availablePlatforms.includes(platform)
    ? platform
    : availablePlatforms[0] || ''
  const selectedSort = selectedPlatform !== 'xiaohongshu' && ['comments', 'collects'].includes(sort)
    ? 'comprehensive'
    : sort
  const existingPlan = agent.unattended_plan
  const hasExistingPlan = hasConfiguredUnattendedPlan(existingPlan)

  const resetNewTaskForm = () => {
    setExecutionMode('one_time')
    setTaskTitle('')
    setPlatform(availablePlatforms[0] || '')
    setKeywordText('')
    setSort('comprehensive')
    setPublishTime('all')
    setMaxRounds(1)
    setRoundGapMin(10)
    setPlanMode('daily')
    setStartTime('09:00')
    setRandomOffsetMin(20)
    setCustomDates('')
    setKeywordMaxDetectedItems(50)
    setKeywordLimitOverrideEnabled(true)
    setEnhancementEnabled(false)
    setCaptureSettingsOverrideEnabled(true)
    setAutoSyncAfterEnhancement(false)
    setAiRelevancePrefilter(false)
    setIncludeBloggerMetrics(false)
    setLowFollowerHitFilter(false)
    setLowFollowerHitThreshold(10_000)
    setIncludeComments(false)
    setCommentLimit(50)
    setCommentLeadsFilter(false)
    setSkipAlreadyEnhanced(true)
    setEditingExistingPlan(false)
    setKeywordLimitDefaultedFromLegacyPlan(false)
    setError('')
    setFeedback('')
    pendingSubmission.current = null
  }

  const toggleNewTaskForm = () => {
    if (open && !editingExistingPlan) {
      setOpen(false)
      return
    }
    resetNewTaskForm()
    setOpen(true)
  }

  const editUnattendedPlan = () => {
    if (open && editingExistingPlan) {
      setOpen(false)
      return
    }
    if (!existingPlan || !hasExistingPlan) return
    const captureSettings = existingPlan.captureSettings
    const hasConfiguredCaptureSettings = Boolean(captureSettings && Object.keys(captureSettings).length > 0)
    const configuredLimit = Number(existingPlan.keywordMaxDetectedItems)
    const hasConfiguredLimit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
    const configuredMode = existingPlan.mode === 'custom_dates' ? 'custom_dates' : 'daily'
    const configuredStartTime = /^\d{2}:\d{2}$/.test(String(existingPlan.startTime || ''))
      ? String(existingPlan.startTime)
      : '09:00'

    setExecutionMode('unattended_plan')
    setPlatform(availablePlatforms.includes(String(existingPlan.platform || ''))
      ? String(existingPlan.platform)
      : availablePlatforms[0] || '')
    setKeywordText(Array.isArray(existingPlan.keywords)
      ? existingPlan.keywords.map(value => String(value || '').trim()).filter(Boolean).join('\n')
      : '')
    setSort(SORT_OPTIONS.some(option => option.value === existingPlan.searchFilters?.sort)
      ? String(existingPlan.searchFilters?.sort)
      : 'comprehensive')
    setPublishTime(PUBLISH_TIME_OPTIONS.some(option => option.value === existingPlan.searchFilters?.publishTime)
      ? String(existingPlan.searchFilters?.publishTime)
      : 'all')
    setMaxRounds(Math.max(1, safeNumber(existingPlan.maxRounds) || 1))
    setRoundGapMin(existingPlan.roundGapMin === undefined ? 10 : safeNumber(existingPlan.roundGapMin))
    setPlanMode(configuredMode)
    setStartTime(configuredStartTime)
    setRandomOffsetMin(existingPlan.randomOffsetMin === undefined ? 20 : safeNumber(existingPlan.randomOffsetMin))
    setCustomDates(String(existingPlan.customDates || ''))
    setKeywordMaxDetectedItems(hasConfiguredLimit ? configuredLimit : 50)
    setKeywordLimitOverrideEnabled(hasConfiguredLimit)
    setKeywordLimitDefaultedFromLegacyPlan(!hasConfiguredLimit)
    setEnhancementEnabled(captureSettings?.autoDetailCaptureAfterListCapture === true)
    setCaptureSettingsOverrideEnabled(hasConfiguredCaptureSettings)
    setAutoSyncAfterEnhancement(captureSettings?.autoSyncAfterDetailCapture === true)
    setAiRelevancePrefilter(captureSettings?.enableAiRelevancePrefilter === true)
    setIncludeBloggerMetrics(captureSettings?.includeBloggerMetricsOnDetailCapture === true)
    setLowFollowerHitFilter(captureSettings?.enableLowFollowerHitFilterOnDetailCapture === true)
    setLowFollowerHitThreshold(Number.isInteger(captureSettings?.lowFollowerHitThresholdOnDetailCapture)
      ? Math.max(0, Number(captureSettings?.lowFollowerHitThresholdOnDetailCapture))
      : 10_000)
    setIncludeComments(captureSettings?.includeCommentsOnDetailCapture === true)
    setCommentLimit(Number.isInteger(captureSettings?.detailCommentsMaxDetectedItems) && Number(captureSettings?.detailCommentsMaxDetectedItems) >= 1
      ? Number(captureSettings?.detailCommentsMaxDetectedItems)
      : 50)
    setCommentLeadsFilter(captureSettings?.enableCommentLeadsFilterOnDetailCapture === true)
    setSkipAlreadyEnhanced(captureSettings?.skipAlreadyCapturedOnDetailCapture ?? true)
    setEditingExistingPlan(true)
    setError('')
    setFeedback('')
    pendingSubmission.current = null
    setOpen(true)
  }

  /* eslint-disable react-hooks/set-state-in-effect -- 抽屉按 agent/mode key 重新挂载时，需要用设备镜像一次性回填受控表单。 */
  useEffect(() => {
    if (!forceOpen) return
    if (editExistingInitially) {
      editUnattendedPlan()
      return
    }
    resetNewTaskForm()
    setExecutionMode(initialExecutionMode)
    setOpen(true)
    // 该表单由抽屉通过 key 控制生命周期；这里只在目标节点或入口模式变化时初始化一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, editExistingInitially, forceOpen, initialExecutionMode])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!remoteTaskCreate) {
    return (
      <div className="mt-3 rounded-lg border border-status-orange/25 bg-status-orange/8 px-3 py-2.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
        当前扩展版本不支持云端新建任务，请升级扩展。
      </div>
    )
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setFeedback('')
    const keywordLines = keywordText.split(/\r?\n/g).map(value => value.trim()).filter(Boolean)
    const keywords = Array.from(new Set(keywordLines))
    if (!selectedPlatform) {
      setError('该 Agent 没有可执行的平台，请先完成 Agent 配置。')
      return
    }
    if (keywordLines.length < 1 || keywordLines.length > 30) {
      setError('请输入 1–30 个关键词，每行一个。')
      return
    }
    if (
      remoteTaskKeywordPostLimit &&
      keywordLimitOverrideEnabled &&
      (!Number.isSafeInteger(keywordMaxDetectedItems) || keywordMaxDetectedItems < 1)
    ) {
      setError('每个关键词最多采集帖子数必须是大于等于 1 的整数。')
      return
    }
    if (!Number.isInteger(maxRounds) || maxRounds < 1) {
      setError('执行轮数必须是大于等于 1 的整数。')
      return
    }
    if (!Number.isInteger(roundGapMin) || roundGapMin < 0) {
      setError('轮次间隔必须是大于等于 0 的整数。')
      return
    }
    if (executionMode === 'unattended_plan' && !remoteUnattendedPlanWrite) {
      setError('当前扩展版本不支持从云端保存无人值守计划，请先更新扩展。')
      return
    }
    if (
      executionMode === 'unattended_plan' &&
      (!/^\d{2}:\d{2}$/.test(startTime) || !Number.isInteger(randomOffsetMin) || randomOffsetMin < 0)
    ) {
      setError('请检查无人值守计划的开始时间和随机偏移。')
      return
    }
    const { dates: normalizedDates, invalidDates } = normalizeCloudTaskDateList(customDates)
    if (
      executionMode === 'unattended_plan' &&
      planMode === 'custom_dates' &&
      (normalizedDates.length === 0 || invalidDates.length > 0)
    ) {
      setError(invalidDates.length > 0
        ? `旧计划中有无法识别的日期：${invalidDates.slice(0, 3).join('、')}。请删除后重新选择。`
        : '请至少选择一个运行日期。')
      return
    }
    if (executionMode === 'unattended_plan' && planMode === 'custom_dates') {
      if (!normalizedDates.some(date => date >= shanghaiToday())) {
        setError('指定日期中至少需要一个今天或未来的日期。')
        return
      }
      setCustomDates(normalizedDates.join('\n'))
    }
    if (
      remoteTaskEnhancementOptions &&
      captureSettingsOverrideEnabled &&
      enhancementEnabled &&
      includeBloggerMetrics &&
      lowFollowerHitFilter &&
      (!Number.isInteger(lowFollowerHitThreshold) || lowFollowerHitThreshold < 0)
    ) {
      setError('低粉爆款筛选的粉丝上限必须是大于等于 0 的整数。')
      return
    }
    if (
      remoteTaskEnhancementOptions &&
      captureSettingsOverrideEnabled &&
      enhancementEnabled &&
      includeComments &&
      (!Number.isInteger(commentLimit) || commentLimit < 1)
    ) {
      setError('评论加载上限必须是大于等于 1 的整数。')
      return
    }

    const captureSettings: CaptureEnhancementSettings | undefined = remoteTaskEnhancementOptions && captureSettingsOverrideEnabled
      ? {
          autoDetailCaptureAfterListCapture: enhancementEnabled,
          autoSyncAfterDetailCapture: enhancementEnabled && autoSyncAfterEnhancement,
          enableAiRelevancePrefilter: enhancementEnabled && aiRelevancePrefilter,
          includeBloggerMetricsOnDetailCapture: enhancementEnabled && includeBloggerMetrics,
          enableLowFollowerHitFilterOnDetailCapture:
            enhancementEnabled && includeBloggerMetrics && lowFollowerHitFilter,
          lowFollowerHitThresholdOnDetailCapture:
            Number.isInteger(lowFollowerHitThreshold) && lowFollowerHitThreshold >= 0
              ? lowFollowerHitThreshold
              : 10_000,
          includeCommentsOnDetailCapture: enhancementEnabled && includeComments,
          detailCommentsMaxDetectedItems:
            Number.isInteger(commentLimit) && commentLimit >= 1 ? commentLimit : 50,
          enableCommentLeadsFilterOnDetailCapture:
            enhancementEnabled && includeComments && commentLeadsFilter,
          skipAlreadyCapturedOnDetailCapture: enhancementEnabled && skipAlreadyEnhanced,
        }
      : undefined

    const taskInput = {
      ...(taskTitle.trim() ? { title: taskTitle.trim() } : {}),
      executionMode,
      platform: selectedPlatform,
      keywords,
      sort: selectedSort,
      publishTime,
      maxRounds: executionMode === 'unattended_plan' ? maxRounds : 1,
      roundGapMin: executionMode === 'unattended_plan' ? roundGapMin : 0,
      distributionMode: 'fixed_batch' as const,
      recoveryPolicy: {
        allowIdleAgentHandoff: false,
        platformSafetyMode: 'manual_confirmed',
      },
      ...(remoteTaskKeywordPostLimit && keywordLimitOverrideEnabled ? { keywordMaxDetectedItems } : {}),
      ...(captureSettings ? { captureSettings } : {}),
      ...(executionMode === 'unattended_plan' ? {
        enabled: true,
        mode: planMode,
        startTime,
        randomOffsetMin,
        customDates: planMode === 'custom_dates' ? normalizedDates.join('\n') : '',
      } : {}),
    }
    const fingerprint = JSON.stringify(taskInput)
    let submission = pendingSubmission.current
    if (submission?.fingerprint !== fingerprint) {
      submission = {
        fingerprint,
        requestKey: window.crypto.randomUUID(),
      }
      pendingSubmission.current = submission
    }
    const requestKey = submission.requestKey

    setSubmitting(true)
    try {
      const result = await api.post<{ message?: string }>(`/capture-cloud/agents/${agent.id}/tasks`, {
        ...taskInput,
        requestKey,
      })
      pendingSubmission.current = null
      setFeedback(result.message || (agent.online
        ? executionMode === 'unattended_plan'
          ? editingExistingPlan
            ? '无人值守计划修改已下发，等待设备覆盖保存。'
            : '无人值守计划已下发，等待设备保存。'
          : '一次性采集任务已创建，等待设备领取。'
        : executionMode === 'unattended_plan'
          ? editingExistingPlan
            ? '无人值守计划修改已排队，将在设备上线后覆盖保存。'
            : '无人值守计划已排队，将在设备上线后保存。'
          : '一次性采集任务已创建，将在设备上线后自动领取。'))
      if (!editingExistingPlan) setKeywordText('')
      await onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建关键词采集任务失败')
    } finally {
      setSubmitting(false)
    }
  }

  const disabled = submitting || !writable || agent.status !== 'active' || availablePlatforms.length === 0
  const nodeMessage = agent.status !== 'active'
    ? 'Agent 已暂停，恢复后才能接收新任务。'
    : agent.online
      ? 'Agent 在线，提交后会在下一次心跳领取任务。'
      : 'Agent 离线，任务会在云端排队，设备上线后自动领取。'

  return (
    <div className={hideLauncher ? '' : 'mt-3 border-t border-border/60 pt-3'}>
      {!hideLauncher && <div className="space-y-1.5">
        <button type="button" onClick={toggleNewTaskForm}
          className="flex min-h-8 w-full items-center justify-between gap-3 rounded-lg px-1 text-left text-xs font-semibold text-foreground hover:bg-muted/60">
          <span className="flex items-center gap-1.5"><Plus className="h-3.5 w-3.5 text-primary" />新建关键词采集任务</span>
          {open && !editingExistingPlan ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
        </button>
        {hasExistingPlan && (
          <button type="button" onClick={editUnattendedPlan}
            disabled={disabled || !remoteUnattendedPlanWrite}
            title={remoteUnattendedPlanWrite ? '载入当前计划并修改' : '需要更新扩展后才能修改无人值守计划'}
            className="flex min-h-9 w-full items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/[0.045] px-2.5 text-left text-xs font-semibold text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50">
            <span className="flex items-center gap-1.5"><Pencil className="h-3.5 w-3.5" />修改现有无人值守计划</span>
            {open && editingExistingPlan ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>}
      {open && (
        <form className={`${hideLauncher ? '' : 'mt-3'} space-y-4`} onSubmit={submit}>
          {editingExistingPlan && (
            <div className="rounded-lg border border-status-orange/30 bg-status-orange/8 px-3 py-2.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
              <div className="font-semibold">正在修改该设备的现有无人值守计划</div>
              <p className="mt-1">保存修改会覆盖当前设备计划，并在设备端重新启用；新建一次性任务不会改动这份计划。</p>
              <p className="mt-1">正在运行的任务继续使用启动时的旧快照；新配置从后续排期生效。</p>
            </div>
          )}
          <p className={`rounded-lg px-2.5 py-2 text-[11px] leading-4 ${agent.online && agent.status === 'active' ? 'bg-status-green/8 text-status-green' : 'bg-status-orange/8 text-amber-700 dark:text-amber-300'}`}>{nodeMessage}</p>
          {!writable && <p className="text-[11px] leading-4 text-muted-foreground">当前账号为只读权限，不能创建任务。</p>}
          <label className="block text-xs font-medium text-muted-foreground">
            任务名称（可选）
            <input value={taskTitle} onChange={event => setTaskTitle(event.target.value)} disabled={disabled}
              maxLength={120} placeholder={executionMode === 'unattended_plan' ? '例如：新能源竞品每日监测' : '例如：7 月新品口碑采集'}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary disabled:opacity-60" />
            <span className="mt-1.5 block text-[11px] leading-4 text-muted-foreground">用于在任务队列中快速识别；不填写时会自动生成名称。</span>
          </label>
          <div>
            <div className="text-xs font-medium text-muted-foreground">执行方式</div>
            <div className="mt-1.5 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="执行方式">
              <button type="button" role="tab" aria-selected={executionMode === 'one_time'}
                onClick={() => editingExistingPlan ? resetNewTaskForm() : setExecutionMode('one_time')} disabled={disabled || lockExecutionMode}
                className={`min-h-9 rounded-md px-3 text-xs font-semibold transition-colors ${executionMode === 'one_time' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                一次性
              </button>
              <button type="button" role="tab" aria-selected={executionMode === 'unattended_plan'}
                onClick={() => setExecutionMode('unattended_plan')} disabled={disabled || lockExecutionMode || !remoteUnattendedPlanWrite}
                title={remoteUnattendedPlanWrite ? '' : '需要更新扩展后才能云端保存无人值守计划'}
                className={`min-h-9 rounded-md px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${executionMode === 'unattended_plan' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                无人值守
              </button>
            </div>
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
              {editingExistingPlan
                ? '当前字段来自设备已上报的计划；保存修改后会用这些内容覆盖原计划。'
                : executionMode === 'unattended_plan'
                  ? '保存并启用该设备的本地计划，之后由扩展按时间自动执行。'
                : '只执行这一次，不会改动该设备已保存的无人值守计划。'}
            </p>
            {!editingExistingPlan && executionMode === 'unattended_plan' && hasExistingPlan && (
              <p className="mt-1 rounded-lg border border-status-orange/25 bg-status-orange/8 px-2.5 py-2 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
                该设备已有无人值守计划，保存会覆盖原计划。若要在原内容上修改，请使用上方“修改现有无人值守计划”。
              </p>
            )}
            {!remoteUnattendedPlanWrite && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">当前扩展只支持一次性任务，更新后可从云端保存无人值守计划。</p>}
          </div>
          <label className="block text-xs font-medium text-muted-foreground">
            执行平台
            <select value={selectedPlatform} onChange={event => setPlatform(event.target.value)} disabled={disabled}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60">
              {availablePlatforms.length === 0 && <option value="">暂无可用平台</option>}
              {availablePlatforms.map(value => <option key={value} value={value}>{PLATFORM_LABELS[value] || value}</option>)}
            </select>
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            关键词（每行一个，1–30 个）
            <textarea value={keywordText} onChange={event => setKeywordText(event.target.value)} rows={4} disabled={disabled}
              placeholder={'新能源汽车\n智能座舱'}
              className="mt-1.5 w-full resize-y rounded-lg border border-border bg-background px-3 py-2.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary disabled:opacity-60" />
          </label>
          {remoteTaskKeywordPostLimit ? (
            <fieldset className="rounded-xl border border-border/70 bg-card/50 p-3">
              <legend className="px-1 text-xs font-semibold text-foreground">帖子采集上限</legend>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" checked={keywordLimitOverrideEnabled}
                  onChange={event => setKeywordLimitOverrideEnabled(event.target.checked)} disabled={disabled}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                <span>
                  <span className="block text-xs font-semibold text-foreground">使用{executionMode === 'unattended_plan' ? '计划' : '任务'}专属帖子上限</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">关闭时沿用目标设备当前的本地采集上限。</span>
                </span>
              </label>
              {keywordLimitOverrideEnabled ? (
                <label className="mt-2.5 block text-xs font-medium text-muted-foreground">
                  每个关键词最多采集帖子数
                  <input type="number" min={1} step={1} value={keywordMaxDetectedItems}
                    onChange={event => {
                      setKeywordMaxDetectedItems(Number(event.target.value))
                      setKeywordLimitDefaultedFromLegacyPlan(false)
                    }} disabled={disabled}
                    className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
                  <span className="mt-1.5 block text-[11px] leading-4 text-muted-foreground">按每个关键词、每一轮单独计算；受页面实际结果和筛选条件影响，实际数量可能更少。</span>
                  {editingExistingPlan && keywordLimitDefaultedFromLegacyPlan && (
                    <span className="mt-1.5 block rounded-lg border border-status-orange/25 bg-status-orange/8 px-2.5 py-2 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
                      旧计划没有记录帖子上限。你已改用计划专属设置；如直接保存，新计划将使用每个关键词最多 50 条。
                    </span>
                  )}
                </label>
              ) : (
                <p className="mt-2.5 rounded-lg bg-muted/70 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
                  沿用设备设置：本次保存不会写入帖子上限，也不会因为修改日期等其他字段而改成 50 条。
                </p>
              )}
            </fieldset>
          ) : (
            <p className="rounded-lg border border-status-orange/25 bg-status-orange/8 px-3 py-2.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
              当前扩展版本不支持从后台指定帖子采集上限；任务会使用目标设备的本地设置，更新扩展后可单独配置。
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium text-muted-foreground">
              排序方式
              <select value={selectedSort} onChange={event => setSort(event.target.value)} disabled={disabled}
                className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60">
                {SORT_OPTIONS.filter(option => !option.platform || option.platform === selectedPlatform).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="block text-xs font-medium text-muted-foreground">
              发布时间
              <select value={publishTime} onChange={event => setPublishTime(event.target.value)} disabled={disabled}
                className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60">
                {PUBLISH_TIME_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            {executionMode === 'unattended_plan' && <>
              <label className="block text-xs font-medium text-muted-foreground">
                运行规则
                <select value={planMode} onChange={event => setPlanMode(event.target.value as 'daily' | 'custom_dates')} disabled={disabled}
                  className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60">
                  <option value="daily">每天</option>
                  <option value="custom_dates">指定日期</option>
                </select>
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                开始时间
                <input type="time" value={startTime} onChange={event => setStartTime(event.target.value)} disabled={disabled}
                  className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                随机偏移（分钟）
                <input type="number" min={0} max={240} step={1} value={randomOffsetMin} onChange={event => setRandomOffsetMin(Number(event.target.value))} disabled={disabled}
                  className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                执行轮数
                <input type="number" min={1} step={1} value={maxRounds} onChange={event => setMaxRounds(Number(event.target.value))} disabled={disabled}
                  className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
              </label>
              <label className="block text-xs font-medium text-muted-foreground sm:col-span-2">
                轮次间隔（分钟）
                <input type="number" min={0} step={1} value={roundGapMin} onChange={event => setRoundGapMin(Number(event.target.value))} disabled={disabled}
                  className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
              </label>
            </>}
          </div>
          {executionMode === 'unattended_plan' && planMode === 'custom_dates' && (
            <ScheduledDatesPicker value={customDates} onChange={setCustomDates} disabled={disabled} />
          )}
          {remoteTaskEnhancementOptions ? (
            <fieldset className="rounded-xl border border-primary/20 bg-primary/[0.035] p-3.5">
              <legend className="px-1 text-xs font-semibold text-foreground">采集增强</legend>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" checked={captureSettingsOverrideEnabled}
                  onChange={event => setCaptureSettingsOverrideEnabled(event.target.checked)} disabled={disabled}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                <span>
                  <span className="block text-xs font-semibold text-foreground">使用{executionMode === 'unattended_plan' ? '计划' : '任务'}专属采集增强设置</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">关闭时沿用目标设备当前的本地采集增强设置。</span>
                </span>
              </label>
              {captureSettingsOverrideEnabled ? (
                <div className="mt-3">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" checked={enhancementEnabled}
                  onChange={event => setEnhancementEnabled(event.target.checked)} disabled={disabled}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                <span>
                  <span className="block text-xs font-semibold text-foreground">采集增强</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">逐条打开详情页，补齐正文、互动数据、图文视频链接等信息。</span>
                </span>
              </label>

              <div className={`mt-3 space-y-2 border-l-2 border-primary/15 pl-3 ${enhancementEnabled ? '' : 'opacity-55'}`}>
                <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-background/70">
                  <input type="checkbox" checked={autoSyncAfterEnhancement}
                    onChange={event => setAutoSyncAfterEnhancement(event.target.checked)} disabled={disabled || !enhancementEnabled}
                    className="h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                  <span className="text-xs font-medium text-foreground">增强后自动同步后台</span>
                </label>
                <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-background/70">
                  <input type="checkbox" checked={aiRelevancePrefilter}
                    onChange={event => setAiRelevancePrefilter(event.target.checked)} disabled={disabled || !enhancementEnabled}
                    className="h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                  <span className="text-xs font-medium text-foreground">AI 精准筛选</span>
                  <span className="rounded-full border border-primary/25 bg-primary/8 px-1.5 py-0.5 text-[10px] font-semibold text-primary">DeepSeek</span>
                </label>

                <div className="rounded-lg border border-border/70 bg-background/55 p-2.5">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={includeBloggerMetrics}
                      onChange={event => setIncludeBloggerMetrics(event.target.checked)} disabled={disabled || !enhancementEnabled}
                      className="h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                    <span className="text-xs font-medium text-foreground">附件博主粉丝数和赞藏数</span>
                  </label>
                  <div className={`mt-2 border-l border-border pl-3 ${includeBloggerMetrics ? '' : 'opacity-55'}`}>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={lowFollowerHitFilter}
                        onChange={event => setLowFollowerHitFilter(event.target.checked)}
                        disabled={disabled || !enhancementEnabled || !includeBloggerMetrics}
                        className="h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                      <span className="text-xs text-foreground">低粉爆款筛选</span>
                    </label>
                    {lowFollowerHitFilter && includeBloggerMetrics && (
                      <label className="mt-2 block text-[11px] font-medium text-muted-foreground">
                        博主粉丝上限
                        <input type="number" min={0} step={1} value={lowFollowerHitThreshold}
                          onChange={event => setLowFollowerHitThreshold(Number(event.target.value))} disabled={disabled || !enhancementEnabled}
                          className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
                      </label>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-border/70 bg-background/55 p-2.5">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={includeComments}
                      onChange={event => setIncludeComments(event.target.checked)} disabled={disabled || !enhancementEnabled}
                      className="h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                    <span className="text-xs font-medium text-foreground">附加评论</span>
                  </label>
                  <div className={`mt-2 space-y-2 border-l border-border pl-3 ${includeComments ? '' : 'opacity-55'}`}>
                    <label className="block text-[11px] font-medium text-muted-foreground">
                      评论加载上限
                      <input type="number" min={1} step={1} value={commentLimit}
                        onChange={event => setCommentLimit(Number(event.target.value))}
                        disabled={disabled || !enhancementEnabled || !includeComments}
                        className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
                    </label>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input type="checkbox" checked={commentLeadsFilter}
                        onChange={event => setCommentLeadsFilter(event.target.checked)}
                        disabled={disabled || !enhancementEnabled || !includeComments}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                      <span>
                        <span className="block text-xs text-foreground">评论客资筛选</span>
                        <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">需要目标设备已配置评论客资筛选规则。</span>
                      </span>
                    </label>
                  </div>
                </div>

                <label className="flex min-h-8 cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-background/70">
                  <input type="checkbox" checked={skipAlreadyEnhanced}
                    onChange={event => setSkipAlreadyEnhanced(event.target.checked)} disabled={disabled || !enhancementEnabled}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                  <span>
                    <span className="block text-xs font-medium text-foreground">跳过已增强内容</span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">已完成详情增强的内容不重复打开，减少重复导航。</span>
                  </span>
                </label>
              </div>
                </div>
              ) : (
                <p className="mt-2.5 rounded-lg bg-muted/70 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
                  沿用设备设置：本次保存不会写入采集增强选项，也不会因为修改时间、日期等其他字段而关闭设备原有增强能力。
                </p>
              )}
            </fieldset>
          ) : (
            <p className="rounded-lg border border-status-orange/25 bg-status-orange/8 px-3 py-2.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
              当前扩展版本不支持为远程任务指定采集增强选项；任务会继续使用目标设备的本地设置。更新扩展后可在这里单独配置。
            </p>
          )}
          {error && <p role="alert" className="text-xs leading-5 text-status-red">{error}</p>}
          {feedback && <p role="status" className="text-xs leading-5 text-status-green">{feedback}</p>}
          <Button type="submit" size="sm" className="min-h-10 w-full" disabled={disabled || !keywordText.trim()}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {editingExistingPlan
              ? agent.online ? '保存修改并覆盖原计划' : '排队保存修改并覆盖原计划'
              : executionMode === 'unattended_plan'
                ? agent.online ? '保存无人值守计划' : '排队保存计划'
              : agent.online ? '立即执行一次' : '创建一次性任务并排队'}
          </Button>
        </form>
      )}
    </div>
  )
}
