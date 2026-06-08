import { Router } from 'express';
import { queryOne, execute } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
import { labelRecord } from '../services/ai-labeler.js';
import { checkAlerts } from '../services/alert-engine.js';

const router = Router();

function normalizeRecord(body) {
  // 扩展端 batch sync 格式: { records: [{ recordId, syncType, payload: {...} }] }
  // 扩展端 single sync 格式: { syncType, payload: {...} }
  // 兼容旧格式: { payload: [...] } 或 { data: [...] }
  let rawItems;
  if (Array.isArray(body.records)) {
    rawItems = body.records.map(r => ({
      ...(r.payload || {}),
      syncType: r.syncType || r.type || body.syncType,
      recordId: r.recordId || r.id,
    }));
  } else if (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)) {
    rawItems = [{ ...body.payload, syncType: body.syncType }];
  } else {
    const payload = body.payload || body.data || body;
    rawItems = Array.isArray(payload) ? payload : [payload];
  }

  return rawItems.map(item => {
    // 扩展端的笔记详情数据嵌套在 detailPayload 中
    const dp = item.detailPayload || {};
    // 优先从 detailPayload 提取，其次从顶层 item
    const get = (...keys) => {
      for (const k of keys) {
        if (dp[k] != null && dp[k] !== '') return dp[k];
        if (item[k] != null && item[k] !== '') return item[k];
      }
      return '';
    };

    return {
      external_id: String(get('noteId', 'id', 'externalId')),
      platform: String(item.platform || body.platform || 'xiaohongshu'),
      record_type: String(item.syncType || item.recordType || body.syncType || 'single_note'),
      title: String(get('title')),
      content: String(get('content', 'desc')),
      author_name: String(get('author', 'authorName')),
      author_id: String(get('authorId', 'authorUserId')),
      author_avatar: String(get('authorAvatar')),
      author_fans: Number(get('bloggerFollowersCount', 'authorFans', 'authorFollowerCount') || 0),
      url: String(get('url', 'noteUrl')),
      cover_url: String(get('coverImageUrl', 'cover')),
      note_type: String(get('noteType')),
      likes: Number(get('likes', 'likeCount') || 0),
      comments_count: Number(get('comments', 'commentCount', 'commentsCount', 'comments_count') || 0),
      collects: Number(get('collects', 'collectCount') || 0),
      shares: Number(get('shares', 'shareCount') || 0),
      publish_time: String(get('publishTime', 'publishDate', 'lastEditedAt')),
      tags: JSON.stringify(Array.isArray(dp.tags || item.tags) ? (dp.tags || item.tags) : []),
      // CSV 对齐新增字段
      blogger_profile_url: String(get('bloggerProfileUrl', 'authorUrl')),
      image_urls: JSON.stringify(dp.imageUrls || item.imageUrls || []),
      comments_text: String(get('commentsMergedText')),
      blogger_liked_collected: Number(get('bloggerLikedAndCollectedCount', 'bloggerLikedCollected') || 0),
      blogger_account_type: String(get('bloggerAccountType', 'accountType')),
      video_url: String(get('videoUrl', 'videoLink', 'video_url')),
      audio_url: String(get('audioUrl', 'audio_url')),
      video_duration: String(get('videoDuration', 'videoTime', 'duration')),
      comments_capture_status: String(get('commentsCaptureStatus')),
      comments_total_captured: Number(get('commentsTotalCaptured') || 0),
      capture_timestamp: String(get('captureTimestamp') || item.captureTimestamp || ''),
      keyword: String(item.keyword || body.keyword || ''),
      payload: JSON.stringify(item),
    };
  });
}

