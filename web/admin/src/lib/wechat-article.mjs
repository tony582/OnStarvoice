function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)) } catch { return {} }
  }
  return {}
}

export function wechatArticleData(record = {}) {
  const payload = object(record.payload)
  const metadata = object(record.metadata)
  return object(payload.wechatArticle || metadata.wechatArticle || record.wechatArticle)
}

/** Missing counts stay unknown, including legacy rows whose numeric column defaulted to zero. */
export function wechatArticleMetric(record, field) {
  const article = wechatArticleData(record)
  const comments = object(article.comments)
  if (field === 'comments_count' && Object.hasOwn(comments, 'headerCount')) {
    return typeof comments.headerCount === 'number' && Number.isFinite(comments.headerCount)
      ? comments.headerCount.toLocaleString('zh-CN') : '—'
  }
  const key = { likes: 'like', shares: 'share', collects: 'recommend', reads: 'read' }[field]
  const metrics = object(article.metrics)
  if (key && Object.hasOwn(metrics, key)) {
    const metric = object(metrics[key])
    const raw = String(metric.raw ?? '').trim()
    if (raw) return raw
    return typeof metric.value === 'number' && Number.isFinite(metric.value) ? metric.value.toLocaleString('zh-CN') : '—'
  }
  const value = record?.[field]
  if (value === null || value === undefined || value === '') return '—'
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric.toLocaleString('zh-CN') : '—'
}

