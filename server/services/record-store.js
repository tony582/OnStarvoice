import crypto from 'crypto';
import { withTransaction } from '../db/init.js';
import { queueCoverLocalization, queueRecordImagesLocalization } from './media-store.js';
import {
  commentCountEvidenceRank,
  normalizeCommentCountSource,
  parseMetricNumber,
  resolveCommentCountEvidenceFromPayload,
} from '../utils/metrics.js';
import {resolveCapturedRecordType} from './official-account-identity.js';

const VERSION_FIELDS = [
  'title', 'content', 'author_name', 'author_id', 'author_avatar', 'url', 'cover_url',
  'tags', 'image_urls', 'comments_text', 'video_url', 'audio_url', 'source_type',
  'publish_location', 'payload',
];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;

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

const DOUYIN_CONTENT_ID_PATTERN = /^\d{8,}$/u;
const XHS_CONTENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,}$/u;
const DOUYIN_IMAGE_NOTE_TYPES = new Set([
  'image', 'images', 'image_text', 'image-text', 'image_note', 'image-note',
  'picture', 'photo', 'note', '图文', '图片',
]);
const DOUYIN_VIDEO_NOTE_TYPES = new Set(['video', '视频']);

function recordPayloadObject(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'string') return {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeDouyinContentId(value) {
  const normalized = String(value || '').trim();
  return DOUYIN_CONTENT_ID_PATTERN.test(normalized) ? normalized : '';
}

function parseDouyinDirectContentUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value).trim());
    if (!/(^|\.)douyin\.com$/iu.test(parsed.hostname)) return null;
    const matched = parsed.pathname.match(/^\/(video|note)\/(\d{8,})(?:\/|$)/iu);
    if (!matched) return null;
    return {
      kind: matched[1].toLowerCase(),
      id: matched[2],
      url: `https://www.douyin.com/${matched[1].toLowerCase()}/${matched[2]}`,
    };
  } catch {
    return null;
  }
}

function recordPayloadCandidates(payload) {
  const parsed = recordPayloadObject(payload);
  const firstItem = Array.isArray(parsed.items)
    ? parsed.items.find(item => item && typeof item === 'object' && !Array.isArray(item)) || {}
    : {};
  const detailPayload = recordPayloadObject(parsed.detailPayload);
  const itemDetailPayload = recordPayloadObject(firstItem.detailPayload);
  return {parsed, firstItem, detailPayload, itemDetailPayload};
}

function douyinDirectUrlCandidates(record = {}) {
  const {parsed, firstItem, detailPayload, itemDetailPayload} = recordPayloadCandidates(record.payload);
  return [
    record.canonical_url,
    record.url,
    parsed.detailCaptureNoteUrl,
    parsed.noteUrl,
    parsed.url,
    detailPayload.noteUrl,
    detailPayload.url,
    firstItem.detailCaptureNoteUrl,
    firstItem.noteUrl,
    firstItem.url,
    itemDetailPayload.noteUrl,
    itemDetailPayload.url,
  ].map(parseDouyinDirectContentUrl).filter(Boolean);
}

function douyinRecordContentId(record = {}, directCandidates = []) {
  const {parsed, firstItem, detailPayload, itemDetailPayload} = recordPayloadCandidates(record.payload);
  const values = [
    record.external_id,
    record.note_id,
    record.noteId,
    parsed.noteId,
    parsed.awemeId,
    detailPayload.noteId,
    detailPayload.awemeId,
    firstItem.noteId,
    firstItem.awemeId,
    itemDetailPayload.noteId,
    itemDetailPayload.awemeId,
    ...directCandidates.map(candidate => candidate.id),
  ];
  for (const value of values) {
    const normalized = normalizeDouyinContentId(value);
    if (normalized) return normalized;
  }
  for (const value of [record.url, record.canonical_url]) {
    try {
      const modalId = new URL(String(value || '')).searchParams.get('modal_id');
      const normalized = normalizeDouyinContentId(modalId);
      if (normalized) return normalized;
    } catch {
      // Not a URL; leave it untouched rather than guessing an identity.
    }
  }
  return '';
}

function douyinRecordContentKind(record = {}) {
  const {parsed, firstItem, detailPayload, itemDetailPayload} = recordPayloadCandidates(record.payload);
  const values = [
    record.note_type,
    record.noteType,
    parsed.noteType,
    parsed.note_type,
    detailPayload.noteType,
    detailPayload.note_type,
    firstItem.noteType,
    firstItem.note_type,
    itemDetailPayload.noteType,
    itemDetailPayload.note_type,
  ];
  for (const value of values) {
    const normalized = String(value || '').trim().toLowerCase();
    if (DOUYIN_IMAGE_NOTE_TYPES.has(normalized)) return 'note';
    if (DOUYIN_VIDEO_NOTE_TYPES.has(normalized)) return 'video';
  }
  return '';
}

