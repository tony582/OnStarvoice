
export const monthlyFields = ['monitor', 'sdb', 'positive', 'neutral', 'cold', 'comment', 'negativeProcess', 'negativeOther']
export const monthlyLabels = {
  monitor: '平台监控量', sdb: 'SDB范畴', positive: '正面', neutral: '中性',
  cold: '负面-冷处理', comment: '负面-评论区留言', negativeProcess: '负面-负面处理流程', negativeOther: '负面-其他',
}

export function isMonthlySummary(snapshot) {
  return snapshot.schemaVersion >= 2 && snapshot.summary.format === 'daily_disposition_v2' && Array.isArray(snapshot.summary.rows)
}

export function monthlyDraftFromRows(rows) {
  return Object.fromEntries(rows.filter(row => row.isWorkingDay).map(row => [row.date,
    Object.fromEntries(monthlyFields.map(field => [field, String(row.counts[field] ?? 0)])),
  ]))
}

export function parseMonthlyDraft(rows, draft) {
  return { rows: Object.fromEntries(rows.filter(row => row.isWorkingDay).map(row => [row.date,
    Object.fromEntries(monthlyFields.map(field => {
      const value = String(draft[row.date]?.[field] ?? '').trim()
      const number = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 0) throw new Error(`${row.date} ${monthlyLabels[field]}请填写非负整数。`)
      return [field, number]
    })),
  ])) }
}

export function sumMonthlyRows(rows, draft) {
  return Object.fromEntries(monthlyFields.map(field => [field, rows.filter(row => row.isWorkingDay).reduce((sum, row) => {
    const value = draft ? Number(draft[row.date]?.[field] || 0) : Number(row.counts[field] || 0)
    return sum + (Number.isSafeInteger(value) && value >= 0 ? value : 0)
  }, 0)]))
}
