function payloadOf(record) {
  const payload = record?.payload
  if (payload && typeof payload === 'object') return payload
  try { return typeof payload === 'string' ? JSON.parse(payload) || {} : {} } catch { return {} }
}

function mediaUrl(values) {
  return values.map(value => typeof value === 'string' ? value.trim()
    : String(value?.url || value?.src || '').trim())
    .find(value => /^https?:\/\//i.test(value)) || ''
}

// Same aliases as the collected media contract; a post/share URL is not a media stream.
export function recordVideoUrl(record = {}) {
  const p = payloadOf(record)
  return mediaUrl([record.video_url, p.videoUrl, p.videoLink, p.video_url, p.awemeVideoUrl, p.videoUrls?.[0]])
}

export function recordAudioUrl(record = {}) {
  const p = payloadOf(record)
  return mediaUrl([record.audio_url, p.audioUrl, p.audio_url, p.musicUrl, p.audioUrls?.[0], p.musicUrls?.[0]])
}

export function recordTranscriptText(record = {}) {
  const p = payloadOf(record)
  return [record.transcript, p.videoTranscript, p.videoTranscriptText, p.videoTranscriptExtracted,
    p.videoSubtitleText, p.subtitleText, p.transcript, p.asrText, p.videoText]
    .find(value => typeof value === 'string' && value.trim()) || ''
}

export function hasRecordMediaSource(record = {}) {
  return Boolean(recordVideoUrl(record) || recordAudioUrl(record))
}

// Existing text remains readable even if the original stream expired or was not captured.
// Generation still requires hasRecordMediaSource, rather than this broader display capability.
export function canStreamOrTranscribe(record = {}) {
  return hasRecordMediaSource(record) || Boolean(recordTranscriptText(record))
}

export const WECHAT_VIDEO_HINT = '视频号视频请在微信中查看，可用「发到微信」转到电脑微信。'
