export const CONTENT_TOPIC_OPTIONS = [
  { value: 'onstar', label: '安吉星' },
  { value: 'infotainment', label: '车机' },
  { value: 'wallpaper', label: '壁纸' },
  { value: 'brand_app', label: '品牌APP' },
  { value: 'sentry', label: '哨兵' },
  { value: 'gm_customer_service', label: '上汽通用客服' },
  { value: 'gm_other', label: '其它通用相关' },
] as const

/** 内容分诊的主题筛选项：七个客户主题之外再提供「未分类」（服务端 contentTopic=unclassified）。 */
export const CONTENT_TOPIC_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部内容主题' },
  ...CONTENT_TOPIC_OPTIONS,
  { value: 'unclassified', label: '未分类' },
]

/**
 * 主题显示文案。主题为空并不代表正在生成（历史内容可能从未分类），
 * 所以默认显示「未分类」；列表等紧凑场景传空字符串即可隐藏。
 */
export function contentTopicLabel(value: unknown, fallback = '未分类'): string {
  return CONTENT_TOPIC_OPTIONS.find(option => option.value === value)?.label || fallback
}
