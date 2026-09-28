export const CONTENT_TOPIC_OPTIONS = [
  { value: 'onstar', label: '安吉星' },
  { value: 'infotainment', label: '车机' },
  { value: 'wallpaper', label: '壁纸' },
  { value: 'brand_app', label: '品牌APP' },
  { value: 'sentry', label: '哨兵' },
  { value: 'gm_customer_service', label: '上汽通用客服' },
  { value: 'gm_other', label: '其它通用相关' },
] as const

export function contentTopicLabel(value: unknown): string {
  return CONTENT_TOPIC_OPTIONS.find(option => option.value === value)?.label || '未分类'
}
