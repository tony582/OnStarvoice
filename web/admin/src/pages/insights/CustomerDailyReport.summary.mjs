
export const monthlyFields = ['monitor', 'sdb', 'positive', 'neutral', 'cold', 'comment', 'negativeProcess', 'negativeOther']
export const monthlyLabels = {
  monitor: '平台监控量', sdb: 'SDB范畴', positive: '正面', neutral: '中性',
  cold: '负面-冷处理', comment: '负面-评论区留言', negativeProcess: '负面-负面处理流程', negativeOther: '负面-其他',
}

export function isMonthlySummary(snapshot) {
  return Array.isArray(snapshot.summary.rows) && (
    (snapshot.schemaVersion >= 2 && snapshot.summary.format === 'daily_disposition_v2') || isHandlingSummary(snapshot)
  )
}

export function isHandlingSummary(snapshot) {
  return snapshot.schemaVersion >= 3 && snapshot.summary.format === 'daily_handling_v3' && Array.isArray(snapshot.summary.rows)
}

export function visibleMonthlyRows(rows, includeHandledNonWorkingDays = false) {
  return rows.filter(row => row.isWorkingDay || (includeHandledNonWorkingDays && monthlyFields.some(field => Number(row.counts[field]) > 0)))
}

export function monthlyDraftFromRows(rows, includeHandledNonWorkingDays = false) {
  return Object.fromEntries(visibleMonthlyRows(rows, includeHandledNonWorkingDays).map(row => [row.date,
    Object.fromEntries(monthlyFields.map(field => [field, String(row.counts[field] ?? 0)])),
  ]))
}

export function parseMonthlyDraft(rows, draft, includeHandledNonWorkingDays = false) {
  return { rows: Object.fromEntries(visibleMonthlyRows(rows, includeHandledNonWorkingDays).map(row => [row.date,
    Object.fromEntries(monthlyFields.map(field => {
      const value = String(draft[row.date]?.[field] ?? '').trim()
      const number = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 0) throw new Error(`${row.date} ${monthlyLabels[field]}请填写非负整数。`)
      return [field, number]
    })),
  ])) }
}

export function sumMonthlyRows(rows, draft, includeHandledNonWorkingDays = false) {
  return Object.fromEntries(monthlyFields.map(field => [field, visibleMonthlyRows(rows, includeHandledNonWorkingDays).reduce((sum, row) => {
    const value = draft ? Number(draft[row.date]?.[field] || 0) : Number(row.counts[field] || 0)
    return sum + (Number.isSafeInteger(value) && value >= 0 ? value : 0)
  }, 0)]))
}

export function dailyPostStatusLabel(post) {
  const labels = {
    unhandled: '待处理', replied: '已回复', reviewed: '已复核', reviewed_non_monitor: '已复核-非监控内容',
    unavailable: '已不可见', privacy_unreachable: '隐私设置无法触达', negative_feishu: '飞书表',
    negative_cold: '冷处理', negative_comment: '评论区留言', reviewing: '负面流程', issue_linked: '已关联事件',
    ticketed: '已转工单', official_responded: '官方已评', no_action: '无需操作', archived: '已归档', false_positive: '误报',
  }
  const label = labels[post.status] || (post.status ? '状态待核对' : '状态未记录')
  const tableNo = typeof post.feishuTableNo === 'string' ? post.feishuTableNo.trim() : ''
  return post.status === 'negative_feishu' && tableNo ? `${label} · ${tableNo}` : label
}
