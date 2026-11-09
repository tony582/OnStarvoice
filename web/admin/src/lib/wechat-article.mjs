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
  const [commentTitle, commentDetail] = COMMENT_LABELS[commentStatus]
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
  if (object(article.evidence).originalImagesCaptured === false) body.description += fromPage && article.images?.length
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
