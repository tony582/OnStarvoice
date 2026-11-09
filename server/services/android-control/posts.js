import {createHash} from 'node:crypto';
import {truncateWellFormed} from '../../utils/well-formed-text.js';
import {DiscoveryError, requireUuid} from '../capture-discovery/validation.js';
import {digest, fail} from './validation.js';
import {lockAgent} from './repository.js';
import {mobileWorkflowFor} from './mobile-tasks.js';
import {ARTICLE_EVENT_KIND, ARTICLE_PLATFORM, normalizeArticleEvent, articleSyncBody} from './articles.js';

// WeChat Channels posts captured completely on the phone (docs/hotfix/20261105-wechat-channels-mobile.md).
// The phone uploads at most five posts per batch; each event gets one durable receipt. The work identity, the
// comment identities and the record fields are derived here from the preview fields, never taken from the phone.
export const MOBILE_POST_MAX_EVENTS = 5;
const SHARE_LINK = /^https:\/\/weixin\.qq\.com\/sph\/[A-Za-z0-9_-]{4,40}$/u;
const COUNT = /^[0-9][0-9.,]*(?:万|w|W|亿)?\+?$/u;
// The first moment a capture could have happened, measured against the attempt's start (clock skew allowance).
const SKEW_MS = 5 * 60_000;

const str = (value, max) => typeof value === 'string' ? truncateWellFormed(value.normalize('NFC'), max) : '';
const comparable = value => String(value ?? '').normalize('NFKC').replace(/[\s.。…·•｜|]+/gu, '').toLowerCase();
const sha = value => createHash('sha256').update(value).digest('hex');

/** The stored work id of a Channels post: publish second + author name (both from the public preview page). */
export function wechatExternalId(createtime, nickname) {
  return `wxc_${sha(`${createtime}|${String(nickname).normalize('NFC').trim()}`).slice(0, 24)}`;
}

function count(value) {
  const text = str(value, 20).trim();
  return text === '' || COUNT.test(text) ? text : '';
}

export function normalizePostEvent(input, principal) {
  if (input?.eventKind === ARTICLE_EVENT_KIND) return normalizeArticleEvent(input, principal);
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.eventKind !== 'wechat_post') fail('INVALID_POST_EVENT', 422);
  const event = {};
  for (const key of ['eventId', 'discoveryRunId', 'taskId', 'itemId', 'attemptId', 'agentId']) event[key] = requireUuid(input[key], key);
  if (event.agentId !== principal.agentId) fail('AGENT_ID_MISMATCH', 403);
  if (event.taskId !== event.discoveryRunId) fail('RUN_TASK_MISMATCH', 422);
  if (!/^[a-f0-9]{64}$/u.test(input.requestHash) || !Number.isSafeInteger(input.assignmentRevision) || input.assignmentRevision < 1) fail('INVALID_ATTEMPT', 422);
  Object.assign(event, {requestHash: input.requestHash, assignmentRevision: input.assignmentRevision});
  const capturedAt = Date.parse(input.capturedAt);
  if (!Number.isFinite(capturedAt) || capturedAt > Date.now() + SKEW_MS) fail('INVALID_CAPTURED_AT', 422);
  const shareUrl = str(input.link?.shareUrl, 120);
  if (!SHARE_LINK.test(shareUrl)) fail('INVALID_SHARE_LINK', 422);
  const preview = input.preview ?? {};
  const createtime = Number(preview.createtime);
  const nickname = str(preview.nickname, 200).trim();
  if (!Number.isSafeInteger(createtime) || createtime < 1_262_304_000 || createtime * 1000 > capturedAt + SKEW_MS || !nickname
    || typeof preview.description !== 'string') fail('INVALID_PREVIEW', 422);
  const items = Array.isArray(input.comments?.items) ? input.comments.items.slice(0, 500) : [];
  return {
    ...event, platform: 'wechat_channels', capturedAt, mode: input.mode === 'patrol' ? 'patrol' : 'keyword',
    rank: Number.isSafeInteger(input.rank) && input.rank > 0 && input.rank < 100_000 ? input.rank : null,
    shareUrl,
    card: {snippet: str(input.card?.snippet, 400), author: str(input.card?.author, 120), timeLabel: str(input.card?.timeLabel, 40)},
    preview: {createtime, nickname, description: str(preview.description, 20_000), avatarUrl: str(preview.avatarUrl, 1000),
      coverUrl: str(preview.coverUrl, 2000), isImage: preview.isImage === true, exportId: str(preview.exportId, 200),
      likeCountFmt: count(preview.likeCountFmt), favCountFmt: count(preview.favCountFmt),
      forwardCountFmt: count(preview.forwardCountFmt), commentCountFmt: count(preview.commentCountFmt)},
    comments: {status: ['captured', 'partial', 'disabled', 'empty', 'not_relocated'].includes(input.comments?.status) ? input.comments.status : 'disabled',
      headerCount: Number.isSafeInteger(input.comments?.headerCount) ? input.comments.headerCount : null,
      items: items.filter(item => item && typeof item === 'object' && str(item.content, 2000).trim() && str(item.author, 120).trim())
        .map(item => ({author: str(item.author, 120).trim(), location: str(item.location, 20), timeLabel: str(item.timeLabel, 40),
          content: str(item.content, 2000).trim(), likeCount: Number.isSafeInteger(item.likeCount) && item.likeCount >= 0 ? item.likeCount : null,
          reply: item.reply === true, parentIndex: Number.isSafeInteger(item.parentIndex) && item.parentIndex >= 0 ? item.parentIndex : null}))},
    payloadHash: digest(input),
  };
}