const sourceLabel = source => source === 'page_dom' ? '网页' : source === 'screen_ocr' ? '手机' : '来源未记录'
function shanghaiTime(value, precision = 'second') {
  if (typeof value !== 'string' || !value.trim()) return ''
  if (precision === 'date' && /^\d{4}-\d{2}-\d{2}/u.test(value)) return value.slice(0, 10)
  // A timestamp without an offset does not identify an instant; do not silently apply this computer's zone.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) return ''
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', ...(precision === 'minute' ? {} : { second: '2-digit' }), hourCycle: 'h23',
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${precision === 'minute' ? '' : `:${parts.second}`}`
}

/** Detail-only wording: list cells keep their existing compact em dash. */
export function wechatArticleDetail(record = {}) {
  const article = wechatArticleData(record), metrics = object(article.metrics), comments = object(article.comments)
  // The server stores minute publication times as Beijing-local YYYY-MM-DD HH:mm. This contract
  // applies only to publishedAt; observation timestamps still require an explicit offset.
  const publication = typeof article.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(article.publishedAt)
    ? `${article.publishedAt.replace(' ', 'T')}:00+08:00` : article.publishedAt
  const published = article.timePrecision === 'unknown' ? '' : shanghaiTime(publication, article.timePrecision)
  return {
    account: String(article.account || record.author_name || ''), author: String(article.author || ''),
    location: String(article.location || ''),
    published: published ? `${published}${article.timePrecision === 'date' ? '' : '（北京时间）'}` : '',
    metrics: [['read', '阅读'], ['like', '点赞'], ['share', '分享'], ['recommend', '推荐'], ['comments', '留言']].map(([key, label]) => {
      const observation = key === 'comments' ? { ...comments, value: comments.headerCount, raw: '' } : object(metrics[key])
      const known = Number.isSafeInteger(observation.value) && observation.value >= 0
      const raw = String(observation.raw || '').trim()
      const value = !known ? '未显示' : /^\d+(?:,\d{3})*(?:\.\d+)?(?:万|亿)?\+?$/u.test(raw)
        ? raw : observation.value.toLocaleString('zh-CN')
      const capturedAt = shanghaiTime(observation.capturedAt)
      return { key, label, value, source: sourceLabel(observation.source),
        capturedAt: capturedAt ? `${capturedAt}（北京时间）` : '读取时间未记录' }
    }),
  }
}

function imageStorageError(image) {
  const error = object(image?.storageError)
  return image?.stored !== true && error.code === 'too_large' && Number.isSafeInteger(error.maxBytes) && error.maxBytes > 0
    && Number.isSafeInteger(error.observedBytes) && error.observedBytes > error.maxBytes
    && ['content_length', 'stream', 'local_file'].includes(error.source)
    ? { code: 'too_large', maxBytes: error.maxBytes, observedBytes: error.observedBytes, source: error.source } : undefined
}

export function wechatArticleImageStorageError(record = {}, imageRef) {
  const images = wechatArticleData(record).images
  return imageStorageError(Array.isArray(images) ? images.find(image => image?.url === imageRef) : null)
}

/** Separators remain in capture evidence, but never appear as body images or failed gallery items. */
export function wechatArticleDisplayImages(record = {}, displayImages = []) {
  const images = wechatArticleData(record).images
  const decorative = new Set((Array.isArray(images) ? images : [])
    .filter(image => image?.storageError?.code === 'decorative').map(image => image.url))
  return displayImages.filter(image => !decorative.has(image.ref))
}

/** Map by original source URL, never the gallery's reordered/local-first index. Repeats stay in place. */
export function wechatArticleBodyBlocks(record = {}, displayImages = []) {
  const article = wechatArticleData(record)
  const entries = new Map(displayImages.map(item => [item.ref, item.url]))
  const saved = new Map((Array.isArray(article.images) ? article.images : []).map(item => [item.url, item]))
  return (Array.isArray(article.bodyBlocks) ? article.bodyBlocks : []).flatMap(block => {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) return [{ type: 'text', text: block.text }]
    if (block?.type !== 'image' || typeof block.url !== 'string') return []
    let parsed
    try { parsed = new URL(block.url) } catch { return [] }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return []
    const image = saved.get(block.url)
    if (image?.storageError?.code === 'decorative') return []
    const storageError = imageStorageError(image)
    const local = image?.stored === true && typeof image.localUrl === 'string' && image.localUrl.startsWith('/media/') ? image.localUrl : ''
    const display = entries.get(block.url)
    return [{ type: 'image', url: display?.startsWith('/media/') ? display : local || display || block.url, ref: block.url, alt: String(block.alt || ''),
      ...(storageError ? { storageError } : {}),
      ...(['visible', 'interactive'].includes(block.layer) ? { layer: block.layer } : {}) }]
  })
}

const COMMENT_LABELS = {
  closed: ['留言已关闭', '文章关闭了留言，正文仍正常保留。'],
  unavailable: ['留言暂不可读取', '本次未能读取留言区，不能据此判断没有留言。'],
  unknown: ['留言状态未确认', '本次未确认文末留言状态，不能据此判断没有留言。'],
  disabled: ['未开启留言采集', '本次任务未开启评论采集，正文仍正常保留。'],
  empty: ['暂无可见留言', '已检查留言区，本次没有发现可见留言。'],
  captured: ['已采集留言', '这里只包含采集时可见的留言，不代表全部留言。'],
  partial: ['留言未采完整', '本次只采集了部分可见留言。'],
}

export function wechatArticlePresentation(record = {}, capturedComments = 0) {
  const article = wechatArticleData(record)
  const payload = object(record.payload)
  const comments = object(article.comments)
  const rawStatus = String(comments.status || payload.commentsCaptureStatus || record.comments_capture_status || 'unknown')
  const commentStatus = ['done', 'complete', 'ok'].includes(rawStatus) ? 'captured'
    : Object.hasOwn(COMMENT_LABELS, rawStatus) ? rawStatus : 'unknown'
  const [commentTitle, commentDetail] = commentStatus === 'unavailable' && comments.reason === 'no_comment_entry'
    ? ['未显示留言入口', '本次文章页面未显示留言入口，不能据此判断留言数量为零。'] : COMMENT_LABELS[commentStatus]
  const commentDescription = commentDetail + (capturedComments > 0 && ['closed', 'unavailable', 'unknown', 'disabled', 'empty'].includes(commentStatus)
    ? ' 下方保留此前已采集的留言。' : '')
  const bodyStatus = String(article.bodyStatus || payload.detailCaptureStatus || record.detail_capture_status || 'unknown')
  const fromPage = article.source === 'page_dom'
  const body = bodyStatus === 'complete' || bodyStatus === 'done'
    ? fromPage
      ? { label: '网页正文已读取', description: '正文来自文章网页，留言由手机补采。' }
      : { label: '正文已读完', description: '已读取至正文末尾；文字由手机画面识别。' }
    : bodyStatus === 'partial'
      ? { label: '正文未采完整', description: '以下是已采到的正文，部分段落或图片文字可能缺失。' }
      : bodyStatus === 'unavailable'
        ? { label: '正文暂不可读取', description: '本次没有取得文章正文。' }
        : { label: '正文完整性未确认', description: '本次尚未确认已读取至正文末尾。' }
  const evidence = object(article.evidence), storage = object(evidence.imageStorage)
  const onlyDecorative = Array.isArray(article.images) && article.images.length > 0
    && article.images.every(image => image?.storageError?.code === 'decorative')
  if (Number.isSafeInteger(storage.expected) && storage.expected > 0 && Number.isSafeInteger(storage.stored)
    && storage.stored >= 0 && storage.stored <= storage.expected) {
    body.description += ` 已发现配图已保存 ${storage.stored}/${storage.expected} 张；此数量仅指已发现的配图。`
  } else if (evidence.originalImagesCaptured === true) body.description += ' 已发现配图已保存。'
  else if (evidence.originalImagesCaptured === false && !onlyDecorative) body.description += fromPage && article.images?.length
    ? ' 已记录配图链接，原始图片尚未确认保存。' : ' 原始图片尚未保存。'
  const latest = object(article.latestCapture)
  if (latest.bodyStatus && latest.bodyStatus !== bodyStatus && ['partial', 'unavailable'].includes(latest.bodyStatus)) {
    body.description += ' 最近一次补采未读完整，当前仍显示此前保存的正文。'
  }
  const latestMetrics = object(latest.metrics)
  const savedMetrics = object(article.metrics)
  let metricNotice = ['read', 'like', 'share', 'recommend'].some(key => Object.hasOwn(latestMetrics, key)
    && object(latestMetrics[key]).value == null && object(savedMetrics[key]).value != null)
    ? '最近一次未读到部分互动数，当前显示此前已知值。' : ''
  if (fromPage) metricNotice += '互动数按网页或手机当时显示值记录；未显示数字的项目记为未知。'
  const postingState = String(comments.postingState || '')
  const postingNote = ['follow_required', 'follow_to_comment', 'follow_required_to_post', 'followers_only'].includes(postingState)
    ? '需关注后才能留言；这不影响查看已展示的留言。' : ''
  return {
    bodyStatus, bodyLabel: body.label, bodyDescription: body.description, metricNotice,
    commentStatus, commentTitle, commentDescription, postingNote,
    commentTab: capturedComments > 0 ? `留言 (${capturedComments})`
      : commentStatus === 'empty' ? '留言 (0)' : '留言',
  }
}
