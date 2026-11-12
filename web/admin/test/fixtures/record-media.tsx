import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { AuthProvider, useAuth } from '../../src/lib/auth'
import { RecordDrawer } from '../../src/components/shared/RecordDrawer'
import { TicketDrawer } from '../../src/components/shared/TicketDrawer'
import { TranscriptCell } from '../../src/pages/DataPage'
import '../../src/index.css'

export function Fixture() {
  const { loading } = useAuth()
  const params = new URLSearchParams(location.search)
  const mode = params.get('mode') || 'drawer'
  const platform = params.get('platform') || 'wechat_channels'
  const status = params.get('status') || 'empty'
  const [id, setId] = useState(params.get('id') || 'fixture')
  const base = { id, platform, title: '离线媒体与评论验收', content: '采集到的正文', note_type: 'video', sentiment: 'neutral', triage_status: 'unhandled', comments_capture_status: status }
  const full = { ...base, ...(params.get('media') === 'video' ? { video_url: 'https://media.example/v.mp4' } : {}),
    ...(params.get('media') === 'audio' ? { audio_url: 'https://media.example/a.mp3' } : {}),
    ...(params.has('text') ? { transcript: '已保存的逐字稿', transcript_status: 'done' } : {}),
    ...(params.has('stale') ? { transcript_status: 'processing' } : {}) }
  if (loading) return <p>载入离线测试</p>
  return <>
    <button data-record-detail-trigger onClick={() => setId('replacement')}>切换记录</button>
    {mode === 'cell' ? <TranscriptCell key={id} row={full} /> : mode === 'ticket'
      ? <TicketDrawer ticket={{ id, platform, source_type: 'record', status: 'pending' }} canWrite onClose={() => {}} />
      : <RecordDrawer record={base} canWrite onClose={() => {}} />}
  </>
}
createRoot(document.getElementById('root')!).render(<AuthProvider><Fixture /></AuthProvider>)
