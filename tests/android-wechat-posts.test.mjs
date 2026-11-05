import test from 'node:test';
import assert from 'node:assert/strict';
import {commentDate, normalizePostEvent, postBatchInput, wechatComments, wechatExternalId, wechatSyncBody}
  from '../server/services/android-control/posts.js';
import {mobileCommentPlan, mobilePlanBlockReason, mobileTaskFilters, mobileWorkflowFor, mobilePlatformForWorkflow}
  from '../server/services/android-control/mobile-tasks.js';
import {readyPlatforms, taskPayload} from '../server/services/android-control/leases.js';
import {normalizeRecord} from '../server/routes/sync.js';

const principal = {tenantId: '11111111-1111-4111-8111-111111111111', agentId: '22222222-2222-4222-8222-222222222222'};
const id = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const event = (overrides = {}) => ({eventKind: 'wechat_post', eventId: id(3), discoveryRunId: id(4), taskId: id(4), itemId: id(5),
  attemptId: id(6), agentId: principal.agentId, requestHash: 'a'.repeat(64), assignmentRevision: 2, keyword: '手机里写的词',
  mode: 'keyword', rank: 3, capturedAt: '2026-11-05T09:30:00.000Z',
  card: {snippet: '通用品牌内 区别对待？承诺', author: '上海交通广播', timeLabel: '前天', likeLabel: '423'},
  link: {shareUrl: 'https://weixin.qq.com/sph/ARLmfj5VbT'},
  preview: {description: '通用品牌内 区别对待？承诺更新不履约！#上汽通用 #别克', createtime: 1793671301, nickname: '上海交通广播',
    avatarUrl: 'https://wx.qlogo.cn/a', likeCountFmt: '262', favCountFmt: '423', forwardCountFmt: '405', commentCountFmt: '207',
    coverUrl: 'https://finder.video.qq.com/c', isImage: false, exportId: 'export/abc'},
  comments: {status: 'partial', headerCount: 207, items: [
    {author: '肿么肥四', location: '江苏', timeLabel: '2天前', content: '别克服务至于交付', likeCount: 31, reply: false, parentIndex: null},
    {author: 'A上海通', location: '上海', timeLabel: '2天前', content: '其他车企也一样', likeCount: null, reply: true, parentIndex: 0},
  ]}, ...overrides});

test('the work id is the publish second and author name, independent of the copied short link', () => {
  const one = wechatExternalId(1793671301, '上海交通广播');
  assert.match(one, /^wxc_[a-f0-9]{24}$/u);
  assert.equal(one, wechatExternalId(1793671301, ' 上海交通广播 '));
  assert.notEqual(one, wechatExternalId(1793671302, '上海交通广播'));
  const a = wechatSyncBody(normalizePostEvent(event(), principal), {keyword: '别克车机升级', taskId: id(4), attemptId: id(6), requestHash: 'a'.repeat(64)});
  const b = wechatSyncBody(normalizePostEvent(event({link: {shareUrl: 'https://weixin.qq.com/sph/AftRlBVgPT'}}), principal),
    {keyword: '别克车机升级', taskId: id(4), attemptId: id(6), requestHash: 'a'.repeat(64)});
  assert.equal(a.externalId, b.externalId);
  assert.equal(a.externalId, one);
});

test('events are validated: owner, share link, preview, batch size and duplicates', () => {
  assert.throws(() => normalizePostEvent(event({agentId: id(9)}), principal), {code: 'AGENT_ID_MISMATCH'});
  assert.throws(() => normalizePostEvent(event({link: {shareUrl: 'https://evil.example/sph/x'}}), principal), {code: 'INVALID_SHARE_LINK'});
  assert.throws(() => normalizePostEvent(event({preview: {...event().preview, createtime: 'soon'}}), principal), {code: 'INVALID_PREVIEW'});
  assert.throws(() => normalizePostEvent(event({eventKind: 'discovery'}), principal), {code: 'INVALID_POST_EVENT'});
  assert.throws(() => postBatchInput({uploadBatchId: id(7), events: Array.from({length: 6}, () => event())}, principal), {code: 'BATCH_SIZE_MUST_BE_1_TO_5'});
  assert.throws(() => postBatchInput({uploadBatchId: id(7), events: [event(), event()]}, principal), {code: 'DUPLICATE_EVENT_ID'});
  const counts = normalizePostEvent(event({preview: {...event().preview, likeCountFmt: '<b>1</b>'}}), principal).preview;
  assert.equal(counts.likeCountFmt, '', 'a count that is not a number is dropped, not stored');
});

