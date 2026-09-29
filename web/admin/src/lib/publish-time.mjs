// 内容发布时间的展示（详情「采集」页签）。
//
// publish_time 是采集到的原文，可能是精确时间、只有日期，也可能是「8小时前」
// 这类相对说法——它相对的是采集那一刻，不是现在，原样显示会被读错。
// published_ts 是服务端入库时按采集时刻换算好的绝对时间。
// 这里统一显示北京时间的绝对时间，精度跟着原文走；相对说法换算后标「约」并附原文。

const TIME_ZONE = 'Asia/Shanghai'
const PREFIX = /^(编辑于|发布于|更新于|发表于|来自)\s*/u
const ISO = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/iu
const FULL_DATE_TIME = /^20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/u
const FULL_DATE = /^20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/u
const MONTH_DAY = /^\d{1,2}[-/.月]\d{1,2}日?/u

const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function dateParts(date) {
  const parts = {}
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value
  return parts
}

function formatAt(date, precision) {
  const p = dateParts(date)
  const day = `${p.year}/${p.month}/${p.day}`
  if (precision === 'second') return `${day} ${p.hour}:${p.minute}:${p.second}`
  if (precision === 'minute') return `${day} ${p.hour}:${p.minute}`
  return day
}

function validDate(value) {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * 原文属于哪一种写法。
 * kind：empty | exact | date | relative_time | relative_day | other
 * precision：exact 时为 second 或 minute。edited：原文带「编辑于」「更新于」。
 */
export function classifyPublishTimeText(raw) {
  const original = String(raw ?? '').trim()
  if (!original) return { kind: 'empty', precision: '', edited: false, text: '' }
  const prefix = original.match(PREFIX)?.[1] || ''
  const edited = prefix === '编辑于' || prefix === '更新于'
  const text = original.replace(PREFIX, '').replace(/^[·•\s]+/u, '').trim()
  const result = (kind, precision = '') => ({ kind, precision, edited, text: original })

  if (/\d+\s*(分钟|分|小时|时)前/u.test(text) || /^刚刚/u.test(text)) return result('relative_time')
  if (/\d+\s*(天|周|个月|月|年)前/u.test(text) || /^(今天|昨天|前天)/u.test(text)) return result('relative_day')

  const iso = text.match(ISO)
  if (iso) return result('exact', iso[1] === undefined ? 'minute' : 'second')
  const dateTime = text.match(FULL_DATE_TIME)
  if (dateTime) {
    const [, hour, minute, second] = dateTime
    // 平台只给日期时，采集端会补成 00:00:00；那不是发布的时分秒。
    if (Number(hour) === 0 && Number(minute) === 0 && Number(second || 0) === 0) return result('date')
    return result('exact', second === undefined ? 'minute' : 'second')
  }
  if (FULL_DATE.test(text) || MONTH_DAY.test(text)) return result('date')
  return result('other')
}

/**
 * record：{ publish_time, published_ts, publish_display }。
 * 返回 { value, hint }：value 是要显示的发布时间，hint 是需要时附在下面的一行说明。
 */
export function publishTimePresentation(record = {}) {
  const shape = classifyPublishTimeText(record?.publish_time)
  const at = validDate(record?.published_ts)
  const displayDate = String(record?.publish_display ?? '').trim().replaceAll('-', '/')
  const quoted = shape.text ? `「${shape.text}」` : ''

  if (shape.kind === 'empty') {
    // 没有原文：发布时间没采到，或只有人工填写的日期。
    return { value: displayDate || (at ? formatAt(at, 'day') : '-'), hint: '' }
  }
  if (shape.kind === 'relative_time' || shape.kind === 'relative_day') {
    const precision = shape.kind === 'relative_time' ? 'minute' : 'day'
    const value = at ? `约 ${formatAt(at, precision)}` : displayDate ? `约 ${displayDate}` : '-'
    return { value, hint: `按采集时页面显示的${quoted}换算` }
  }
  const hint = shape.edited ? `页面显示${quoted}，是最后编辑的时间` : ''
  if (shape.kind === 'exact') {
    // 带时区的原文自身就能定出时刻；不带时区的只在服务端换算过时才格式化，
    // 否则原样显示，避免按查看者电脑的时区读错。
    const bare = shape.text.replace(PREFIX, '').trim()
    const exact = at || (ISO.test(bare) && /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(bare) ? validDate(bare) : null)
    return { value: exact ? formatAt(exact, shape.precision) : shape.text, hint }
  }
  if (at) return { value: formatAt(at, 'day'), hint }
  return { value: displayDate || shape.text, hint }
}

/**
 * 详情里显示的采集关键词。
 * keyword 是内容上存的关键词；discoveryKeywords 是手机发现这条内容时用过的关键词（最早的在前）。
 */
export function captureKeywordPresentation(keyword, discoveryKeywords = []) {
  const stored = String(keyword ?? '').trim()
  const discovered = [...new Set((Array.isArray(discoveryKeywords) ? discoveryKeywords : [])
    .map(value => String(value ?? '').trim())
    .filter(Boolean))]
  const value = stored || discovered[0] || ''
  const others = discovered.filter(item => item !== value)
  return {
    value: value || '-',
    hint: others.length > 0 ? `手机还在这些关键词下发现过：${others.join('、')}` : '',
  }
}