export function postBatchInput(body, principal) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_BODY', 400);
  const uploadBatchId = requireUuid(body.uploadBatchId, 'uploadBatchId');
  if (!Array.isArray(body.events) || body.events.length < 1) fail('BATCH_SIZE_MUST_BE_1_TO_5', 400);
  if (body.events.length > MOBILE_POST_MAX_EVENTS) fail('BATCH_SIZE_MUST_BE_1_TO_5', 413);
  const seen = new Set();
  const events = body.events.map(input => {
    const event = normalizePostEvent(input, principal);
    if (seen.has(event.eventId)) fail('DUPLICATE_EVENT_ID', 422);
    seen.add(event.eventId);
    return event;
  });
  return {uploadBatchId, events};
}

const beijing = seconds => {
  const date = new Date(seconds * 1000 + 8 * 3600_000);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};
const UNIT_MS = {分钟: 60_000, 小时: 3_600_000, 天: 86_400_000, 周: 7 * 86_400_000, 星期: 7 * 86_400_000, 个月: 30 * 86_400_000, 年: 365 * 86_400_000};
/** A comment's relative label against the capture time, as the day it was written (Beijing date) or ''. */
export function commentDate(label, capturedAt) {
  const text = String(label ?? '').replace(/\s+/gu, '');
  const relative = text.match(/^(\d{1,4})(分钟|小时|天|周|星期|个月|年)前$/u);
  const named = text.match(/^(刚刚|今天|昨天|前天)$/u);
  let at = null;
  if (relative) at = capturedAt - Number(relative[1]) * UNIT_MS[relative[2]];
  else if (named) at = capturedAt - ({刚刚: 0, 今天: 0, 昨天: 1, 前天: 2}[named[1]]) * 86_400_000;
  else if (/^(?:\d{4}年)?\d{1,2}月\d{1,2}日$/u.test(text) || /^\d{1,2}-\d{1,2}$/u.test(text)) return text;
  return at === null ? '' : beijing(Math.floor(at / 1000)).slice(0, 10);
}

/** Comment ids from the post id, the parent's author/text and the comment's own author/text (no times). */
export function wechatComments(externalId, comments, capturedAt) {
  const keyOf = item => `${comparable(item.author)}|${comparable(item.content)}`;
  return comments.items.map((item, index) => {
    const parent = item.reply && item.parentIndex !== null && comments.items[item.parentIndex] ? comments.items[item.parentIndex] : null;
    const commentId = `wxcc_${sha(`${externalId}|${parent ? keyOf(parent) : ''}|${keyOf(item)}`).slice(0, 24)}`;
    const parentCommentId = parent ? `wxcc_${sha(`${externalId}||${keyOf(parent)}`).slice(0, 24)}` : '';
    return {commentId, parentCommentId, authorName: item.author, content: item.content, likes: item.likeCount ?? 0,
      publishedAt: commentDate(item.timeLabel, capturedAt), ipLocation: item.location, floorIndex: index + 1, isReply: item.reply};
  });
}

// Comment readings come from OCR: the same comment read on another day can differ by a badge glyph after the name,
// a sticker read as a character or a dropped particle (OnStar test 2026-11-06). The rules match the phone's merge
// of scrolled screens (runners/android/src/device/wechat-comments-parse.mjs).
const bare = value => comparable(value).replace(/[^\p{L}\p{N}]/gu, '');
function dice(a, b) {
  if (a.length < 3 || b.length < 3) return a === b ? 1 : 0;
  const pairs = text => { const map = new Map(); for (let i = 0; i < text.length - 1; i++) map.set(text.slice(i, i + 2), (map.get(text.slice(i, i + 2)) ?? 0) + 1); return map; };
  const one = pairs(a), two = pairs(b);
  let shared = 0;
  for (const [pair, n] of one) shared += Math.min(n, two.get(pair) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}
export function commentNamesAgree(a, b) {
  const x = bare(a), y = bare(b);
  if (x === y) return Boolean(x);
  let prefix = 0;
  while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix++;
  const shorter = Math.min(x.length, y.length);
  return shorter >= 3 && Math.abs(x.length - y.length) <= 1 && prefix >= shorter - 1;
}
export function commentTextsAgree(a, b) {
  const x = bare(a), y = bare(b);
  if (x === y) return true;
  if (!x || !y) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 4 && long.startsWith(short.slice(0, -1))) return true;
  return dice(x, y) >= 0.8;
}