test('the sync body carries the server keyword, detail counts by their App labels, publish time and stable comment ids', () => {
  const normalized = normalizePostEvent(event(), principal);
  const {body} = wechatSyncBody(normalized, {keyword: '别克车机升级', taskId: id(4), attemptId: id(6), requestHash: 'a'.repeat(64)});
  const [record] = normalizeRecord(body);
  assert.equal(record.platform, 'wechat_channels');
  assert.equal(record.record_type, 'keyword_notes');
  assert.equal(record.keyword, '别克车机升级', 'the item keyword, not the one the phone sent');
  assert.equal(record.url, 'https://weixin.qq.com/sph/ARLmfj5VbT');
  assert.equal(record.likes, 423);
  assert.equal(record.collects, 262);
  assert.equal(record.shares, 405);
  assert.equal(record.comments_count, 207);
  assert.equal(record.publish_time, '2026-11-03 10:01:41');
  assert.equal(record.author_name, '上海交通广播');
  assert.equal(record.captureTaskItemAttemptId, id(6));
  const comments = JSON.parse(record.comments_cleaned_items);
  assert.equal(comments.length, 2);
  assert.match(comments[0].commentId, /^wxcc_[a-f0-9]{24}$/u);
  assert.equal(comments[1].parentCommentId, comments[0].commentId);
  assert.equal(comments[0].publishedAt, '2026-11-03');
  // A later visit reads "3天前" and slightly different OCR spacing: the ids stay the same.
  const later = wechatComments(record.external_id, {items: [{...event().comments.items[0], timeLabel: '3天前', content: '别克服务 至于交付'}]},
    Date.parse('2026-11-06T09:30:00Z'));
  assert.equal(later[0].commentId, comments[0].commentId);
  const late = wechatSyncBody(normalized, {keyword: '别克车机升级', taskId: id(4), attemptId: '', requestHash: ''});
  assert.equal(normalizeRecord(late.body)[0].captureTaskItemAttemptId, null);
});

test('comment dates from relative labels', () => {
  const at = Date.parse('2026-11-05T09:30:00Z');
  assert.equal(commentDate('2天前', at), '2026-11-03');
  assert.equal(commentDate('5小时前', at), '2026-11-05');
  assert.equal(commentDate('昨天', at), '2026-11-04');
  assert.equal(commentDate('11月1日', at), '11月1日');
  assert.equal(commentDate('上海', at), '');
});

test('Channels plans map to the phone: workflow, newest-first window, comments and allowed plans', () => {
  assert.equal(mobileWorkflowFor('wechat_channels'), 'wechat_channels_mobile_capture');
  assert.equal(mobileWorkflowFor('douyin'), 'douyin_mobile_discovery');
  assert.equal(mobilePlatformForWorkflow('wechat_channels_mobile_capture'), 'wechat_channels');
  assert.deepEqual(mobileTaskFilters({sort: 'comprehensive', publishTime: 'day'}, 'wechat_channels'), {sort: 'latest', publishWindowHours: 24});
  assert.deepEqual(mobileTaskFilters({sort: 'likes', publishTime: 'all'}, 'wechat_channels'), {sort: 'hot', publishWindowHours: null});
  assert.deepEqual(mobileTaskFilters({sort: 'latest', publishTime: 'month'}, 'wechat_channels'), {sort: 'latest', publishWindowHours: 720});
  assert.deepEqual(mobileTaskFilters({sort: 'latest', publishTime: 'day', contentType: 'video'}),
    {sort: 'latest', publishTime: 'day', contentType: 'video'}, 'Douyin is unchanged');
  assert.deepEqual(mobileCommentPlan({captureSettings: {includeCommentsOnDetailCapture: true, detailCommentsMaxDetectedItems: 80}}), {enabled: true, limit: 80});
  assert.deepEqual(mobileCommentPlan({}), {enabled: false, limit: 0});
  assert.equal(mobilePlanBlockReason({searchFilters: {publishTime: 'month'}, negativePatrol: {enabled: true}}, 'wechat_channels'), '');
  assert.equal(mobilePlanBlockReason({searchPasses: ['video', 'image']}, 'wechat_channels'), 'sequential_search_unsupported');
  assert.equal(mobilePlanBlockReason({negativePatrol: {enabled: true}}, 'douyin'), 'negative_patrol_unsupported');
  assert.equal(mobilePlanBlockReason({}, 'xiaohongshu'), 'platform_not_douyin');
});

test('poll platforms: an old Runner is a Douyin phone; a new one only gets what it reports and is allowed', () => {
  const agent = {allowed_platforms: ['douyin', 'wechat_channels']};
  assert.deepEqual(readyPlatforms({}, agent, true), ['douyin']);
  assert.deepEqual(readyPlatforms({platforms: ['wechat_channels', 'douyin', 'weibo']}, agent, true), ['douyin', 'wechat_channels']);
  assert.deepEqual(readyPlatforms({platforms: ['wechat_channels']}, {allowed_platforms: ['douyin']}, true), []);
  assert.deepEqual(readyPlatforms({platforms: ['douyin']}, agent, false), []);
});

test('task payloads name their platform; a Channels task carries its comment plan', () => {
  const item = {execution_task_id: id(4), id: id(5), assignment_revision: 1, request_hash: 'b'.repeat(64), assigned_agent_id: principal.agentId,
    keyword: '别克车机升级', metadata: {attemptId: id(6)}};
  const douyin = taskPayload(item, {workflow: 'douyin_mobile_discovery', filters: {sort: 'latest'}, budgets: {}, deadlineAt: null});
  assert.equal(douyin.platform, 'douyin');
  assert.equal(douyin.comments, undefined);
  const wechat = taskPayload(item, {workflow: 'wechat_channels_mobile_capture', filters: {sort: 'latest', publishWindowHours: 24},
    budgets: {}, deadlineAt: null, comments: {enabled: true, limit: 30}});
  assert.equal(wechat.platform, 'wechat_channels');
  assert.equal(wechat.mode, 'keyword');
  assert.deepEqual(wechat.comments, {enabled: true, limit: 30});
});