function insertRecord(record, authCode) {
  if (record.external_id) {
    const existing = queryOne(
      'SELECT id FROM records WHERE external_id = ? AND platform = ?',
      [record.external_id, record.platform]
    );

    if (existing) {
      execute(`
        UPDATE records SET
          likes = ?, comments_count = ?, collects = ?, shares = ?,
          author_fans = ?, blogger_liked_collected = ?,
          comments_text = ?, comments_capture_status = ?, comments_total_captured = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `, [
        record.likes, record.comments_count, record.collects, record.shares,
        record.author_fans, record.blogger_liked_collected,
        record.comments_text, record.comments_capture_status, record.comments_total_captured,
        existing.id
      ]);
      return { id: existing.id, action: 'updated' };
    }
  }

  const result = execute(`
    INSERT INTO records (
      external_id, platform, record_type, title, content,
      author_name, author_id, author_avatar, author_fans,
      url, cover_url, note_type,
      likes, comments_count, collects, shares,
      publish_time, tags,
      blogger_profile_url, image_urls, comments_text,
      blogger_liked_collected, blogger_account_type,
      video_url, audio_url, video_duration,
      comments_capture_status, comments_total_captured,
      capture_timestamp,
      keyword, payload, auth_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.external_id, record.platform, record.record_type,
    record.title, record.content,
    record.author_name, record.author_id, record.author_avatar, record.author_fans,
    record.url, record.cover_url, record.note_type,
    record.likes, record.comments_count, record.collects, record.shares,
    record.publish_time, record.tags,
    record.blogger_profile_url, record.image_urls, record.comments_text,
    record.blogger_liked_collected, record.blogger_account_type,
    record.video_url, record.audio_url, record.video_duration,
    record.comments_capture_status, record.comments_total_captured,
    record.capture_timestamp,
    record.keyword, record.payload, authCode
  ]);

  return { id: result.lastInsertRowid, action: 'inserted' };
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const records = normalizeRecord(req.body);
    if (records.length === 0) {
      return res.json({ ok: false, error: 'invalid_payload', message: '没有可同步的数据' });
    }

    const record = records[0];
    const result = insertRecord(record, req.authCode);

    if (result.action === 'inserted') {
      setImmediate(async () => {
        try {
          await labelRecord(result.id);
          await checkAlerts(result.id);
        } catch (err) {
          console.error('[Sync] AI labeling/alert error:', err.message);
        }
      });
    }

    // 返回扩展端期望的格式
    return res.json({ ok: true, recordId: result.id, action: result.action });
  } catch (err) {
    console.error('[Sync] Error:', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
  }
});

router.post('/batch', requireAuth, async (req, res) => {
  try {
    const allRecords = normalizeRecord(req.body);
    const batchRecords = Array.isArray(req.body.records) ? req.body.records : [];

    if (allRecords.length === 0) {
      return res.json({ ok: false, error: 'invalid_payload', message: '没有可同步的数据' });
    }

    const results = [];
    const insertedIds = [];

    for (let i = 0; i < allRecords.length; i++) {
      const record = allRecords[i];
      const result = insertRecord(record, req.authCode);
      // 获取对应的原始 recordId（从扩展端发来的）
      const originalRecordId = batchRecords[i]?.recordId || batchRecords[i]?.id || record.external_id || '';
      results.push({
        ...result,
        recordId: originalRecordId,
        ok: true,
      });
      if (result.action === 'inserted') insertedIds.push(result.id);
    }

    if (insertedIds.length > 0) {
      setImmediate(async () => {
        for (const id of insertedIds) {
          try {
            await labelRecord(id);
            await checkAlerts(id);
          } catch (err) {
            console.error(`[Sync] Batch AI error for record ${id}:`, err.message);
          }
        }
      });
    }

    const inserted = results.filter(r => r.action === 'inserted').length;
    const updated = results.filter(r => r.action === 'updated').length;

    // 返回扩展端期望的格式: { ok: true, data: { items: [{ recordId, ok: true }] } }
    return res.json({
      ok: true,
      data: {
        items: results,
        total: results.length,
        inserted,
        updated,
      },
    });
  } catch (err) {
    console.error('[Sync] Batch error:', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
  }
});

export default router;