/**
 * A re-captured post keeps the ids of the comments already stored for it: each new reading that agrees with a stored
 * comment (one to one; exact ids first) takes that id, so the comment is updated instead of stored again. Replies follow
 * their parent's stored id.
 */
export function reuseKnownCommentIds(items, known) {
  const used = new Set(), renamed = new Map();
  const ids = new Set(known.map(row => row.commentId));
  for (const item of items) if (ids.has(item.commentId)) used.add(item.commentId);
  const mapped = items.map(item => {
    if (used.has(item.commentId) && ids.has(item.commentId)) return item;
    const match = known.find(row => !used.has(row.commentId) && commentNamesAgree(row.authorName, item.authorName)
      && commentTextsAgree(row.content, item.content));
    if (!match) return item;
    used.add(match.commentId);
    renamed.set(item.commentId, match.commentId);
    return {...item, commentId: match.commentId};
  });
  return mapped.map(item => renamed.has(item.parentCommentId) ? {...item, parentCommentId: renamed.get(item.parentCommentId)} : item);
}

/** Comments already known for a Channels post: stored rows and the last capture's list (its rows may still be queued). */
export async function knownWechatComments(tx, tenantId, externalId, platform = 'wechat_channels') {
  const rows = await tx.queryAll(`SELECT c.external_comment_id AS "commentId", c.author_name AS "authorName", c.content
    FROM record_comments c JOIN records r ON r.id = c.record_id AND r.tenant_id = c.tenant_id
    WHERE r.tenant_id = $1 AND r.platform = $3 AND r.external_id = $2 AND c.external_comment_id LIKE 'wxcc_%'
    ORDER BY c.floor_index, c.created_at LIMIT 2000`, [tenantId, externalId, platform]);
  const latest = await tx.queryOne(`SELECT payload->'commentsCleanedItems' AS items FROM records
    WHERE tenant_id = $1 AND platform = $3 AND external_id = $2`, [tenantId, externalId, platform]);
  const seen = new Set(rows.map(row => row.commentId));
  for (const item of Array.isArray(latest?.items) ? latest.items : []) {
    if (typeof item?.commentId === 'string' && item.commentId.startsWith('wxcc_') && !seen.has(item.commentId)) {
      seen.add(item.commentId);
      rows.push({commentId: item.commentId, authorName: String(item.authorName ?? ''), content: String(item.content ?? '')});
    }
  }
  return rows;
}

/** The /api/sync body the browser would send for this post: detail values, the server's keyword and lineage. */
export function wechatSyncBody(event, {keyword, taskId, attemptId, requestHash}) {
  if (event.platform === ARTICLE_PLATFORM) return articleSyncBody(event, {keyword, taskId, attemptId, requestHash}, wechatComments);
  const externalId = wechatExternalId(event.preview.createtime, event.preview.nickname);
  const {preview} = event;
  const firstLine = preview.description.split(/\r?\n/u).find(line => line.trim())?.trim() ?? '';
  const detail = {likes: preview.favCountFmt, collects: preview.likeCountFmt, shares: preview.forwardCountFmt, comments: preview.commentCountFmt,
    publishTime: beijing(preview.createtime)};
  return {externalId, body: {syncType: 'keyword_notes', captureTaskId: taskId, captureTaskItemAttemptId: attemptId,
    captureTaskItemRequestHash: requestHash,
    payload: {noteId: externalId, platform: 'wechat_channels', title: truncateWellFormed(firstLine, 120), content: preview.description,
      author: preview.nickname, authorAvatar: preview.avatarUrl, url: event.shareUrl, coverImageUrl: preview.coverUrl,
      noteType: preview.isImage ? 'image' : 'video', publishTime: beijing(preview.createtime), keyword, rankPosition: event.rank ?? undefined,
      detailCaptureStatus: 'done', detailPayload: detail, ...detail,
      commentsCleanedItems: wechatComments(externalId, event.comments, event.capturedAt),
      commentsCaptureStatus: event.comments.status, commentsTotalCaptured: event.comments.items.length,
      captureTimestamp: event.capturedAt,
      wechatChannels: {exportId: preview.exportId, mode: event.mode, cardSnippet: event.card.snippet, cardTimeLabel: event.card.timeLabel,
        commentHeaderCount: event.comments.headerCount,
        // Raw App counts by their 8.0.80 labels: 喜欢 (thumb, fav) and 推荐 (heart, like).
        appCounts: {xihuan: preview.favCountFmt, tuijian: preview.likeCountFmt, zhuanfa: preview.forwardCountFmt, pinglun: preview.commentCountFmt}}}}};
}

