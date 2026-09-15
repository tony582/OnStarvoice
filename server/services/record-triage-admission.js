import {
  GM_POST_ENTITY_SQL_PATTERNS, GM_CONTEXTUAL_MODEL_PATTERN, GM_VEHICLE_CONTEXT_PATTERN,
  NON_SAIC_GM_ORG_PATTERN, GENERIC_ENTITY_PATTERN,
  POST_HASHTAG_PATTERN, SENTRY_SCOPE_KEYWORDS, MONITORING_EVIDENCE_VERSION,
  findRecordMonitoringEvidence, isSentryEvidenceScope, normalizeMonitoringEvidence, normalizePostIntent, POST_INTENTS,
} from './record-content-judgment.js';
import { recordRelevanceExportFields } from './record-relevance-filter.js';

export const POST_INTENT_LABELS = { share: '分享', advertising: '广告/软文', other: '其他', complaint: '投诉/抱怨', inquiry: '咨询' };

function aliasName(alias) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('Invalid record SQL alias');
  return alias;
}
function trimSql(value) { return `regexp_replace(${value}, '^\\s+|\\s+$', '', 'g')`; }
// JavaScript string limits count UTF-16 code units, including two for emoji.
function evidenceLengthSql(value) { return `(length(${value})+length(regexp_replace(${value},'[^\\U00010000-\\U0010FFFF]','','g')))`; }
function literal(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

export function manualRecordRelevance(record) {
  const raw = object(record.manual_overrides).relevance;
  const value = typeof raw === 'object' && raw ? raw.value : raw;
  return ['relevant', 'irrelevant', 'uncertain'].includes(value) ? value : '';
}

export function recordTriageAdmission(record = {}) {
  const scoped = isSentryEvidenceScope(record);
  const manual = manualRecordRelevance(record);
  const ai = object(record.ai_result);
  const relevance = manual || ai.relevance || 'uncertain';
  // Stored evidence is explanatory metadata, not an independent rejection.
  // Re-evaluate current source text so older narrow matching cannot hide a post.
  const verified = findRecordMonitoringEvidence(ai, record).length > 0;
  const admitted = !scoped || manual === 'relevant' || (!manual && relevance === 'relevant' && verified);
  return {
    admitted, scoped, relevance,
    monitoring_evidence_status: !scoped ? 'not_applicable' : manual === 'relevant' ? 'manual_confirmed' : admitted ? 'confirmed' : 'needs_review',
  };
}

export function manualRecordRelevanceSql(alias = 'r') {
  const a = aliasName(alias);
  const value = `CASE WHEN jsonb_typeof(${a}.manual_overrides->'relevance') = 'object' THEN ${a}.manual_overrides->'relevance'->>'value' ELSE ${a}.manual_overrides->>'relevance' END`;
  return `(CASE WHEN (${value}) IN ('relevant','irrelevant','uncertain') THEN (${value}) ELSE NULL END)`;
}

export function recordEffectiveRelevanceSql(alias = 'r') {
  return `COALESCE(${manualRecordRelevanceSql(alias)}, ${aliasName(alias)}.ai_result->>'relevance', 'uncertain')`;
}

export function recordSentryScopeSql(alias = 'r') {
  const a = aliasName(alias);
  const pattern = literal(SENTRY_SCOPE_KEYWORDS.join('|'));
  const matches = text => `regexp_replace(normalize(COALESCE(${text}, ''), NFKC), '\\s+', '', 'g') ~ ${pattern}`;
  return `(${matches(`${a}.keyword`)} OR EXISTS (SELECT 1 FROM record_observations admission_observation WHERE admission_observation.tenant_id = ${a}.tenant_id AND admission_observation.record_id = ${a}.id AND ${matches('admission_observation.keyword')}))`;
}

// Keep the candidate order identical to currentPostMediaUrl. JSON media entries
// can be a URL string or an object with url/src/downloadUrl.
function currentMediaUrlSql(a) {
  const candidates = [`to_jsonb(${a}.video_url)`, `${a}.payload->'videoUrl'`, `${a}.payload->'video_url'`, `${a}.payload->'awemeVideoUrl'`, `${a}.payload->'videoUrls'->0`, `to_jsonb(${a}.audio_url)`, `${a}.payload->'audioUrl'`, `${a}.payload->'musicUrl'`, `${a}.payload->'audioUrls'->0`];
  return `(SELECT media.url FROM (SELECT ordinal, ${trimSql("CASE WHEN jsonb_typeof(value) = 'object' THEN COALESCE(NULLIF(value->>'url',''),NULLIF(value->>'src',''),value->>'downloadUrl','') ELSE value #>> '{}' END")} AS url FROM (VALUES ${candidates.map((value, i) => `(${i},${value})`).join(',')}) AS candidate(ordinal,value)) media WHERE media.url ~* '^https?://' ORDER BY ordinal LIMIT 1)`;
}

function maskedNormalizedSql(value) {
  return `regexp_replace(normalize(${value}, NFKC),${literal(NON_SAIC_GM_ORG_PATTERN)},' ','gi')`;
}

// The entity is literal model output, never a SQL regular expression. Inspect
// each occurrence so a preceding cropped occurrence does not hide a valid one.
function wholeEntitySql(text, entity) {
  // Advance from each literal match, not from every source character. Advancing
  // by one preserves overlapping occurrences, matching JavaScript indexOf.
  return `EXISTS (WITH RECURSIVE entity_position(n) AS (
      SELECT position(${entity} IN ${text}) WHERE length(${entity}) > 0 AND position(${entity} IN ${text}) > 0
      UNION ALL
      SELECT n + following.offset FROM entity_position
      CROSS JOIN LATERAL (SELECT position(${entity} IN substring(${text} FROM n+1)) AS offset) following
      WHERE following.offset > 0
    ) SELECT 1 FROM entity_position
    WHERE (normalize(${entity},NFKC) !~* '^[a-z0-9]' OR normalize(substring(${text} FROM n-1 FOR 1),NFKC) !~* '[a-z0-9]')
      AND (normalize(${entity},NFKC) !~* '[a-z0-9]$' OR normalize(substring(${text} FROM n+length(${entity}) FOR 1),NFKC) !~* '[a-z0-9]'))`;
}

export function recordMainPostEvidenceSql(alias = 'r') {
  const a = aliasName(alias);
  const transcript = `CASE WHEN ${a}.transcript_status = 'done' AND NULLIF(${trimSql(`${a}.transcript_source_url`)},'') = ${currentMediaUrlSql(a)} THEN ${a}.transcript ELSE '' END`;
  return `EXISTS (
    WITH post_evidence_sources AS (
      SELECT source,clean.text,${maskedNormalizedSql('clean.text')} AS normalized_text
      FROM (VALUES ('title',${a}.title),('content',${a}.content),('transcript',${transcript})) AS evidence_source(source,raw_text)
      CROSS JOIN LATERAL (SELECT ${trimSql(`regexp_replace(COALESCE(raw_text,''),${literal(POST_HASHTAG_PATTERN)},' ','g')`)} AS text) clean
    )
    SELECT 1 FROM post_evidence_sources clean
    WHERE (${GM_POST_ENTITY_SQL_PATTERNS.map(pattern => `clean.normalized_text ~* ${literal(pattern)}`).join(' OR ')})
      OR (clean.normalized_text ~* ${literal(GM_CONTEXTUAL_MODEL_PATTERN)}
        AND EXISTS (SELECT 1 FROM post_evidence_sources vehicle_context WHERE vehicle_context.normalized_text ~* ${literal(GM_VEHICLE_CONTEXT_PATTERN)}))
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${a}.ai_result->'monitoringEvidence'->'evidence') = 'array' THEN ${a}.ai_result->'monitoringEvidence'->'evidence' ELSE '[]'::jsonb END) WITH ORDINALITY AS candidate(item,ordinal)
        CROSS JOIN LATERAL (SELECT ${trimSql("item->>'quote'")} AS quote, ${trimSql("item->>'entity'")} AS entity) cited
        WHERE ordinal <= 12 AND ${a}.ai_result->>'relevance' = 'relevant'
          AND jsonb_typeof(item->'source') = 'string' AND item->>'source' = clean.source
          AND item->>'entityType' IN ('brand','model') AND item->>'manufacturer' = 'saic_gm'
          AND jsonb_typeof(item->'quote') = 'string' AND jsonb_typeof(item->'entity') = 'string'
          AND ${evidenceLengthSql('cited.quote')} BETWEEN 2 AND 500 AND ${evidenceLengthSql('cited.entity')} BETWEEN 2 AND 80
          AND normalize(cited.entity,NFKC) !~* ${literal(GENERIC_ENTITY_PATTERN)}
          AND normalize(cited.entity,NFKC) !~* ${literal(NON_SAIC_GM_ORG_PATTERN)}
          AND position(cited.quote IN clean.text) > 0
          AND ${wholeEntitySql('cited.quote', 'cited.entity')}
          AND ${wholeEntitySql(maskedNormalizedSql('cited.quote'), 'normalize(cited.entity,NFKC)')}
          AND ${wholeEntitySql('clean.normalized_text', 'normalize(cited.entity,NFKC)')}
      )
  )`;
}

export function recordTriageAdmissionSql(alias = 'r') {
  const a = aliasName(alias);
  return `(NOT ${recordSentryScopeSql(a)} OR CASE WHEN ${manualRecordRelevanceSql(a)} IS NOT NULL THEN ${manualRecordRelevanceSql(a)} = 'relevant' ELSE COALESCE(${a}.ai_result->>'relevance' = 'relevant',false) AND ${recordMainPostEvidenceSql(a)} END)`;
}

export function recordAdmissionSelectSql(alias = 'r', { admitted = null } = {}) {
  // Lists/exports have already evaluated admission before pagination. Reuse that
  // known result instead of re-reading long post evidence for every projection.
  const allowed = typeof admitted === 'boolean' ? String(admitted) : recordTriageAdmissionSql(alias);
  return `${recordSentryScopeSql(alias)} AS admission_scoped, ${allowed} AS admission_allowed`;
}

export function withRecordAdmissionFields(record = {}) {
  const { admission_scoped, admission_allowed, ...publicRecord } = record;
  const manual = manualRecordRelevance(record);
  const computed = admission_scoped === undefined ? recordTriageAdmission(record) : {
    scoped: admission_scoped,
    admitted: admission_allowed,
    monitoring_evidence_status: !admission_scoped ? 'not_applicable' : manual === 'relevant' ? 'manual_confirmed' : admission_allowed ? 'confirmed' : 'needs_review',
  };
  if (computed.scoped && computed.admitted) {
    const ai = object(record.ai_result);
    const metadata = normalizeMonitoringEvidence({ ...ai, relevance: manual || ai.relevance }, record);
    // The paged list omits transcript text. A source already admitted by SQL
    // may rely on current media; describe that without reusing an unchecked quote.
    publicRecord.ai_result = { ...ai, monitoringEvidence: metadata.evidence.length ? metadata : {
      version: MONITORING_EVIDENCE_VERSION,
      status: 'confirmed',
      evidence: [],
      reason: manual === 'relevant' ? '沿用已有人工相关性判断'
        : '结合主帖标题、正文与当前媒体，存在品牌或车型线索且整体判断相关',
    } };
  }
  return { ...publicRecord, intent_display: normalizePostIntent(record.intent) || null,
    monitoring_evidence_status: computed.monitoring_evidence_status };
}

export function recordJudgmentExportFields(record = {}) {
  const value = withRecordAdmissionFields(record);
  return {
    intent: POST_INTENT_LABELS[value.intent_display] || '待判断',
    ...recordRelevanceExportFields(record),
  };
}

export function recordIntentSql(alias = 'r') {
  const value = `lower(${trimSql(`COALESCE(${aliasName(alias)}.intent,'')`)})`;
  return `(CASE WHEN ${value} = 'suggestion' THEN 'other' WHEN ${value} IN (${POST_INTENTS.map(literal).join(',')}) THEN ${value} ELSE NULL END)`;
}

export function appendRecordIntentFilter(where, params, value, alias = 'r') {
  const values = (Array.isArray(value) ? value : [value]).flatMap(entry => String(entry || '').split(',')).map(entry => entry.trim()).filter(Boolean);
  if (!values.length) return where;
  if (values.length === 1 && values[0] === 'none') return `${where} AND false`;
  const intents = [...new Set(values.map(normalizePostIntent))];
  if (intents.includes('')) {
    const error = new Error('意图筛选仅支持分享、广告/软文、其他、投诉抱怨、咨询');
    error.status = 400; error.code = 'invalid_intent'; throw error;
  }
  params.push(intents);
  return `${where} AND ${recordIntentSql(alias)} = ANY($${params.length}::text[])`;
}
