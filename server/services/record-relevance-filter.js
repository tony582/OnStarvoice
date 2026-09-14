import { normalizeJudgmentConfidence } from './record-content-judgment.js';

const RELEVANCE_VALUES = ['relevant', 'uncertain', 'irrelevant'];
const RELEVANCE_FILTER_VALUES = [...RELEVANCE_VALUES, 'unjudged'];
const CONFIDENCE_FILTER_VALUES = ['high', 'medium', 'low', 'missing', 'manual'];
const RELEVANCE_LABELS = { relevant: '相关', uncertain: '信息不足', irrelevant: '无关', unjudged: '未判断' };

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}
function aliasName(alias) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('Invalid record SQL alias');
  return alias;
}
function literal(value) { return `'${String(value).replaceAll("'", "''")}'`; }

export function recordRelevanceJudgment(record = {}) {
  const ai = object(record.ai_result);
  const override = object(record.manual_overrides).relevance;
  const manual = override && typeof override === 'object' ? override.value : override;
  const isManual = RELEVANCE_VALUES.includes(manual);
  const relevance = isManual ? manual : RELEVANCE_VALUES.includes(ai.relevance) ? ai.relevance : 'unjudged';
  const confidence = !isManual && relevance !== 'unjudged' ? normalizeJudgmentConfidence(ai.relevanceConfidence) : null;
  const percent = confidence === null ? null : Math.round(confidence * 100);
  return {
    relevance,
    source: isManual ? 'manual' : relevance === 'unjudged' ? 'unjudged' : 'ai',
    confidence,
    percent,
    confidenceBand: isManual ? 'manual' : percent === null ? 'missing' : percent >= 80 ? 'high' : percent >= 60 ? 'medium' : 'low',
    reason: isManual ? (typeof override?.reason === 'string' && override.reason.trim() ? override.reason : '人工判断，未填写依据') : (typeof ai.relevanceReason === 'string' ? ai.relevanceReason : ''),
  };
}

export function recordRelevanceExportFields(record = {}) {
  const judgment = recordRelevanceJudgment(record);
  return {
    relevance: RELEVANCE_LABELS[judgment.relevance],
    relevance_confidence: judgment.percent === null ? '' : `${judgment.percent}%`,
    relevance_source: { ai: 'AI', manual: '人工', unjudged: '未判断' }[judgment.source],
    relevance_reason: judgment.reason,
  };
}

function manualRelevanceSql(alias) {
  const a = aliasName(alias);
  const value = `CASE WHEN jsonb_typeof(${a}.manual_overrides->'relevance') = 'object' THEN ${a}.manual_overrides->'relevance'->>'value' ELSE ${a}.manual_overrides->>'relevance' END`;
  return `(CASE WHEN (${value}) IN ('relevant','uncertain','irrelevant') THEN (${value}) END)`;
}

// Display/filter semantics deliberately do not use admission's uncertain default.
export function recordRelevanceSql(alias = 'r') {
  const a = aliasName(alias);
  return `COALESCE(${manualRelevanceSql(a)}, CASE WHEN ${a}.ai_result->>'relevance' IN ('relevant','uncertain','irrelevant') THEN ${a}.ai_result->>'relevance' END, 'unjudged')`;
}

// Exact half of the smallest IEEE-754 double, expressed as a significand.
// This only matters for negative strings that Number() rounds to valid -0.
const HALF_MIN_DOUBLE_SIGNIFICAND = `0.${5n ** 1075n}`;
const JS_TRIM_CHARS = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

