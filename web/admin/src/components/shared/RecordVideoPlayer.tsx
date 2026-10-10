import { useEffect, useState } from 'react'
import { Play, VideoOff } from 'lucide-react'
import { api } from '@/lib/api'
import { RecordSourceAction } from '@/components/shared/RecordSourceAction'

type PlaybackMode = 'idle' | 'direct' | 'proxy' | 'unavailable'

type VideoRecord = Record<string, unknown> & {
  id?: string | number
  platform?: string | null
  url?: string | null
  canonical_url?: string | null
  video_url?: string | null
  payload?: unknown
}

function parsePayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object') return payload as Record<string, unknown>
  if (typeof payload !== 'string' || !payload.trim()) return {}
  try {
    const parsed = JSON.parse(payload)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function urlOf(item: unknown): string {
  if (typeof item === 'string') return item.trim()
  if (item && typeof item === 'object') {
    const value = (item as Record<string, unknown>).url || (item as Record<string, unknown>).src || ''
    return String(value).trim()
  }
  return ''
}

// 取值顺序与「下载附件」（DataPage videoUrl）和服务端 collectRecordMediaUrls 一致，转发时才能通过归属校验
function recordVideoUrl(record: VideoRecord): string {
  const payload = parsePayload(record.payload)
  const videoUrls = Array.isArray(payload.videoUrls) ? payload.videoUrls : []
  return [record.video_url, payload.videoUrl, payload.videoLink, payload.video_url, payload.awemeVideoUrl, videoUrls[0]]
    .map(urlOf)
    .find(value => /^https?:\/\//i.test(value)) || ''
}

/**
 * 详情抽屉里直接播放平台视频。点了才加载，不在打开抽屉时拉视频。
 * 先让浏览器直连平台链接（不占服务器带宽）；平台拒绝（防盗链 / 过期）就改走服务端转发
 * （/media-proxy?inline=1，带平台 Referer、支持拖动进度）；转发也失败，多半是链接已过期。
 */
export function RecordVideoPlayer({ record, poster }: { record: VideoRecord; poster?: string }) {
  const [mode, setMode] = useState<PlaybackMode>('idle')
  const rowVideoUrl = recordVideoUrl(record)
  // 内容分诊等列表不带 video_url / payload：行里没有就向服务端单独取一次
  const [fetchedVideoUrl, setFetchedVideoUrl] = useState('')
  useEffect(() => {
    if (rowVideoUrl || record.id == null) return
    let active = true
    api.get<{ videoUrl?: string }>(`/records/${record.id}/video`)
      .then(data => { if (active) setFetchedVideoUrl(String(data.videoUrl || '')) })
      .catch(() => { /* 取不到就不显示播放器，逐字稿照常 */ })
    return () => { active = false }
  }, [record.id, rowVideoUrl])
  const videoUrl = rowVideoUrl || fetchedVideoUrl
  if (!videoUrl) return null

  const tenant = api.getTenant()
  const proxyUrl = `/api/records/${record.id}/media-proxy?${new URLSearchParams({
    url: videoUrl,
    filename: 'video.mp4',
    inline: '1',
    ...(tenant ? { tenantId: tenant } : {}),
  }).toString()}`

  return (
    <section>
      <h4 className="mb-2 text-[13px] font-semibold text-foreground">视频</h4>
      <div className="relative flex h-[360px] items-center justify-center overflow-hidden rounded-lg bg-black">
        {mode === 'idle' && (
          <button
            type="button"
            onClick={() => setMode('direct')}
            className="group absolute inset-0 flex items-center justify-center"
            aria-label="播放视频"
          >
            {poster && <img src={poster} alt="" className="absolute inset-0 h-full w-full object-contain opacity-80" referrerPolicy="no-referrer" />}
            <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/40 transition group-hover:scale-105 group-hover:bg-black/70">
              <Play className="ml-0.5 h-6 w-6 fill-current" />
            </span>
          </button>
        )}
        {(mode === 'direct' || mode === 'proxy') && (
          <video
            key={mode}
            src={mode === 'direct' ? videoUrl : proxyUrl}
            poster={poster || undefined}
            data-playback-mode={mode}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="h-full w-full object-contain"
            onError={() => setMode(current => (current === 'direct' ? 'proxy' : 'unavailable'))}
          />
        )}
        {mode === 'unavailable' && (
          <div className="flex flex-col items-center gap-2 px-6 text-center text-[12px] leading-5 text-white/80">
            <VideoOff className="h-6 w-6 text-white/60" />
            <p>视频链接已过期或平台拒绝播放。重新采集后可再播放，也可以去原平台观看。</p>
            <RecordSourceAction record={record} className="text-white hover:text-white" />
          </div>
        )}
      </div>
    </section>
  )
}
