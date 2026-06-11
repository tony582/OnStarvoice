import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { labelRecord } from '../services/ai-labeler.js';
import { checkAlerts } from '../services/alert-engine.js';
import { upsertCapturedRecord } from '../services/record-store.js';
import { upsertRecordComments } from '../services/comment-workflow.js';

const router = Router();
const commentWorkflowQueue = [];
let commentWorkflowRunning = false;

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function firstPayloadItem(payload) {
  if (!Array.isArray(payload?.items)) return {};
  const item = payload.items.find(entry => isPlainObject(entry));
  return item || {};
}

function firstArrayValue(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function uniqueArray(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = typeof value === 'string'
      ? value.trim()
      : (value && typeof value === 'object' ? JSON.stringify(value) : String(value || '').trim());
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

function mergedArrayValue(...values) {
  return uniqueArray(values.flatMap(value => Array.isArray(value) ? value : []));
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function countCommentWorkflowItems(record) {
  return (
    parseJsonArray(record.comments_cleaned_items).length +
    parseJsonArray(record.official_reply_items).length
  );
}

function queuedCommentStats(total) {
  return {
    queued: true,
    total,
    inserted: 0,
    updated: 0,
    negative: 0,
    officialResponses: 0,
    officialContent: false,
    officialResponseStatus: 'queued',
  };
}

function enqueueCommentWorkflow(task) {
  if (typeof task !== 'function') return;
  commentWorkflowQueue.push(task);
  void drainCommentWorkflowQueue();
}

async function drainCommentWorkflowQueue() {
  if (commentWorkflowRunning) return;
  commentWorkflowRunning = true;
  try {
    while (commentWorkflowQueue.length > 0) {
      const task = commentWorkflowQueue.shift();
      try {
        await task();
      } catch (err) {
        console.error('[Sync] Queued comment workflow error:', err.message);
      }
    }
  } finally {
    commentWorkflowRunning = false;
  }
}

function normalizeRecord(body) {
  let rawItems;
  if (Array.isArray(body.records)) {
    rawItems = body.records.map(r => ({
      ...r,
      ...(r.payload || {}),
      syncType: r.syncType || r.type || body.syncType,
      platform: r.platform || r.payload?.platform || body.platform,
      workflow: r.workflow || body.workflow,
      recordId: r.recordId || r.id,
      monitorExecutionId: r.monitorExecutionId || body.monitorExecutionId,
    }));
  } else if (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)) {
    rawItems = [{ ...body.payload, syncType: body.syncType, monitorExecutionId: body.monitorExecutionId }];
  } else {
    const payload = body.payload || body.data || body;
    rawItems = Array.isArray(payload) ? payload : [payload];
  }

  return rawItems.map(item => {
    const listItem = firstPayloadItem(item);
    const dp = item.detailPayload || listItem.detailPayload || {};
    const get = (...keys) => {
      for (const k of keys) {
        if (dp[k] != null && dp[k] !== '') return dp[k];
        if (listItem[k] != null && listItem[k] !== '') return listItem[k];
        if (item[k] != null && item[k] !== '') return item[k];
      }
      return '';
    };
    const tags = mergedArrayValue(
      dp.tags, listItem.tags, item.tags,
      dp.hashtags, listItem.hashtags, item.hashtags,
      dp.topics, listItem.topics, item.topics
    );
    const imageUrls = firstArrayValue(dp.imageUrls, listItem.imageUrls, item.imageUrls, dp.images, listItem.images, item.images);
    const commentsCleanedItems = firstArrayValue(
      dp.commentsCleanedItems, listItem.commentsCleanedItems, item.commentsCleanedItems,
      dp.commentItems, listItem.commentItems, item.commentItems
    );
    const officialReplyItems = firstArrayValue(dp.officialReplyItems, listItem.officialReplyItems, item.officialReplyItems);

    return {
      external_id: String(get('noteId', 'id', 'externalId')),
      platform: String(get('platform') || item.platform || body.platform || 'xiaohongshu'),
      record_type: String(item.syncType || item.recordType || body.syncType || 'single_note'),
      title: String(get('title', 'noteTitle')),
      content: String(get('content', 'noteContent', 'fullContent', 'body', 'desc')),
      author_name: String(get('author', 'authorName')),
      author_id: String(get('authorId', 'authorUserId')),
      author_avatar: String(get('authorAvatar', 'avatarUrl')),
      author_fans: Number(get('bloggerFollowersCount', 'authorFans', 'authorFollowerCount') || 0),
      url: String(get('url', 'noteUrl')),
      cover_url: String(get('coverImageUrl', 'coverUrl', 'cover')),
      note_type: String(get('noteType', 'type', 'mediaType', 'media_type')),
      source_type: String(get('sourceType', 'source_type')),
      likes: Number(get('likes', 'likeCount', 'attitudes_count', 'attitudesCount') || 0),
      comments_count: Number(get('comments', 'commentCount', 'commentsCount', 'comments_count') || 0),
      collects: Number(get('collects', 'collectCount') || 0),
      shares: Number(get('shares', 'shareCount', 'reposts', 'repostCount', 'repostsCount', 'reposts_count') || 0),
      publish_time: String(get('publishTime', 'publishDate', 'publishDateRaw', 'lastEditedAt')),
      tags: JSON.stringify(tags),
      blogger_profile_url: String(get('bloggerProfileUrl', 'authorProfileUrl', 'authorUrl', 'profileUrl')),
      image_urls: JSON.stringify(imageUrls),
      comments_text: String(get('commentsMergedText')),
      comments_cleaned_items: JSON.stringify(commentsCleanedItems),
      official_reply_detected: boolValue(get('officialReplyDetected'), false),
      official_reply_items: JSON.stringify(officialReplyItems),
      skip_official_accounts: boolValue(get('skipOfficialAccounts'), true),
      blogger_liked_collected: Number(get('bloggerLikedAndCollectedCount', 'bloggerLikedCollected') || 0),
      blogger_account_type: String(get('bloggerAccountType', 'accountType')),
      video_url: String(get('videoUrl', 'videoLink', 'video_url')),
      audio_url: String(get('audioUrl', 'audio_url')),
      video_duration: String(get('videoDuration', 'videoTime', 'duration')),
      comments_capture_status: String(get('commentsCaptureStatus')),
      comments_total_captured: Number(get('commentsTotalCaptured') || 0),
      capture_timestamp: String(get('captureTimestamp') || item.captureTimestamp || ''),
      keyword: String(item.keyword || body.keyword || ''),
      rank_position: Number(get('rankPosition', 'rank_position', 'rank') || item.rankPosition || item.rank_position || 0) || null,
      monitorExecutionId: item.monitorExecutionId || body.monitorExecutionId || null,
      payload: JSON.stringify(item),
    };
  });
}

function queueAiJobs(recordIds) {
  if (!recordIds.length) return;
  setImmediate(async () => {
    for (const id of recordIds) {
      try {
        const result = await labelRecord(id);
        if (result?.relevance === 'irrelevant') continue;
        await checkAlerts(id);
      } catch (err) {
        console.error(`[Sync] AI/alert error for record ${id}:`, err.message);
      }
    }
  });
}

async function applyCommentWorkflow(record, result, req) {
  try {
    return await upsertRecordComments(result.id, record, {
      tenantId: req.tenantId,
      authCode: req.authCode,
    });
  } catch (err) {
    console.error(`[Sync] Comment workflow error for record ${result.id}:`, err.message);
    return { error: err.message, inserted: 0, updated: 0, negative: 0, officialResponses: 0, officialContent: false };
  }
}

function queueCommentWorkflow(record, result, context) {
  const total = countCommentWorkflowItems(record);
  enqueueCommentWorkflow(async () => {
    const commentStats = await applyCommentWorkflow(record, result, context);
    if (result.action === 'inserted' && !commentStats.officialContent) {
      queueAiJobs([result.id]);
    }
  });
  return queuedCommentStats(total);
}

async function applyOrQueueCommentWorkflow(record, result, context) {
  const commentCount = countCommentWorkflowItems(record);
  if (commentCount > 0) {
    return queueCommentWorkflow(record, result, context);
  }
  return await applyCommentWorkflow(record, result, context);
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const records = normalizeRecord(req.body);
    if (records.length === 0) {
      return res.json({ ok: false, error: 'invalid_payload', message: '没有可同步的数据' });
    }

    const record = records[0];
    const result = await upsertCapturedRecord(record, {
      tenantId: req.tenantId,
      authCode: req.authCode,
      monitorExecutionId: record.monitorExecutionId,
    });
    const commentStats = await applyOrQueueCommentWorkflow(record, result, {
      tenantId: req.tenantId,
      authCode: req.authCode,
    });

    if (result.action === 'inserted' && !commentStats.queued && !commentStats.officialContent) queueAiJobs([result.id]);

    return res.json({
      ok: true,
      recordId: result.id,
      action: result.action,
      observationId: result.observationId,
      commentStats,
    });
  } catch (err) {
    console.error('[Sync] Error:', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
  }
});

router.post('/batch', requireAuth, async (req, res) => {
  const allRecords = normalizeRecord(req.body);
  const batchRecords = Array.isArray(req.body.records) ? req.body.records : [];

  if (allRecords.length === 0) {
    return res.json({ ok: false, error: 'invalid_payload', message: '没有可同步的数据' });
  }

  const results = [];
  const insertedIds = [];

  for (let i = 0; i < allRecords.length; i++) {
    const record = allRecords[i];
    const originalRecordId = batchRecords[i]?.recordId || batchRecords[i]?.id || record.external_id || '';
    try {
      const result = await upsertCapturedRecord(record, {
        tenantId: req.tenantId,
        authCode: req.authCode,
        monitorExecutionId: record.monitorExecutionId,
      });
      const commentStats = await applyOrQueueCommentWorkflow(record, result, {
        tenantId: req.tenantId,
        authCode: req.authCode,
      });
      results.push({
        ok: true,
        ...result,
        recordId: originalRecordId,
        backendRecordId: result.id,
        commentStats,
      });
      if (result.action === 'inserted' && !commentStats.queued && !commentStats.officialContent) insertedIds.push(result.id);
    } catch (err) {
      const message = err?.message || '同步失败';
      results.push({
        ok: false,
        recordId: originalRecordId,
        action: 'skipped',
        reason: 'server_error',
        message,
        error: {
          reason: 'server_error',
          message,
        },
      });
    }
  }

  queueAiJobs(insertedIds);

  const inserted = results.filter(r => r.action === 'inserted').length;
  const updated = results.filter(r => r.action === 'updated').length;
  const failed = results.filter(r => !r.ok).length;

  return res.json({
    ok: true,
    data: {
      items: results,
      total: results.length,
      inserted,
      updated,
      failed,
    },
  });
});

export default router;
