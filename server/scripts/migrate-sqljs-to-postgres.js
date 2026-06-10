/**
 * One-time migration from the old sql.js database file to PostgreSQL.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/migrate-sqljs-to-postgres.js
 */

import initSqlJs from 'sql.js';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDb, closeDb, queryAll, queryOne, execute, getDefaultTenantId } from '../db/init.js';
import { upsertCapturedRecord } from '../services/record-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LEGACY_DB_PATH = join(__dirname, '..', 'data', 'onstarvoice.db');

function legacyAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

async function insertSettings(tenantId, settings) {
  for (const row of settings) {
    await execute(`
      INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (tenant_id, key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `, [tenantId, row.key, row.value ?? '']);
  }
}

async function insertAuthCodes(tenantId, codes, bindings) {
  const idMap = new Map();
  for (const code of codes) {
    const inserted = await queryOne(`
      INSERT INTO auth_codes (
        tenant_id, code, owner_email, owner_name, type, status,
        created_at, expires_at, max_bindings, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8, $9, $10)
      ON CONFLICT (code)
      DO UPDATE SET
        tenant_id = excluded.tenant_id,
        owner_email = excluded.owner_email,
        owner_name = excluded.owner_name,
        type = excluded.type,
        status = excluded.status,
        expires_at = excluded.expires_at,
        max_bindings = excluded.max_bindings,
        notes = excluded.notes
      RETURNING id
    `, [
      tenantId,
      code.code,
      code.owner_email || '',
      code.owner_name || '',
      code.type || 'trial',
      code.status || 'active',
      code.created_at || null,
      code.expires_at || null,
      Number(code.max_bindings || 3),
      code.notes || '',
    ]);
    idMap.set(Number(code.id), inserted.id);
  }

  for (const binding of bindings) {
    const codeId = idMap.get(Number(binding.code_id));
    if (!codeId) continue;
    await execute(`
      INSERT INTO auth_bindings (code_id, fingerprint, user_agent, bound_at, last_seen_at)
      VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), COALESCE($5::timestamptz, now()))
      ON CONFLICT (code_id, fingerprint)
      DO UPDATE SET user_agent = excluded.user_agent, last_seen_at = excluded.last_seen_at
    `, [
      codeId,
      binding.fingerprint,
      binding.user_agent || '',
      binding.bound_at || null,
      binding.last_seen_at || null,
    ]);
  }
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function firstPayloadItem(payload) {
  if (!Array.isArray(payload?.items)) return {};
  return payload.items.find(item => item && typeof item === 'object' && !Array.isArray(item)) || {};
}

function firstArrayValue(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function stringArrayJson(value, fallback = '[]') {
  if (!value) return fallback;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') return value || fallback;
  return JSON.stringify(value);
}

function legacyRecordToSyncRecord(row) {
  const payload = parseJsonObject(row.payload);
  const listItem = firstPayloadItem(payload);
  const detailPayload = payload.detailPayload || listItem.detailPayload || {};
  const get = (...keys) => {
    for (const key of keys) {
      if (row[key] != null && row[key] !== '') return row[key];
      if (detailPayload[key] != null && detailPayload[key] !== '') return detailPayload[key];
      if (listItem[key] != null && listItem[key] !== '') return listItem[key];
      if (payload[key] != null && payload[key] !== '') return payload[key];
    }
    return '';
  };
  const getPayloadOnly = (...keys) => {
    for (const key of keys) {
      if (detailPayload[key] != null && detailPayload[key] !== '') return detailPayload[key];
      if (listItem[key] != null && listItem[key] !== '') return listItem[key];
      if (payload[key] != null && payload[key] !== '') return payload[key];
    }
    return '';
  };
  const metric = (rowValue, dimension, ...keys) => {
    const rowNumber = Number(rowValue || 0);
    if (rowNumber > 0) return rowNumber;
    const direct = Number(getPayloadOnly(...keys) || 0);
    if (direct > 0) return direct;
    const displayDimension = String(getPayloadOnly('displayMetricDimension'));
    const displayCount = Number(getPayloadOnly('displayMetricCount') || 0);
    return displayDimension === dimension ? displayCount : 0;
  };
  const extractedExternalId = String(get('external_id', 'noteId', 'id', 'externalId'));
  const extractedUrl = String(get('url', 'noteUrl', 'detailPageUrl'));
  const extractedTitle = String(get('title', 'noteTitle'));
  const extractedContent = String(get('content', 'noteContent', 'fullContent', 'body', 'desc'));
  const extractedAuthor = String(get('author_name', 'authorName', 'author'));
  const hasStableIdentity = Boolean(
    extractedExternalId || extractedUrl || extractedTitle || extractedContent || get('author_id', 'authorId') || extractedAuthor
  );
  return {
    external_id: extractedExternalId || (hasStableIdentity ? '' : `legacy:${row.id}`),
    platform: String(get('platform') || 'unknown'),
    record_type: String(get('record_type', 'syncType', 'recordType') || 'single_note'),
    title: extractedTitle,
    content: extractedContent,
    author_name: extractedAuthor,
    author_id: String(get('author_id', 'authorId', 'authorUserId')),
    author_avatar: String(get('author_avatar', 'authorAvatar', 'avatarUrl')),
    author_fans: Number(get('author_fans', 'bloggerFollowersCount', 'authorFans', 'authorFollowerCount') || 0),
    url: extractedUrl,
    cover_url: String(get('cover_url', 'coverImageUrl', 'coverUrl', 'cover')),
    note_type: String(get('note_type', 'noteType', 'type')),
    likes: metric(row.likes, 'likes', 'likes', 'likeCount', 'attitudes_count', 'attitudesCount'),
    comments_count: metric(row.comments_count, 'comments', 'comments', 'commentCount', 'commentsCount', 'comments_count'),
    collects: metric(row.collects, 'collects', 'collects', 'collectCount'),
    shares: metric(row.shares, 'shares', 'shares', 'shareCount', 'reposts', 'repostCount', 'repostsCount', 'reposts_count'),
    publish_time: String(get('publish_time', 'publishTime', 'publishDate', 'publishDateRaw', 'lastEditedAt')),
    tags: stringArrayJson(row.tags && row.tags !== '[]' ? row.tags : firstArrayValue(detailPayload.tags, listItem.tags, payload.tags)),
    blogger_profile_url: String(get('blogger_profile_url', 'bloggerProfileUrl', 'authorUrl')),
    image_urls: stringArrayJson(row.image_urls && row.image_urls !== '[]' ? row.image_urls : firstArrayValue(detailPayload.imageUrls, listItem.imageUrls, payload.imageUrls)),
    comments_text: String(get('comments_text', 'commentsMergedText')),
    blogger_liked_collected: Number(get('blogger_liked_collected', 'bloggerLikedAndCollectedCount', 'bloggerLikedCollected') || 0),
    blogger_account_type: String(get('blogger_account_type', 'bloggerAccountType', 'accountType')),
    video_url: String(get('video_url', 'videoUrl', 'videoLink')),
    audio_url: String(get('audio_url', 'audioUrl')),
    video_duration: String(get('video_duration', 'videoDuration', 'videoTime', 'duration')),
    comments_capture_status: String(get('comments_capture_status', 'commentsCaptureStatus')),
    comments_total_captured: Number(get('comments_total_captured', 'commentsTotalCaptured') || 0),
    capture_timestamp: String(get('capture_timestamp', 'captureTimestamp') || row.created_at || ''),
    keyword: String(get('keyword')),
    payload: row.payload || '{}',
  };
}

async function insertRecords(tenantId, records) {
  const idMap = new Map();
  for (const row of records) {
    const result = await upsertCapturedRecord(legacyRecordToSyncRecord(row), {
      tenantId,
      authCode: row.auth_code || '',
    });
    idMap.set(Number(row.id), result.id);

    await execute(`
      UPDATE records
      SET sentiment = $1,
        intent = $2,
        category = $3,
        subcategory = $4,
        source_type = $5,
        ai_summary = $6,
        ai_confidence = $7,
        ai_labeled_at = $8,
        created_at = COALESCE($9::timestamptz, created_at),
        updated_at = COALESCE($10::timestamptz, updated_at)
      WHERE id = $11
    `, [
      row.sentiment || '',
      row.intent || '',
      row.category || '',
      row.subcategory || '',
      row.source_type || '',
      row.ai_summary || '',
      Number(row.ai_confidence || 0),
      row.ai_labeled_at || null,
      row.created_at || null,
      row.updated_at || null,
      result.id,
    ]);
  }
  return idMap;
}

async function insertAlerts(tenantId, alerts, recordIdMap) {
  for (const alert of alerts) {
    await execute(`
      INSERT INTO alerts (
        tenant_id, record_id, level, reason, title, summary, url,
        interaction_total, notified, notified_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, now()))
    `, [
      tenantId,
      recordIdMap.get(Number(alert.record_id)) || null,
      alert.level || 'info',
      alert.reason || '',
      alert.title || '',
      alert.summary || '',
      alert.url || '',
      Number(alert.interaction_total || 0),
      Boolean(alert.notified),
      alert.notified_at || null,
      alert.created_at || null,
    ]);
  }
}

async function main() {
  if (!existsSync(LEGACY_DB_PATH)) {
    console.log(`[LegacyMigration] No legacy DB found at ${LEGACY_DB_PATH}`);
    return;
  }

  await initDb();
  const SQL = await initSqlJs();
  const legacyDb = new SQL.Database(readFileSync(LEGACY_DB_PATH));
  const tenantId = await getDefaultTenantId();

  const settings = legacyAll(legacyDb, 'SELECT * FROM settings');
  const authCodes = legacyAll(legacyDb, 'SELECT * FROM auth_codes');
  const authBindings = legacyAll(legacyDb, 'SELECT * FROM auth_bindings');
  const records = legacyAll(legacyDb, 'SELECT * FROM records');
  const alerts = legacyAll(legacyDb, 'SELECT * FROM alerts');

  await insertSettings(tenantId, settings);
  await insertAuthCodes(tenantId, authCodes, authBindings);
  const recordIdMap = await insertRecords(tenantId, records);
  await insertAlerts(tenantId, alerts, recordIdMap);

  legacyDb.close();

  const counts = {
    settings: settings.length,
    authCodes: authCodes.length,
    authBindings: authBindings.length,
    records: records.length,
    alerts: alerts.length,
    postgresRecords: (await queryOne('SELECT COUNT(*) as n FROM records WHERE tenant_id = $1', [tenantId])).n,
    postgresAuthCodes: (await queryOne('SELECT COUNT(*) as n FROM auth_codes WHERE tenant_id = $1', [tenantId])).n,
  };
  console.log('[LegacyMigration] Complete:', counts);
}

main()
  .catch(err => {
    console.error('[LegacyMigration] Failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
