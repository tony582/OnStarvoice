import test from 'node:test'
import assert from 'node:assert/strict'
import { canStreamOrTranscribe, hasRecordMediaSource, recordVideoUrl, recordAudioUrl, recordTranscriptText } from '../src/lib/record-media.mjs'
import { wechatArticlePresentation, wechatCommentPresentation } from '../src/lib/wechat-article.mjs'

test('video type, cover, share link, or stale transcript job is not a playable stream', () => {
  for (const platform of ['wechat_channels', 'douyin', 'xiaohongshu']) {
    const record = { platform, note_type: 'video', url: 'https://weixin.qq.com/sph/fixture', cover_url: 'https://images.example/cover.jpg', transcript_status: 'processing' }
    assert.equal(canStreamOrTranscribe(record), false)
    assert.equal(hasRecordMediaSource(record), false)
    assert.equal(canStreamOrTranscribe({ ...record, video_url: 'javascript:alert(1)', audio_url: 'unknown' }), false)
  }
})

test('actual video and audio fields and collected aliases enable media independently of platform', () => {
  for (const platform of ['douyin', 'xiaohongshu', 'wechat_channels']) {
    for (const media of [{ video_url: 'https://media.example/v.mp4' }, { audio_url: 'https://media.example/a.mp3' },
      { payload: { videoUrl: 'https://media.example/v.mp4' } }, { payload: JSON.stringify({ audioUrls: [{ url: 'https://media.example/a.mp3' }] }) }]) {
      assert.equal(canStreamOrTranscribe({ platform, ...media }), true)
      assert.equal(hasRecordMediaSource({ platform, ...media }), true)
    }
  }
  assert.equal(recordVideoUrl({ payload: { videoUrls: [{ src: 'https://media.example/v.mp4' }] } }), 'https://media.example/v.mp4')
  assert.equal(recordAudioUrl({ payload: { musicUrl: 'https://media.example/a.mp3' } }), 'https://media.example/a.mp3')
})

test('existing and legacy transcripts remain viewable without granting generation', () => {
  for (const record of [{ transcript: '已保存逐字稿' }, { payload: { subtitleText: '历史字幕' } }, { payload: '{"videoTranscript":"历史稿"}' }]) {
    assert.equal(canStreamOrTranscribe(record), true)
    assert.equal(hasRecordMediaSource(record), false)
    assert.ok(recordTranscriptText(record))
  }
  assert.equal(canStreamOrTranscribe({ transcript: '  ', payload: 'not-json' }), false)
})

for (const platform of ['wechat_channels', 'wechat_articles']) {
  test(`${platform}: captured, partial, empty, disabled and not_relocated keep distinct meanings`, () => {
    for (const status of ['captured', 'partial', 'empty', 'disabled', 'not_relocated']) {
      const presentation = wechatCommentPresentation({ platform, comments_capture_status: status }, 0)
      assert.equal(presentation.commentStatus, status)
      assert.equal(presentation.commentTab.includes('(0)'), status === 'empty')
      if (status !== 'disabled') assert.doesNotMatch(presentation.commentDescription, /开启评论采集/)
      if (status === 'not_relocated') assert.match(presentation.commentDescription, /不能据此判断没有/)
    }
    const retained = wechatCommentPresentation({ platform, comments_capture_status: 'not_relocated' }, 2)
    assert.match(retained.commentDescription, /保留此前已采集/)
    assert.match(retained.commentTab, /\(2\)/)
  })
}

test('article nested status and follow-to-post note are preserved by the shared presentation', () => {
  const record = { platform: 'wechat_articles', payload: { wechatArticle: { comments: { status: 'not_relocated', postingState: 'follow_required' } } } }
  assert.equal(wechatArticlePresentation(record).commentStatus, 'not_relocated')
  assert.deepEqual(wechatCommentPresentation(record), {
    commentStatus: 'not_relocated', commentTitle: '未重新定位到原帖',
    commentDescription: '本次未重新定位到原帖，未能读取留言，不能据此判断没有留言。',
    postingNote: '需关注后才能留言；这不影响查看已展示的留言。', commentTab: '留言',
  })
})
