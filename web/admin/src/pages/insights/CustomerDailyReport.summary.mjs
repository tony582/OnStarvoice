
export const monthlyFields = ['monitor', 'sdb', 'positive', 'neutral', 'cold', 'comment', 'negativeProcess', 'negativeOther']
export const monthlyLabels = {
  monitor: '平台监控量', sdb: 'SDB范畴', positive: '正面', neutral: '中性',
  cold: '负面-冷处理', comment: '负面-评论区留言', negativeProcess: '负面-负面处理流程', negativeOther: '负面-其他',
}

export function isMonthlySummary(snapshot) {
  return Array.isArray(snapshot.summary.rows) && (
    (snapshot.schemaVersion >= 2 && snapshot.summary.format === 'daily_disposition_v2') || isHandlingSummary(snapshot) || isCollectionSummary(snapshot)
  )
}

export function isHandlingSummary(snapshot) {
  return snapshot.schemaVersion >= 3 && snapshot.summary.format === 'daily_handling_v3' && Array.isArray(snapshot.summary.rows)
}

export function isCollectionSummary(snapshot) {
  return snapshot.schemaVersion >= 4 && snapshot.summary.format === 'daily_collection_v4' && Array.isArray(snapshot.summary.rows)
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

export function monthlySummaryTotals(snapshot, draft) {
  if (!draft) return snapshot.summary.mtd
  const rows = snapshot.summary.rows || []
  if (!isCollectionSummary(snapshot)) return sumMonthlyRows(rows, draft, isHandlingSummary(snapshot))
  const totals = Object.fromEntries(monthlyFields.map(field => {
    const original = snapshot.summary.mtd[field]
    if (!Number.isSafeInteger(original) || original < 0) throw new Error('原月累计数据需要核对，请先更新日报。')
    const delta = visibleMonthlyRows(rows).reduce((sum, row) => {
      const value = String(draft[row.date]?.[field] ?? '').trim()
      const count = Number(value)
      const previous = row.counts[field] ?? 0
      if (!Number.isSafeInteger(previous) || previous < 0) throw new Error('原逐日数据需要核对，请先更新日报。')
      return sum + (/^\d+$/.test(value) && Number.isSafeInteger(count) && count >= 0 ? BigInt(count) - BigInt(previous) : 0n)
    }, 0n)
    const total = BigInt(original) + delta
    if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${monthlyLabels[field]}月累计超出有效范围，请调整每日修改值。`)
    return [field, Number(total)]
  }))
  if (totals.sdb > totals.monitor) throw new Error('SDB月累计不能大于平台监控量，请调整每日修改值。')
  const classified = ['positive', 'neutral', 'cold', 'comment', 'negativeProcess', 'negativeOther']
    .reduce((sum, field) => sum + BigInt(totals[field]), 0n)
  if (classified > BigInt(totals.sdb)) throw new Error('正面、中性及负面月累计之和不能大于SDB范畴，请调整每日修改值。')
  return totals
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
