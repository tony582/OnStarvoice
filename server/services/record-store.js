import crypto from 'crypto';
import { withTransaction } from '../db/init.js';

const VERSION_FIELDS = [
  'title', 'content', 'author_name', 'author_id', 'author_avatar', 'url', 'cover_url',
  'tags', 'image_urls', 'comments_text', 'video_url', 'audio_url', 'payload',
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const noisyParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    noisyParams.forEach(param => parsed.searchParams.delete(param));
    return parsed.toString();
  } catch {
    return String(url).trim();
  }
}

function jsonText(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return fallback;
    }
  }
  return JSON.stringify(value);
}

function cleanNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function meaningful(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value !== '' && value !== '[]' && value !== '{}';
  return true;
}

function compareValue(existingValue, nextValue) {
  if (!meaningful(nextValue)) return false;
  if (Array.isArray(existingValue) || typeof existingValue === 'object') {
    return JSON.stringify(existingValue ?? null) !== String(nextValue);
  }
  return String(existingValue ?? '') !== String(nextValue);
}

function buildContentHash(record, canonicalUrl) {
  if (record.external_id) return '';
  const base = [
    record.platform || '',
    canonicalUrl || record.url || '',
    record.author_id || record.author_name || '',
    record.title || '',
    record.content || '',
  ].join('\n').trim();
  return base ? sha256(base) : '';
}

function detectChangedFields(existing, record) {
  const changed = [];
  for (const field of VERSION_FIELDS) {
    if (compareValue(existing[field], record[field])) changed.push(field);
  }
  return changed;
}

function versionPayload(existing, fields) {
  const data = {};
  for (const field of fields) data[field] = existing[field] ?? null;
  return data;
}

async function insertObservation(tx, { tenantId, recordId, authCode, monitorExecutionId, record }) {
  const result = await tx.queryOne(`
    INSERT INTO record_observations (
      tenant_id, record_id, monitor_execution_id, source_auth_code,
      platform, keyword, rank_position,
      likes, comments_count, collects, shares,
      captured_at, payload
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7,
      $8, $9, $10, $11,
      now(), $12::jsonb
    )
    RETURNING id
  `, [
    tenantId, recordId, monitorExecutionId || null, authCode || '',
    record.platform || 'unknown', record.keyword || '', record.rank_position || null,
    cleanNumber(record.likes), cleanNumber(record.comments_count), cleanNumber(record.collects), cleanNumber(record.shares),
    jsonText(record.payload, '{}'),
  ]);

  await tx.execute(
    'UPDATE records SET latest_observation_id = $1, updated_at = now() WHERE id = $2',
    [result.id, recordId]
  );

  return result.id;
}