/**
 * Historical ownership of one event: the attempt is this phone's, on a Channels run, and the capture happened
 * during it. Current state is not required: a post read before a stop or a lease loss is still a real post.
 * Returns the stored receipt for a replay, or the lineage to write a new one.
 */
export async function postLineage(tx, principal, event) {
  await lockAgent(tx, principal.tenantId, principal.agentId, principal);
  const previous = await tx.queryOne(`SELECT * FROM capture_mobile_post_receipts WHERE tenant_id=$1 AND agent_id=$2 AND event_key=$3`,
    [principal.tenantId, principal.agentId, event.eventId]);
  if (previous) {
    if (previous.payload_hash !== event.payloadHash) fail('EVENT_PAYLOAD_CONFLICT', 409);
    return {previous};
  }
  const lineage = await tx.queryOne(`SELECT attempt.started_at, attempt.finished_at, item.keyword, task.metadata->>'workflow' AS workflow, task.platform AS task_platform, item.platform AS item_platform,
      (item.metadata->>'attemptId' = attempt.id::text AND item.assignment_revision = attempt.assignment_revision
        AND item.execution_task_id = attempt.execution_task_id AND item.assigned_agent_id = attempt.agent_id) AS current
    FROM capture_task_item_attempts attempt
    JOIN capture_task_items item ON item.id = attempt.item_id AND item.tenant_id = attempt.tenant_id
    JOIN capture_tasks task ON task.id = attempt.execution_task_id AND task.tenant_id = attempt.tenant_id
    WHERE attempt.id=$1 AND attempt.tenant_id=$2 AND attempt.item_id=$3 AND attempt.agent_id=$4 AND attempt.execution_task_id=$5
      AND attempt.assignment_revision=$6 AND attempt.request_hash=$7`,
  [event.attemptId, principal.tenantId, event.itemId, principal.agentId, event.taskId, event.assignmentRevision, event.requestHash]);
  if (!lineage || lineage.workflow !== mobileWorkflowFor(event.platform) || lineage.task_platform !== event.platform || lineage.item_platform !== event.platform) throw new DiscoveryError('ATTEMPT_LINEAGE_MISMATCH', 403);
  const started = Date.parse(lineage.started_at), finished = lineage.finished_at ? Date.parse(lineage.finished_at) : null;
  const inWindow = event.capturedAt >= started - SKEW_MS && (finished === null || event.capturedAt <= finished + SKEW_MS);
  return {lineage: {...lineage, inWindow}};
}

export async function saveReceipt(tx, principal, uploadBatchId, event, {status, reason = '', externalId = '', recordId = null, observationId = null}) {
  const row = await tx.queryOne(`INSERT INTO capture_mobile_post_receipts(tenant_id, agent_id, task_id, item_id, attempt_id, event_key,
      upload_batch_id, payload_hash, external_id, status, reason, record_id, observation_id, platform)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (tenant_id, agent_id, event_key) DO NOTHING RETURNING *`,
  [principal.tenantId, principal.agentId, event.taskId, event.itemId, event.attemptId, event.eventId, uploadBatchId, event.payloadHash,
    externalId, status, String(reason).slice(0, 120), recordId, observationId, event.platform]);
  return row ?? tx.queryOne('SELECT * FROM capture_mobile_post_receipts WHERE tenant_id=$1 AND agent_id=$2 AND event_key=$3',
    [principal.tenantId, principal.agentId, event.eventId]);
}

export const receiptView = row => ({eventId: row.event_key, status: row.status, ...(row.status === 'accepted' ? {receiptId: row.id} : {}),
  reason: row.reason || undefined, recordId: row.record_id || undefined});

export async function batchReceipts(tx, principal, uploadBatchId) {
  await lockAgent(tx, principal.tenantId, principal.agentId, principal);
  const rows = await tx.queryAll(`SELECT * FROM capture_mobile_post_receipts WHERE tenant_id=$1 AND agent_id=$2 AND upload_batch_id=$3
    ORDER BY received_at`, [principal.tenantId, principal.agentId, requireUuid(uploadBatchId, 'batchId')]);
  return {uploadBatchId, receipts: rows.map(receiptView)};
}