/**
 * Douyin search-modal URLs are browser navigation state, not durable work URLs.
 * Resolve a direct /video/:id or /note/:id URL without mutating the capture
 * payload, which remains the audit trail for navigation and detail recovery.
 */
export function resolveDouyinCanonicalRecordUrl(record = {}) {
  const platform = String(record.platform || '').trim().toLowerCase();
  const hasDouyinUrl = [record.url, record.canonical_url]
    .some(value => /(^|\.)douyin\.com(?:\/|$)/iu.test(String(value || '').replace(/^https?:\/\//iu, '')));
  if (platform !== 'douyin' && !hasDouyinUrl) return '';

  const directCandidates = douyinDirectUrlCandidates(record);
  const contentId = douyinRecordContentId(record, directCandidates);
  const matchingDirect = directCandidates.find(candidate => !contentId || candidate.id === contentId);
  if (matchingDirect) return matchingDirect.url;
  if (!contentId) return '';

  const kind = douyinRecordContentKind(record);
  return kind ? `https://www.douyin.com/${kind}/${contentId}` : '';
}

function normalizeXhsContentId(value) {
  const normalized = String(value || '').trim();
  return XHS_CONTENT_ID_PATTERN.test(normalized) ? normalized : '';
}

function parseXhsDirectContentUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value).trim());
    if (!/(^|\.)xiaohongshu\.com$/iu.test(parsed.hostname)) return null;
    const matched = parsed.pathname.match(
      /^\/(?:explore|search_result|discovery\/item|note|video)\/([A-Za-z0-9_-]{8,})(?:\/|$)/iu,
    );
    if (!matched) return null;
    return {
      id: matched[1],
      url: `https://www.xiaohongshu.com/explore/${matched[1]}`,
    };
  } catch {
    return null;
  }
}

/**
 * Xiaohongshu /search_result/:id is a browser navigation route. Persist the
 * stable /explore/:id work URL so a failed detail attempt cannot leak its
 * temporary search route into the triage workspace.
 */
