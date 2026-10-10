import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { collectRecordMediaUrls, recordVideoUrl } from '../server/services/media-proxy.js';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('recordVideoUrl picks the video link in the same order as the admin and the proxy allow-list', () => {
  const cases = [
    [{ video_url: 'https://www.douyin.com/aweme/v1/play/?video_id=a' }, 'https://www.douyin.com/aweme/v1/play/?video_id=a'],
    [{ video_url: '', payload: { videoUrl: 'https://sns-video-v6.xhscdn.com/b.mp4' } }, 'https://sns-video-v6.xhscdn.com/b.mp4'],
    [{ payload: JSON.stringify({ videoUrls: [{ url: 'https://sns-video-qc.xhscdn.com/c.mp4' }] }) }, 'https://sns-video-qc.xhscdn.com/c.mp4'],
    [{ payload: { awemeVideoUrl: 'https://v26-web.douyinvod.com/d.mp4' } }, 'https://v26-web.douyinvod.com/d.mp4'],
  ];
  for (const [record, expected] of cases) {
    assert.equal(recordVideoUrl(record), expected);
    // 返回的链接必须能通过 media-proxy 的归属校验，否则转发播放会被 403
    assert.ok(collectRecordMediaUrls(record).has(expected));
  }
});

test('recordVideoUrl returns nothing for records without a video (audio and images do not count)', () => {
  assert.equal(recordVideoUrl(null), '');
  assert.equal(recordVideoUrl({}), '');
  assert.equal(recordVideoUrl({ video_url: 'not-a-url', audio_url: 'https://x.douyinvod.com/a.mp3' }), '');
  assert.equal(recordVideoUrl({ cover_url: 'https://p3.douyinpic.com/c.jpg', payload: '{bad json' }), '');
});

test('the drawer player asks the server for the link when the list row does not carry it', () => {
  const player = source('web/admin/src/components/shared/RecordVideoPlayer.tsx');
  const routes = source('server/routes/records.js');
  const triage = source('server/routes/triage.js');

  // 内容分诊列表不返回 video_url —— 这正是播放器要单独取链接的原因
  assert.doesNotMatch(triage.slice(triage.indexOf('page.matched_total'), triage.indexOf('page.matched_total') + 2000), /r\.video_url/);
  assert.match(player, /api\.get<\{ videoUrl\?: string \}>\(`\/records\/\$\{record\.id\}\/video`\)/);
  assert.match(player, /if \(rowVideoUrl \|\| record\.id == null\) return/);
  assert.match(player, /const videoUrl = rowVideoUrl \|\| fetchedVideoUrl/);

  assert.match(routes, /router\.get\('\/:id\/video', requireTenantAccess,/);
  assert.match(routes, /SELECT id, video_url, payload FROM records WHERE id = \$1 AND tenant_id = \$2/);
  assert.match(routes, /videoUrl: recordVideoUrl\(record\)/);
});