export async function upsertCapturedRecord(record, context) {
  const tenantId = context.tenantId;
  const authCode = context.authCode || '';
  const monitorExecutionId = context.monitorExecutionId || null;
  const canonicalUrl = normalizeUrl(record.url);
  const contentHash = buildContentHash(record, canonicalUrl);
  const tags = jsonText(record.tags, '[]');
  const imageUrls = jsonText(record.image_urls, '[]');
  const payload = jsonText(record.payload, '{}');

  return await withTransaction(async tx => {
    let existing = null;
    if (record.external_id) {
      existing = await tx.queryOne(
        'SELECT * FROM records WHERE tenant_id = $1 AND platform = $2 AND external_id = $3',
        [tenantId, record.platform, record.external_id]
      );
    }
    if (!existing && contentHash) {
      existing = await tx.queryOne(
        'SELECT * FROM records WHERE tenant_id = $1 AND platform = $2 AND content_hash = $3',
        [tenantId, record.platform, contentHash]
      );
    }

    if (existing) {
      const changedFields = detectChangedFields(existing, { ...record, tags, image_urls: imageUrls, payload });

      await tx.execute(`
        UPDATE records SET
          record_type = COALESCE(NULLIF($1, ''), record_type),
          title = COALESCE(NULLIF($2, ''), title),
          content = COALESCE(NULLIF($3, ''), content),
          author_name = COALESCE(NULLIF($4, ''), author_name),
          author_id = COALESCE(NULLIF($5, ''), author_id),
          author_avatar = COALESCE(NULLIF($6, ''), author_avatar),
          author_fans = $7,
          url = COALESCE(NULLIF($8, ''), url),
          canonical_url = COALESCE(NULLIF($9, ''), canonical_url),
          cover_url = COALESCE(NULLIF($10, ''), cover_url),
          note_type = COALESCE(NULLIF($11, ''), note_type),
          likes = $12,
          comments_count = $13,
          collects = $14,
          shares = $15,
          publish_time = COALESCE(NULLIF($16, ''), publish_time),
          tags = CASE WHEN $17::jsonb <> '[]'::jsonb THEN $17::jsonb ELSE tags END,
          blogger_profile_url = COALESCE(NULLIF($18, ''), blogger_profile_url),
          image_urls = CASE WHEN $19::jsonb <> '[]'::jsonb THEN $19::jsonb ELSE image_urls END,
          comments_text = COALESCE(NULLIF($20, ''), comments_text),
          comments_capture_status = COALESCE(NULLIF($21, ''), comments_capture_status),
          comments_total_captured = $22,
          blogger_liked_collected = $23,
          blogger_account_type = COALESCE(NULLIF($24, ''), blogger_account_type),
          video_url = COALESCE(NULLIF($25, ''), video_url),
          audio_url = COALESCE(NULLIF($26, ''), audio_url),
          video_duration = COALESCE(NULLIF($27, ''), video_duration),
          capture_timestamp = COALESCE(NULLIF($28, ''), capture_timestamp),
          keyword = COALESCE(NULLIF($29, ''), keyword),
          payload = $30::jsonb,
          auth_code = COALESCE(NULLIF($31, ''), auth_code),
          last_seen_at = now(),
          seen_count = seen_count + 1,
          updated_at = now()
        WHERE id = $32
      `, [
        record.record_type, record.title, record.content,
        record.author_name, record.author_id, record.author_avatar,
        cleanNumber(record.author_fans),
        record.url, canonicalUrl, record.cover_url, record.note_type,
        cleanNumber(record.likes), cleanNumber(record.comments_count), cleanNumber(record.collects), cleanNumber(record.shares),
        record.publish_time, tags,
        record.blogger_profile_url, imageUrls,
        record.comments_text, record.comments_capture_status, cleanNumber(record.comments_total_captured),
        cleanNumber(record.blogger_liked_collected),
        record.blogger_account_type,
        record.video_url, record.audio_url, record.video_duration,
        record.capture_timestamp,
        record.keyword,
        payload,
        authCode,
        existing.id,
      ]);

      const observationId = await insertObservation(tx, { tenantId, recordId: existing.id, authCode, monitorExecutionId, record: { ...record, payload } });

      if (changedFields.length > 0) {
        await tx.execute(`
          INSERT INTO record_versions (tenant_id, record_id, changed_fields, before_data, after_data)
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
        `, [
          tenantId,
          existing.id,
          changedFields,
          JSON.stringify(versionPayload(existing, changedFields)),
          JSON.stringify(versionPayload({ ...record, tags, image_urls: imageUrls, payload }, changedFields)),
        ]);
      }

      return { id: existing.id, action: 'updated', observationId };
    }

    const inserted = await tx.queryOne(`
      INSERT INTO records (
        tenant_id, external_id, platform, record_type, title, content,
        author_name, author_id, author_avatar, author_fans,
        url, canonical_url, cover_url, note_type,
        likes, comments_count, collects, shares,
        publish_time, tags,
        blogger_profile_url, image_urls, comments_text,
        blogger_liked_collected, blogger_account_type,
        video_url, audio_url, video_duration,
        comments_capture_status, comments_total_captured,
        capture_timestamp,
        keyword, payload, auth_code, content_hash
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18,
        $19, $20::jsonb,
        $21, $22::jsonb, $23,
        $24, $25,
        $26, $27, $28,
        $29, $30,
        $31,
        $32, $33::jsonb, $34, $35
      )
      RETURNING id
    `, [
      tenantId, record.external_id || '', record.platform || 'unknown', record.record_type || 'single_note',
      record.title || '', record.content || '',
      record.author_name || '', record.author_id || '', record.author_avatar || '', cleanNumber(record.author_fans),
      record.url || '', canonicalUrl, record.cover_url || '', record.note_type || '',
      cleanNumber(record.likes), cleanNumber(record.comments_count), cleanNumber(record.collects), cleanNumber(record.shares),
      record.publish_time || '', tags,
      record.blogger_profile_url || '', imageUrls, record.comments_text || '',
      cleanNumber(record.blogger_liked_collected), record.blogger_account_type || '',
      record.video_url || '', record.audio_url || '', record.video_duration || '',
      record.comments_capture_status || '', cleanNumber(record.comments_total_captured),
      record.capture_timestamp || '',
      record.keyword || '', payload, authCode, contentHash,
    ]);

    const observationId = await insertObservation(tx, { tenantId, recordId: inserted.id, authCode, monitorExecutionId, record: { ...record, payload } });
    return { id: inserted.id, action: 'inserted', observationId };
  });
}

export function serializeRecord(row) {
  if (!row) return row;
  return {
    ...row,
    tags: typeof row.tags === 'string' ? row.tags : JSON.stringify(row.tags || []),
    image_urls: typeof row.image_urls === 'string' ? row.image_urls : JSON.stringify(row.image_urls || []),
    payload: typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload || {}),
    ai_result: typeof row.ai_result === 'string' ? row.ai_result : JSON.stringify(row.ai_result || {}),
  };
}

export function serializeRecords(rows) {
  return rows.map(serializeRecord);
}