export function recordRelevanceConfidenceBandSql(alias = 'r') {
  const a = aliasName(alias);
  // PostgreSQL 14 has no try_cast. Parse only decimal syntax, bound the exponent
  // before integer casts, and cast a bounded significand only in float8's safe
  // range. The sticky trailing digit preserves rounding for very long strings.
  // Subnormal positive values always display 0%; overflow is always missing.
  return `(CASE WHEN ${manualRelevanceSql(a)} IS NOT NULL THEN 'manual'
    WHEN COALESCE(${a}.ai_result->>'relevance','') NOT IN ('relevant','uncertain','irrelevant') THEN 'missing'
    ELSE COALESCE((WITH input AS (
      SELECT btrim(${a}.ai_result->>'relevanceConfidence', ${literal(JS_TRIM_CHARS)}) AS text
      WHERE jsonb_typeof(${a}.ai_result->'relevanceConfidence') IN ('number','string')
    ), decimal_parts AS (
      SELECT text, regexp_replace(split_part(lower(text),'e',1),'^[+-]','','g') AS mantissa,
        split_part(lower(text),'e',2) AS exponent
      FROM input WHERE text ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'
    ), digits AS (
      SELECT text, mantissa, ltrim(replace(mantissa,'.',''),'0') AS significant,
        ltrim(regexp_replace(exponent,'^[+-]',''),'0') AS exponent_digits,
        CASE WHEN left(exponent,1) = '-' THEN -1 ELSE 1 END AS exponent_sign
      FROM decimal_parts
    ), normalized AS (
      SELECT text, significant,
        (CASE WHEN length(exponent_digits)>9 THEN 2000000000::bigint ELSE COALESCE(NULLIF(exponent_digits,''),'0')::bigint END)*exponent_sign
          + length(split_part(mantissa,'.',1)) - (length(replace(mantissa,'.',''))-length(significant)) - 1 AS power,
        left(significant,1100) || CASE WHEN substring(significant FROM 1101) ~ '[1-9]' THEN '1' ELSE '' END AS bounded_digits
      FROM digits
    ), confidence AS (
      SELECT CASE
        WHEN significant = '' OR power < -324 THEN 0::double precision
        WHEN power > 0 THEN NULL
        WHEN power = -324 THEN CASE WHEN left(text,1) <> '-' OR ('0.'||bounded_digits)::numeric <= ${literal(HALF_MIN_DOUBLE_SIGNIFICAND)}::numeric THEN 0::double precision END
        ELSE ((CASE WHEN left(text,1) = '-' THEN '-' ELSE '' END) || left(bounded_digits,1) || '.' || substring(bounded_digits FROM 2) || 'e' || power::text)::double precision
      END AS value FROM normalized
      UNION ALL
      SELECT CASE WHEN text ~ '^0[xXbBoO]0+$' THEN 0::double precision ELSE 1::double precision END
      FROM input WHERE text ~ '^0[xXbBoO]0*[01]$'
    ) SELECT CASE WHEN value BETWEEN 0 AND 1 THEN CASE WHEN value*100 >= 79.5 THEN 'high' WHEN value*100 >= 59.5 THEN 'medium' ELSE 'low' END END FROM confidence), 'missing') END)`;
}

function selectedValues(value, allowed, name) {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  const values = entries.flatMap(entry => typeof entry === 'string' ? entry.split(',').map(part => part.trim()) : [null]);
  if (!values.length || values.some(entry => !allowed.includes(entry))) {
    const error = new Error(`${name} 筛选值无效`);
    error.status = 400;
    error.code = name === 'relevance' ? 'invalid_relevance' : 'invalid_relevance_confidence';
    throw error;
  }
  return [...new Set(values)];
}

export function appendRecordRelevanceFilters(where, params, query = {}, alias = 'r') {
  // Validate both before mutating params, even when the other dimension is empty.
  const relevance = selectedValues(query.relevance, RELEVANCE_FILTER_VALUES, 'relevance');
  const confidence = selectedValues(query.relevanceConfidence, CONFIDENCE_FILTER_VALUES, 'relevanceConfidence');
  if (relevance.length) {
    params.push(relevance);
    where += ` AND ${recordRelevanceSql(alias)} = ANY($${params.length}::text[])`;
  }
  if (confidence.length) {
    params.push(confidence);
    where += ` AND ${recordRelevanceConfidenceBandSql(alias)} = ANY($${params.length}::text[])`;
  }
  return where;
}