export function resolveXhsCanonicalRecordUrl(record = {}) {
  const platform = String(record.platform || '').trim().toLowerCase();
  const hasXhsUrl = [record.url, record.canonical_url]
    .some(value => /(^|\.)xiaohongshu\.com(?:\/|$)/iu.test(String(value || '').replace(/^https?:\/\//iu, '')));
  if (platform !== 'xiaohongshu' && !hasXhsUrl) return '';

  const {parsed, firstItem, detailPayload, itemDetailPayload} = recordPayloadCandidates(record.payload);
  const candidates = [
    record.canonical_url,
    record.url,
    parsed.detailCaptureNoteUrl,
    parsed.noteUrl,
    parsed.url,
    detailPayload.noteUrl,
    detailPayload.url,
    firstItem.detailCaptureNoteUrl,
    firstItem.noteUrl,
    firstItem.url,
    itemDetailPayload.noteUrl,
    itemDetailPayload.url,
  ].map(parseXhsDirectContentUrl).filter(Boolean);
  const externalId = normalizeXhsContentId(record.external_id);
  const matching = candidates.find(candidate => !externalId || candidate.id === externalId);
  if (matching) return matching.url;
  return externalId ? `https://www.xiaohongshu.com/explore/${externalId}` : '';
}

export function normalizeCapturedRecordLinks(record = {}) {
  const canonicalUrl = resolveDouyinCanonicalRecordUrl(record)
    || resolveXhsCanonicalRecordUrl(record);
  if (!canonicalUrl) return record;
  return {
    ...record,
    url: canonicalUrl,
    canonical_url: canonicalUrl,
  };
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
  return parseMetricNumber(value, 0);
}

function cleanOptionalNumber(value) {
  if (value == null || value === '') return null;
  return parseMetricNumber(value, 0);
}

function explicitBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function recordCommentCountEvidence(record = {}) {
  const payloadEvidence = resolveCommentCountEvidenceFromPayload(record.payload);
  const explicitKnown = explicitBoolean(record.comments_count_known);
  const explicitSource = String(record.comments_count_source || '').trim();
  return {
    known: explicitKnown ?? payloadEvidence.known,
    source: explicitSource
      ? normalizeCommentCountSource(explicitSource)
      : payloadEvidence.source,
  };
}

function isRepeatedCommentCountConcatenation(previous, incoming) {
  if (!Number.isInteger(previous) || !Number.isInteger(incoming)) return false;
  const previousText = String(previous);
  const incomingText = String(incoming);
  if (previousText.length < 2 || incomingText.length <= previousText.length) {
    return false;
  }
  if (incomingText.length % previousText.length !== 0) return false;
  return incomingText === previousText.repeat(
    incomingText.length / previousText.length,
  );
}

export function resolveGuardedCommentsCount(record = {}, existing = {}) {
  const incoming = cleanOptionalNumber(record.comments_count);
  const previous = cleanOptionalNumber(existing.comments_count);
  const incomingEvidence = recordCommentCountEvidence(record);
  const existingEvidence = recordCommentCountEvidence(existing);
  const trustedApiIncoming =
    incomingEvidence.known &&
    normalizeCommentCountSource(incomingEvidence.source) === 'api_statistics';

  if (incoming == null) {
    return {
      value: previous,
      preserved: previous != null,
      reason: 'not_observed',
      incomingEvidence,
      existingEvidence,
    };
  }

  if (
    previous != null &&
    !trustedApiIncoming &&
    isRepeatedCommentCountConcatenation(previous, incoming)
  ) {
    return {
      value: previous,
      preserved: true,
      reason: 'repeated_concatenation',
      incomingEvidence,
      existingEvidence,
    };
  }

  if (
    previous != null &&
    commentCountEvidenceRank(existingEvidence) > 0 &&
    commentCountEvidenceRank(incomingEvidence) === 0
  ) {
    return {
      value: previous,
      preserved: true,
      reason: 'untrusted_regression',
      incomingEvidence,
      existingEvidence,
    };
  }

  return {
    value: incoming,
    preserved: false,
    reason: 'accepted',
    incomingEvidence,
    existingEvidence,
  };
}

function patchPayloadCommentCount(payload, count, evidence) {
  let parsed;
  try {
    parsed = typeof payload === 'string' ? JSON.parse(payload) : structuredClone(payload);
  } catch {
    return payload;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return payload;

  const listItem = Array.isArray(parsed.items)
    ? parsed.items.find(item => item && typeof item === 'object' && !Array.isArray(item))
    : null;
  const candidates = [
    parsed.detailPayload,
    listItem?.detailPayload,
    listItem,
    parsed,
  ].filter(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate));
  const keys = ['comments', 'commentCount', 'comment_count', 'commentsCount', 'comments_count'];
  let patched = false;

  for (const candidate of candidates) {
    let touched = false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
      candidate[key] = count;
      touched = true;
    }
    if (
      String(candidate.displayMetricDimension || '').trim().toLowerCase() ===
      'comments'
    ) {
      candidate.displayMetricCount = count;
      candidate.displayMetricKnown = evidence.known;
      touched = true;
    }
    if (!touched) continue;
    candidate.commentsCountKnown = evidence.known;
    candidate.commentsCountSource = evidence.source;
    patched = true;
  }

  if (!patched) {
    parsed.comments = count;
    parsed.commentsCountKnown = evidence.known;
    parsed.commentsCountSource = evidence.source;
  }
  return JSON.stringify(parsed);
}

export function guardRecordCommentCount(record = {}, existing = {}) {
  const decision = resolveGuardedCommentsCount(record, existing);
  if (!decision.preserved || decision.reason === 'not_observed') {
    return {...record, comments_count: decision.value};
  }
  const evidence = decision.existingEvidence;
  return {
    ...record,
    comments_count: decision.value,
    comments_count_known: evidence.known,
    comments_count_source: evidence.source,
    payload: patchPayloadCommentCount(
      record.payload,
      decision.value,
      evidence,
    ),
  };
}

function normalizeCapturedTextForComparison(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s*(?:\.{3}|…+)\s*展开\s*$/u, '')
    .replace(/\s+/gu, '');
}

/**
 * 同一 external_id 再次采集时，如果新正文只是旧正文的开头一段，视为
 * 页面折叠/异步加载造成的回退。其他真实改写仍以本次平台结果为准。
 */
export function resolveCapturedTextUpdate(existingValue, incomingValue) {
  const existing = String(existingValue || '').trim();
  const incoming = String(incomingValue || '').trim();
  if (!incoming) {
    return { value: existing, preserved: Boolean(existing), reason: 'not_observed' };
  }
  if (!existing) {
    return { value: incoming, preserved: false, reason: 'accepted' };
  }

  const existingComparable = normalizeCapturedTextForComparison(existing);
  const incomingComparable = normalizeCapturedTextForComparison(incoming);
  if (
    incomingComparable &&
    incomingComparable.length < existingComparable.length &&
    existingComparable.startsWith(incomingComparable)
  ) {
    return { value: existing, preserved: true, reason: 'truncated_prefix' };
  }
  return { value: incoming, preserved: false, reason: 'accepted' };
}

function patchPayloadCapturedText(payload, { title, content }) {
  let parsed;
  try {
    parsed = typeof payload === 'string' ? JSON.parse(payload) : structuredClone(payload);
  } catch {
    return payload;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return payload;

  const listItem = Array.isArray(parsed.items)
    ? parsed.items.find(item => item && typeof item === 'object' && !Array.isArray(item))
    : null;
  const candidates = [
    parsed.detailPayload,
    listItem?.detailPayload,
    listItem,
    parsed,
  ].filter(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate));

  for (const candidate of candidates) {
    for (const key of ['title', 'noteTitle']) {
      if (title && Object.prototype.hasOwnProperty.call(candidate, key)) candidate[key] = title;
    }
    for (const key of ['content', 'noteContent', 'fullContent', 'body', 'desc']) {
      if (content && Object.prototype.hasOwnProperty.call(candidate, key)) candidate[key] = content;
    }
  }
  return JSON.stringify(parsed);
}

export function guardRecordTextCompleteness(record = {}, existing = {}) {
  const platform = String(record.platform || existing.platform || '').trim().toLowerCase();
  const completeness = resolvePayloadTextCompleteness(record.payload);
  if (
    platform !== 'douyin' ||
    completeness === 'complete'
  ) {
    return record;
  }
  const title = resolveCapturedTextUpdate(existing.title, record.title);
  const content = resolveCapturedTextUpdate(existing.content, record.content);
  if (!title.preserved && !content.preserved) return record;
  return {
    ...record,
    title: title.value,
    content: content.value,
    payload: patchPayloadCapturedText(record.payload, {
      title: title.value,
      content: content.value,
    }),
  };
}

function resolvePayloadTextCompleteness(payload) {
  let parsed;
  try {
    parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const listItem = Array.isArray(parsed.items)
    ? parsed.items.find(item => item && typeof item === 'object' && !Array.isArray(item))
    : null;
  for (const candidate of [parsed.detailPayload, listItem?.detailPayload, listItem, parsed]) {
    const value = String(candidate?.contentCompleteness || '').trim().toLowerCase();
    if (value) return value;
  }
  return '';
}

function meaningful(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value !== '' && value !== '[]' && value !== '{}';
  return true;
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function resolveRecordRelabelReason(existing = {}, incoming = {}, changedFields = []) {
  const fields = new Set(Array.isArray(changedFields) ? changedFields : []);
  const existingPayload = parseObject(existing.payload);
  const incomingPayload = parseObject(incoming.payload);
  if (
    String(existingPayload.detailCaptureStatus || '') !== 'done'
    && String(incomingPayload.detailCaptureStatus || '') === 'done'
  ) return 'detail_completed';
  if (fields.has('content') && meaningful(incoming.content)) return 'content_enriched';
  if (fields.has('comments_text') && meaningful(incoming.comments_text)) return 'comments_enriched';

  const aiResult = parseObject(existing.ai_result);
  const previousRelevance = String(aiResult.relevance || '').trim().toLowerCase();
  const previousKeyword = String(existing.keyword || '').trim().toLocaleLowerCase();
  const incomingKeyword = String(incoming.keyword || '').trim().toLocaleLowerCase();
  if (
    ['irrelevant', 'uncertain'].includes(previousRelevance)
    && incomingKeyword
    && incomingKeyword !== previousKeyword
  ) return 'new_keyword_context';
  return '';
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

async function loadCaptureObservationLineage(tx, {
  tenantId,
  captureTaskId,
  captureAgentId,
  captureAgentAuthCodeId,
  captureAgentAuthBindingId,
  captureTaskItemAttemptId,
  captureTaskItemRequestHash,
  recordId,
  monitorExecutionId,
  record,
}) {
  const normalizedTaskId = String(captureTaskId || '').trim().toLowerCase();
  const normalizedAgentId = String(captureAgentId || '').trim().toLowerCase();
  const normalizedAuthCodeId = String(captureAgentAuthCodeId || '').trim().toLowerCase();
  const normalizedAuthBindingId = String(captureAgentAuthBindingId || '').trim().toLowerCase();
  const normalizedItemAttemptId = String(
    captureTaskItemAttemptId || '',
  ).trim().toLowerCase();
  const normalizedItemRequestHash = String(
    captureTaskItemRequestHash || '',
  ).trim().toLowerCase();
  if (
    !UUID_PATTERN.test(normalizedTaskId) ||
    !UUID_PATTERN.test(normalizedAgentId) ||
    !UUID_PATTERN.test(normalizedAuthCodeId) ||
    !UUID_PATTERN.test(normalizedAuthBindingId)
  ) {
    return null;
  }
  return tx.queryOne(`
    WITH exact_task AS (
      SELECT task.*
      FROM capture_tasks task
      JOIN capture_agents agent
        ON agent.id = $7::uuid
        AND agent.tenant_id = task.tenant_id
        AND agent.status = 'active'
        AND agent.auth_code_id = $8::uuid
        AND agent.auth_binding_id = $9::uuid
      JOIN tenants tenant
        ON tenant.id = task.tenant_id AND tenant.status = 'active'
      JOIN auth_codes auth_code
        ON auth_code.id = agent.auth_code_id
        AND auth_code.tenant_id = task.tenant_id
        AND auth_code.status = 'active'
        AND (auth_code.expires_at IS NULL OR auth_code.expires_at >= now())
      JOIN auth_bindings binding
        ON binding.id = agent.auth_binding_id
        AND binding.code_id = auth_code.id
      WHERE task.id = $1::uuid
        AND task.tenant_id = $2
        AND COALESCE(task.assigned_agent_id, task.origin_agent_id) = agent.id
    ), matched_items AS (
      SELECT candidate.id
      FROM capture_task_items candidate
      JOIN exact_task task ON true
      WHERE candidate.tenant_id = task.tenant_id
        AND candidate.task_id = COALESCE(task.parent_task_id, task.id)
        AND candidate.execution_task_id = task.id
        AND candidate.assigned_agent_id = $7::uuid
        AND (
          (BTRIM(candidate.keyword) <> '' AND candidate.keyword = $4)
          OR candidate.record_id = $3::uuid
          OR (BTRIM(candidate.external_id) <> '' AND candidate.external_id = $5)
          OR (
            $6::uuid IS NOT NULL
            AND candidate.metadata->>'monitorExecutionId' = $6::uuid::text
          )
        )
    ), exact_item AS (
      SELECT (array_agg(id ORDER BY id))[1] AS id
      FROM matched_items
      HAVING COUNT(*) = 1
    ), exact_attempt AS (
      SELECT (array_agg(attempt.id ORDER BY attempt.id))[1] AS id
      FROM capture_task_item_attempts attempt
      JOIN exact_task task ON true
      JOIN exact_item item ON true
      JOIN capture_task_items current_item
        ON current_item.id = item.id
        AND current_item.tenant_id = task.tenant_id
      WHERE attempt.tenant_id = task.tenant_id
        AND attempt.item_id = item.id
        AND attempt.parent_task_id = current_item.task_id
        AND attempt.execution_task_id = task.id
        AND attempt.agent_id = $7::uuid
        AND attempt.assignment_revision = current_item.assignment_revision
        AND attempt.attempt_number = current_item.attempt_count
        AND (
          task.metadata->>'dutyRecovery' IS DISTINCT FROM 'true'
          OR (
            attempt.id = $10::uuid
            AND attempt.request_hash = $11
            AND current_item.request_hash = $11
            AND task.metadata->>'remoteRequestHash' = $11
          )
        )
      HAVING COUNT(*) = 1
    )
    SELECT task.id AS capture_task_id,
      item.id AS capture_task_item_id,
      attempt.id AS capture_task_item_attempt_id
    FROM exact_task task
    JOIN exact_item item ON true
    JOIN exact_attempt attempt ON true
    WHERE task.metadata->>'dutyRecovery' IS DISTINCT FROM 'true'
      OR EXISTS (
        SELECT 1
        FROM capture_recovery_intents intent
        WHERE intent.tenant_id = task.tenant_id
          AND intent.recovery_task_id = task.id
          AND intent.item_id = item.id
          AND intent.dispatched_attempt_id = attempt.id
          AND intent.recovery_agent_id = $7::uuid
          AND intent.status = 'verifying_collection'
          AND intent.resolved_at IS NULL
          AND task.metadata->>'dutyRecoveryIntentId' = intent.id::text
          AND task.metadata->>'dutyRecoveryGeneration' = intent.generation::text
          AND task.metadata->>'dutyRecoverySourceItemId' = item.id::text
      )
  `, [
    normalizedTaskId,
    tenantId,
    recordId,
    record.keyword || '',
    record.external_id || '',
    UUID_PATTERN.test(String(monitorExecutionId || '').trim())
      ? monitorExecutionId
      : null,
    normalizedAgentId,
    normalizedAuthCodeId,
    normalizedAuthBindingId,
    UUID_PATTERN.test(normalizedItemAttemptId)
      ? normalizedItemAttemptId
      : null,
    SHA256_PATTERN.test(normalizedItemRequestHash)
      ? normalizedItemRequestHash
      : '',
  ]);
}

async function insertObservation(tx, {
  tenantId,
  recordId,
  authCode,
  monitorExecutionId,
  captureTaskId,
  captureAgentId,
  captureAgentAuthCodeId,
  captureAgentAuthBindingId,
  captureTaskItemAttemptId,
  captureTaskItemRequestHash,
  commentWorkflowExpectedCount = 0,
  record,
}) {
  const lineage = await loadCaptureObservationLineage(tx, {
    tenantId,
    captureTaskId,
    captureAgentId,
    captureAgentAuthCodeId,
    captureAgentAuthBindingId,
    captureTaskItemAttemptId,
    captureTaskItemRequestHash,
    recordId,
    monitorExecutionId,
    record,
  });
  const result = await tx.queryOne(`
    INSERT INTO record_observations (
      tenant_id, record_id, monitor_execution_id, source_auth_code,
      capture_task_id, capture_task_item_id, capture_task_item_attempt_id,
      comment_workflow_status, comment_workflow_expected_count,
      platform, keyword, rank_position,
      likes, comments_count, collects, shares,
      captured_at, payload
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7,
      CASE WHEN $8::integer > 0 THEN 'queued' ELSE 'not_required' END,
      $8::integer,
      $9, $10, $11,
      $12, $13, $14, $15,
      now(), $16::jsonb
    )
    RETURNING id
  `, [
    tenantId, recordId, monitorExecutionId || null, authCode || '',
    lineage?.capture_task_id || null,
    lineage?.capture_task_item_id || null,
    lineage?.capture_task_item_attempt_id || null,
    Math.max(0, Number(commentWorkflowExpectedCount) || 0),
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

async function loadOfficialAccountCandidates(tx, tenantId, monitorExecutionId) {
  return await tx.queryAll(`
    SELECT account.*,
      EXISTS (
        SELECT 1
        FROM monitor_executions execution
        JOIN monitor_subscriptions subscription
          ON subscription.id = execution.subscription_id
          AND subscription.tenant_id = execution.tenant_id
          AND subscription.subject_type = 'official'
        WHERE $2::uuid IS NOT NULL
          AND execution.id = $2::uuid
          AND execution.tenant_id = account.tenant_id
          AND subscription.official_account_id = account.id
      ) AS execution_bound
    FROM official_accounts account
    WHERE account.tenant_id = $1
      AND account.status = 'active'
  `, [tenantId, monitorExecutionId || null]);
}

async function appendOfficialContentAudit(tx, {
  tenantId,
  recordId,
  previousRecordType,
  nextRecordType,
  source,
  officialAccountId,
}) {
  if (previousRecordType === nextRecordType) return;
  const action = nextRecordType === 'official_content'
    ? 'record.official_content_identified'
    : 'record.official_content_exclusion_removed';
  await tx.execute(`
    INSERT INTO audit_logs (
      tenant_id, actor_type, actor_id, action, target_type, target_id, metadata
    ) VALUES ($1, 'system', 'official-content-classifier', $2, 'record', $3, $4::jsonb)
  `, [
    tenantId,
    action,
    recordId,
    JSON.stringify({
      previousRecordType,
      nextRecordType,
      source,
      officialAccountId: officialAccountId || null,
      processingModeChanged: false,
    }),
  ]);
}

export function mergeObservationMetrics(record = {}, existing = {}) {
  const merged = {...record};
  for (const field of ['likes', 'comments_count', 'collects', 'shares']) {
    const incoming = cleanOptionalNumber(record[field]);
    merged[field] = incoming ?? cleanNumber(existing[field]);
  }
  return merged;
}

export async function upsertCapturedRecord(record, context) {
  record = normalizeCapturedRecordLinks(record);
  const tenantId = context.tenantId;
  const authCode = context.authCode || '';
  const monitorExecutionId = context.monitorExecutionId || null;
  const captureTaskId = context.captureTaskId || null;
  const captureAgentId = context.captureAgentId || null;
  const captureAgentAuthCodeId = context.captureAgentAuthCodeId || null;
  const captureAgentAuthBindingId = context.captureAgentAuthBindingId || null;
  const captureTaskItemAttemptId = context.captureTaskItemAttemptId || null;
  const captureTaskItemRequestHash = context.captureTaskItemRequestHash || null;
  const commentWorkflowExpectedCount = Math.max(
    0,
    Number(context.commentWorkflowExpectedCount) || 0,
  );
  const canonicalUrl = normalizeUrl(record.canonical_url || record.url);
  const contentHash = buildContentHash(record, canonicalUrl);
  const tags = jsonText(record.tags, '[]');
  const imageUrls = jsonText(record.image_urls, '[]');
  let payload = jsonText(record.payload, '{}');

  const __result = await withTransaction(async tx => {
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

    const incomingRecordType = record.record_type || existing?.record_type || 'single_note';
    const officialAccounts = incomingRecordType === 'blogger_profile'
      ? []
      : await loadOfficialAccountCandidates(tx, tenantId, monitorExecutionId);
    const officialResolution = resolveCapturedRecordType({
      record,
      existing: existing || {},
      officialAccounts,
    });
    record = {...record, record_type: officialResolution.recordType};

    record = guardRecordCommentCount(record, existing || {});
    record = guardRecordTextCompleteness(record, existing || {});
    payload = jsonText(record.payload, '{}');

    if (existing) {
      const changedFields = detectChangedFields(existing, { ...record, tags, image_urls: imageUrls, payload });
      const relabelReason = resolveRecordRelabelReason(
        existing,
        { ...record, tags, image_urls: imageUrls, payload },
        changedFields,
      );

      await tx.execute(`
        UPDATE records SET
          record_type = COALESCE(NULLIF($1, ''), record_type),
          title = COALESCE(NULLIF($2, ''), title),
          content = COALESCE(NULLIF($3, ''), content),
          author_name = COALESCE(NULLIF($4, ''), author_name),
          author_id = COALESCE(NULLIF($5, ''), author_id),
          author_avatar = COALESCE(NULLIF($6, ''), author_avatar),
          author_fans = COALESCE(NULLIF($7, 0), author_fans),
          url = COALESCE(NULLIF($8, ''), url),
          canonical_url = COALESCE(NULLIF($9, ''), canonical_url),
          cover_url = COALESCE(NULLIF($10, ''), cover_url),
          note_type = COALESCE(NULLIF($11, ''), note_type),
          likes = COALESCE($12::integer, likes),
          comments_count = COALESCE($13::integer, comments_count),
          collects = COALESCE($14::integer, collects),
          shares = COALESCE($15::integer, shares),
          publish_time = CASE
            WHEN COALESCE(manual_overrides, '{}'::jsonb) ? 'publish_time' THEN publish_time
            ELSE COALESCE(NULLIF($16, ''), publish_time)
          END,
          tags = CASE WHEN $17::jsonb <> '[]'::jsonb THEN $17::jsonb ELSE tags END,
          blogger_profile_url = COALESCE(NULLIF($18, ''), blogger_profile_url),
          image_urls = CASE WHEN $19::jsonb <> '[]'::jsonb THEN $19::jsonb ELSE image_urls END,
          comments_text = COALESCE(NULLIF($20, ''), comments_text),
          comments_capture_status = COALESCE(NULLIF($21, ''), comments_capture_status),
          comments_total_captured = COALESCE(NULLIF($22, 0), comments_total_captured),
          blogger_liked_collected = COALESCE(NULLIF($23, 0), blogger_liked_collected),
          blogger_account_type = COALESCE(NULLIF($24, ''), blogger_account_type),
          video_url = COALESCE(NULLIF($25, ''), video_url),
          audio_url = COALESCE(NULLIF($26, ''), audio_url),
          video_duration = COALESCE(NULLIF($27, ''), video_duration),
          capture_timestamp = COALESCE(NULLIF($28, ''), capture_timestamp),
          keyword = COALESCE(NULLIF($29, ''), keyword),
          source_type = COALESCE(NULLIF($30, ''), source_type),
          payload = CASE
            WHEN ($31::jsonb->>'detailCaptureStatus') = 'done' THEN $31::jsonb
            WHEN (payload->>'detailCaptureStatus') = 'done' THEN payload
            ELSE $31::jsonb
          END,
          auth_code = COALESCE(NULLIF($32, ''), auth_code),
          author_account_no = COALESCE(NULLIF($34, ''), author_account_no),
          publish_location = COALESCE(NULLIF($35, ''), publish_location),
          last_seen_at = now(),
          seen_count = seen_count + 1,
          updated_at = now()
        WHERE id = $33
      `, [
        record.record_type, record.title, record.content,
        record.author_name, record.author_id, record.author_avatar,
        cleanNumber(record.author_fans),
        record.url, canonicalUrl, record.cover_url, record.note_type,
        cleanOptionalNumber(record.likes), cleanOptionalNumber(record.comments_count), cleanOptionalNumber(record.collects), cleanOptionalNumber(record.shares),
        record.publish_time, tags,
        record.blogger_profile_url, imageUrls,
        record.comments_text, record.comments_capture_status, cleanNumber(record.comments_total_captured),
        cleanNumber(record.blogger_liked_collected),
        record.blogger_account_type,
        record.video_url, record.audio_url, record.video_duration,
        record.capture_timestamp,
        record.keyword,
        record.source_type || '',
        payload,
        authCode,
        existing.id,
        record.author_account_no || '', // $34:人看的号(空不覆盖,见 COALESCE NULLIF)
        record.publish_location || '',
      ]);

      await appendOfficialContentAudit(tx, {
        tenantId,
        recordId: existing.id,
        previousRecordType: existing.record_type || '',
        nextRecordType: officialResolution.recordType,
        source: officialResolution.source,
        officialAccountId: officialResolution.officialAccount?.id,
      });

      const observationId = await insertObservation(tx, {
        tenantId,
        recordId: existing.id,
        authCode,
        monitorExecutionId,
        captureTaskId,
        captureAgentId,
        captureAgentAuthCodeId,
        captureAgentAuthBindingId,
        captureTaskItemAttemptId,
        captureTaskItemRequestHash,
        commentWorkflowExpectedCount,
        record: mergeObservationMetrics({...record, payload}, existing),
      });

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

      return {
        id: existing.id,
        action: 'updated',
        observationId,
        shouldRelabel: Boolean(relabelReason),
        relabelReason,
        changedFields,
        officialContent: officialResolution.officialContent,
        officialContentSource: officialResolution.source,
      };
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
        keyword, source_type, payload, auth_code, content_hash, author_account_no,
        publish_location
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
        $32, $33, $34::jsonb, $35, $36, $37,
        $38
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
      record.keyword || '', record.source_type || '', payload, authCode, contentHash,
      record.author_account_no || '', // $37:人看的号
      record.publish_location || '',
    ]);

    const observationId = await insertObservation(tx, {
      tenantId,
      recordId: inserted.id,
      authCode,
      monitorExecutionId,
      captureTaskId,
      captureAgentId,
      captureAgentAuthCodeId,
      captureAgentAuthBindingId,
      captureTaskItemAttemptId,
      captureTaskItemRequestHash,
      commentWorkflowExpectedCount,
      record: {...record, payload},
    });
    await appendOfficialContentAudit(tx, {
      tenantId,
      recordId: inserted.id,
      previousRecordType: officialResolution.incomingRecordType,
      nextRecordType: officialResolution.recordType,
      source: officialResolution.source,
      officialAccountId: officialResolution.officialAccount?.id,
    });
    return {
      id: inserted.id,
      action: 'inserted',
      observationId,
      officialContent: officialResolution.officialContent,
      officialContentSource: officialResolution.source,
    };
  });
  // 封面落地:入库后非阻塞把平台封面下载到本地(失败不影响入库,过期靠回填重试)
  if (record.cover_url) queueCoverLocalization(__result.id, record.cover_url, record.platform);
  if (imageUrls !== '[]') queueRecordImagesLocalization(__result.id, imageUrls, record.platform);
  return __result;
}

export function serializeRecord(row) {
  if (!row) return row;
  return {
    ...row,
    tags: typeof row.tags === 'string' ? row.tags : JSON.stringify(row.tags || []),
    image_urls: typeof row.image_urls === 'string' ? row.image_urls : JSON.stringify(row.image_urls || []),
    image_local_urls: typeof row.image_local_urls === 'string' ? row.image_local_urls : JSON.stringify(row.image_local_urls || []),
    payload: typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload || {}),
    ai_result: typeof row.ai_result === 'string' ? row.ai_result : JSON.stringify(row.ai_result || {}),
  };
}

export function serializeRecords(rows) {
  return rows.map(serializeRecord);
}
