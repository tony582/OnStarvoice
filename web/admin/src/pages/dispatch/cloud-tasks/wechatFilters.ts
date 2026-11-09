// 微信视频号、文章共用排序 不限 / 最新 / 最热和发布时间范围。
// 视频号额外提供「时长」「范围」；文章未验证的范围选项不开放。
// 发布时间由手机按「最新」读取内容后筛选，不是 App 原生筛选。
// 取值沿用服务端 searchFilters 的键：sort、publishTime、videoDuration、searchScope。

export type WechatOption = { value: string; label: string }

export const WECHAT_SORT_OPTIONS: WechatOption[] = [
  { value: 'comprehensive', label: '不限' },
  { value: 'latest', label: '最新' },
  { value: 'likes', label: '最热' },
]

export const WECHAT_PUBLISH_TIME_OPTIONS: WechatOption[] = [
  { value: 'all', label: '不限时间' },
  { value: 'day', label: '一天内' },
  { value: 'week', label: '一周内' },
  { value: 'month', label: '一个月内' },
  { value: 'halfyear', label: '半年内' },
]

export const WECHAT_DURATION_OPTIONS: WechatOption[] = [
  { value: 'all', label: '不限' },
  { value: 'under_5m', label: '5分钟以下' },
  { value: '5_20m', label: '5-20分钟' },
  { value: 'over_20m', label: '20分钟以上' },
]

export const WECHAT_SCOPE_OPTIONS: WechatOption[] = [
  { value: 'all', label: '范围不限' },
  { value: 'followed', label: '已关注' },
  { value: 'viewed', label: '最近看过' },
]

function label(options: WechatOption[], value: unknown) {
  return options.find(option => option.value === String(value ?? 'all'))?.label || options[0].label
}

/** 选了发布时间范围，手机只能按「最新」读到超出范围就停，排序随之固定。 */
export function wechatSortLocked(publishTime: unknown) {
  return String(publishTime || 'all') !== 'all'
}

export function wechatEffectiveSort(sort: unknown, publishTime: unknown) {
  if (wechatSortLocked(publishTime)) return 'latest'
  return WECHAT_SORT_OPTIONS.some(option => option.value === sort) ? String(sort) : 'comprehensive'
}

/** 两种微信内容共用计划摘要；文章不显示时长或尚未验证的范围。 */
export function wechatFilterSummary(searchFilters: Record<string, unknown> | null | undefined, platform: 'wechat_channels' | 'wechat_articles' = 'wechat_channels') {
  const filters = searchFilters || {}
  return [
    label(WECHAT_SORT_OPTIONS, wechatEffectiveSort(filters.sort, filters.publishTime)),
    label(WECHAT_PUBLISH_TIME_OPTIONS, filters.publishTime),
    ...(platform === 'wechat_articles' ? ['文章及图文'] : [
      `时长${label(WECHAT_DURATION_OPTIONS, filters.videoDuration)}`,
      label(WECHAT_SCOPE_OPTIONS, filters.searchScope),
    ]),
  ].join(' · ')
}
