import { GM_VEHICLE_ALIASES, GM_COMPATIBLE_MODEL_SPELLINGS } from './gm-vehicle-aliases.js';

// Post intent and verifiable main-post evidence. Search metadata and comments
// are deliberately excluded: a recall keyword does not identify a vehicle.
export const POST_INTENTS = ['share', 'advertising', 'other', 'complaint', 'inquiry'];
export const MONITORING_EVIDENCE_VERSION = 'main-post-entity-v3';
export const SENTRY_SCOPE_KEYWORDS = ['别克哨兵', '至境哨兵', '凯迪拉克哨兵', '雪佛兰哨兵', '通用哨兵'];
export const POST_HASHTAG_PATTERN = '[#＃][^#＃\\s，。！？,!?;；]+';
const SEPARATOR = '[\\s_‐‑‒–—−-]*';
// Shared by JavaScript and PostgreSQL. SGMW is a separate company; masking the
// complete name prevents its prefix from inventing SAIC-GM evidence.
export const NON_SAIC_GM_ORG_PATTERN = `上汽\\s*通用\\s*五菱|上海\\s*通用\\s*五菱|(?<![a-z0-9])(?:saic${SEPARATOR}(?:gm|general\\s+motors)${SEPARATOR}wuling|shanghai\\s+general\\s+motors\\s+wuling|sgmw)(?![a-z0-9])`;
export const GENERIC_ENTITY_PATTERN = '^(我的车|这辆车|这台车|这个车|该车|本车|车辆|车型|汽车|轿车|车主|品牌|型号|新车|新能源|电动车|哨兵|哨兵模式|驻车监控|车机|通用|上汽|gm|sgm|saic|suv|mpv|car|vehicle|model|brand|my car|sentinel|unknown|none|null)$';
const VEHICLE_CONTEXT = '(?:车主|车型|汽车|轿车|车机|车门|车窗|车锁|哨兵|驻车|远控|远程|录像|行车|续航|油耗|提车|用车|试驾|发动机|变速箱|suv|mpv|car|vehicle|sedan|sentinel|parking|dashcam|onstar|owner|driv(?:e|ing))';
export const GM_VEHICLE_CONTEXT_PATTERN = '(?:车主|车型|汽车|轿车|车机|车门|车窗|车锁|哨兵|驻车|远控|远程|解锁|行车|续航|油耗|提车|用车|试驾|发动机|变速箱|(?<![a-z0-9])(?:suv|mpv|cars?|vehicles?|sedan|sentinel|parking|dashcam|onstar|driving)(?![a-z0-9]))';
const CONTEXT_GAP = '[\\s的我这台辆款新老]{0,6}';
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function aliasPattern(alias) {
  const normalized = alias.normalize('NFKC').trim();
  const code = /^[a-z]{1,4}[\s-]*\d{1,3}(?:[\s-]*[a-z])?$/i.test(normalized);
  const body = code ? [...normalized.replace(/[\s-]/g, '')].map(escapePattern).join(SEPARATOR)
    : normalized.split(/[\s_‐‑‒–—−-]+/u).map(escapePattern).join(SEPARATOR);
  return `${/^[a-z0-9]/i.test(normalized) ? '(?<![a-z0-9])' : ''}${body}${/[a-z0-9]$/i.test(normalized) ? '(?![a-z0-9])' : ''}`;
}

const aliasEntries = [...GM_VEHICLE_ALIASES, ...GM_COMPATIBLE_MODEL_SPELLINGS.map(value =>
  typeof value === 'string' ? { aliases: [value] } : value)];
const aliasMatchers = aliasEntries.flatMap(entry => entry.aliases.map(alias => {
  const body = aliasPattern(alias);
  // Letter-number model codes remain candidates even when shared by brands.
  // Ordinary words such as 世纪/开拓者 need a vehicle usage in the source.
  const contextual = entry.contextual && !/^[a-z]{1,4}[\s-]*\d{1,3}$/i.test(alias);
  const pattern = alias === '通用' ? `${body}(?=(?:汽车|集团|旗下)|的${VEHICLE_CONTEXT})`
    : contextual ? `(?:${body}(?=${CONTEXT_GAP}${VEHICLE_CONTEXT})|(?:我的|这辆|这台|这款|车主的|驾驶|开着|my\\s+|drive\\s+)${CONTEXT_GAP}${body})` : body;
  return { alias, pattern, body, contextual, entityPattern: new RegExp(body, 'i') };
})).sort((a, b) => b.alias.length - a.alias.length);

// One generated vocabulary drives both query-time and write-time matching.
export const GM_POST_ENTITY_PATTERN = `(?:${[...new Set(aliasMatchers.map(item => item.pattern))].join('|')})`;
// PostgreSQL compiles constant regexes while planning even EXPLAIN. Repeating
// the vehicle-context alternatives per alias causes seconds of cold planning.
// Factor the common context and bound the remaining direct-name alternatives;
// the union is identical to GM_POST_ENTITY_PATTERN, with no vocabulary change.
const contextualBodies = [...new Set(aliasMatchers.filter(item => item.contextual && item.alias !== '通用').map(item => item.body))];
const contextualBody = `(?:${contextualBodies.join('|')})`;
const directPatterns = [...new Set(aliasMatchers.filter(item => !item.contextual || item.alias === '通用').map(item => item.pattern))];
const sqlPatternGroups = [];
for (const pattern of directPatterns) {
  const previous = sqlPatternGroups.at(-1);
  if (!previous || previous.join('|').length + pattern.length > 900) sqlPatternGroups.push([pattern]);
  else previous.push(pattern);
}
export const GM_POST_ENTITY_SQL_PATTERNS = Object.freeze([
  ...sqlPatternGroups.map(group => `(?:${group.join('|')})`),
  `(?:${contextualBody}(?=${CONTEXT_GAP}${VEHICLE_CONTEXT})|(?:我的|这辆|这台|这款|车主的|驾驶|开着|my\\s+|drive\\s+)${CONTEXT_GAP}${contextualBody})`,
]);

// For English model names, vehicle context can be elsewhere in the current
// post. Adjacency must not reject "LaCrosse怎么开启哨兵" or a model-only title.
export const GM_CONTEXTUAL_MODEL_PATTERN = `(?:${GM_VEHICLE_ALIASES
  .filter(entry => entry.kind === 'model' && entry.contextual)
  .flatMap(entry => entry.aliases.filter(alias => /^[a-z]/i.test(alias)).map(aliasPattern)).join('|')})`;

export function maskNonSaicGmOrganizations(text) {
  return text.replace(new RegExp(NON_SAIC_GM_ORG_PATTERN, 'gi'), value => ' '.repeat(value.length));
}

// Match normalized spellings, but always quote the actual source. Mapping by
// normalized prefix length also handles full-width letters and Unicode ligatures.
function sourceOffset(text, offset, end = false) {
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const size = text.slice(0, middle).normalize('NFKC').length;
    if (size < offset || (!end && size === offset)) low = middle + 1;
    else high = middle;
  }
  return end ? low : Math.max(0, low - (text.slice(0, low).normalize('NFKC').length > offset ? 1 : 0));
}

export function formatGmAliasesForPrompt() {
  const groups = ['company', 'brand', 'subbrand', 'model', 'service'].map(kind =>
    GM_VEHICLE_ALIASES.filter(entry => entry.kind === kind)
      .map(entry => `${entry.canonicalName}=${entry.aliases.join('/')}`).join('；'));
  return `上汽通用名称参考（用于识别，不是穷尽白名单；普通词、跨品牌简称须结合全文）：\n${groups.filter(Boolean).join('\n')}\n上汽通用与上汽通用五菱不是同一公司，SAIC/上汽也不能单独认作上汽通用。`;
}

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(String(value || '{}')); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

export function normalizePostIntent(value) {
  const intent = String(value || '').trim().toLowerCase();
  if (intent === 'suggestion') return 'other';
  return POST_INTENTS.includes(intent) ? intent : '';
}

export function normalizeJudgmentConfidence(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

export function isSentryEvidenceScope(record = {}) {
  const keywords = [record.keyword, ...(Array.isArray(record.observed_keywords) ? record.observed_keywords : [])];
  return keywords.some(value => {
    const keyword = String(value || '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
    return SENTRY_SCOPE_KEYWORDS.some(term => keyword.includes(term));
  });
}

function mediaUrl(value) {
  return String(typeof value === 'object' && value ? value.url || value.src || value.downloadUrl || '' : value || '').trim();
}

export function currentPostMediaUrl(record = {}) {
  const payload = object(record.payload);
  return [record.video_url, payload.videoUrl, payload.video_url, payload.awemeVideoUrl,
    payload.videoUrls?.[0], record.audio_url, payload.audioUrl, payload.musicUrl, payload.audioUrls?.[0]]
    .map(mediaUrl).find(value => /^https?:\/\//i.test(value)) || '';
}

export function getRecordEvidenceSources(record = {}) {
  const entries = [['title', record.title], ['content', record.content]];
  const currentUrl = currentPostMediaUrl(record);
  if (record.transcript_status === 'done' && currentUrl && currentUrl === String(record.transcript_source_url || '').trim()) {
    entries.push(['transcript', record.transcript]);
  }
  return entries.map(([source, value]) => ({ source, text: String(value || '').replace(new RegExp(POST_HASHTAG_PATTERN, 'gu'), ' ').trim() }))
    .filter(entry => entry.text);
}

export function findMainPostGmEvidence(record = {}) {
  const evidence = [];
  const sources = getRecordEvidenceSources(record);
  const vehicleContext = sources.some(({ text }) => new RegExp(GM_VEHICLE_CONTEXT_PATTERN, 'i')
    .test(maskNonSaicGmOrganizations(text.normalize('NFKC'))));
  for (const { source, text } of sources) {
    const pattern = new RegExp(vehicleContext ? `(?:${GM_POST_ENTITY_PATTERN}|${GM_CONTEXTUAL_MODEL_PATTERN})` : GM_POST_ENTITY_PATTERN, 'gi');
    const normalized = maskNonSaicGmOrganizations(text.normalize('NFKC'));
    for (const match of normalized.matchAll(pattern)) {
      const entityMatch = aliasMatchers.map(item => item.entityPattern.exec(match[0])).find(Boolean);
      if (!entityMatch) continue;
      const entityStart = sourceOffset(text, match.index + entityMatch.index);
      const entityEnd = sourceOffset(text, match.index + entityMatch.index + entityMatch[0].length, true);
      const entity = text.slice(entityStart, entityEnd);
      const quote = text.slice(Math.max(0, entityStart - 25), Math.min(text.length, entityEnd + 60)).trim();
      evidence.push({ source, quote, entity });
      if (evidence.length >= 6) return evidence;
    }
  }
  return evidence;
}

export function hasWholeSourceEntity(text, entity) {
  let position = -1;
  while ((position = text.indexOf(entity, position + 1)) !== -1) {
    const before = text.slice(position - 1, position).normalize('NFKC');
    const after = text.slice(position + entity.length, position + entity.length + 1).normalize('NFKC');
    const normalized = entity.normalize('NFKC');
    if ((!/^[a-z0-9]/i.test(normalized) || !/[a-z0-9]/i.test(before))
      && (!/[a-z0-9]$/i.test(normalized) || !/[a-z0-9]/i.test(after))) return true;
  }
  return false;
}

// A finite dictionary may miss a new model or a real nickname. Accept the
// classifier's explicit brand/model attribution only with a literal, current
// main-post citation. This does not turn a model assertion into an official name.
export function findRecordMonitoringEvidence(result = {}, record = {}) {
  const evidence = findMainPostGmEvidence(record);
  const entries = object(result.monitoringEvidence).evidence;
  if (result.relevance !== 'relevant' || !Array.isArray(entries)) return evidence;
  const sources = getRecordEvidenceSources(record);
  for (const item of entries.slice(0, 12)) {
    if (!item || !['brand', 'model'].includes(item.entityType) || item.manufacturer !== 'saic_gm'
      || typeof item.quote !== 'string' || typeof item.entity !== 'string') continue;
    const quote = item.quote.trim();
    const entity = item.entity.trim();
    if (quote.length < 2 || quote.length > 500 || entity.length < 2 || entity.length > 80
      || new RegExp(GENERIC_ENTITY_PATTERN, 'i').test(entity.normalize('NFKC'))
      || new RegExp(NON_SAIC_GM_ORG_PATTERN, 'i').test(entity.normalize('NFKC'))) continue;
    const source = sources.find(entry => entry.source === item.source);
    if (!source || !source.text.includes(quote) || !hasWholeSourceEntity(quote, entity)) continue;
    // Keep the raw quote exact while checking excluded organizations in NFKC.
    if (!hasWholeSourceEntity(maskNonSaicGmOrganizations(quote.normalize('NFKC')), entity.normalize('NFKC'))
      || !hasWholeSourceEntity(maskNonSaicGmOrganizations(source.text.normalize('NFKC')), entity.normalize('NFKC'))) continue;
    if (!evidence.some(entry => entry.source === source.source && entry.entity === entity && entry.quote === quote)) {
      evidence.push({ source: source.source, quote, entity, entityType: item.entityType, manufacturer: 'saic_gm' });
    }
    if (evidence.length >= 6) return evidence.slice(0, 6);
  }
  return evidence;
}

export function normalizeMonitoringEvidence(result = {}, record = {}) {
  // Rebuild citations from current source text. A missing, cropped or malformed
  // model quote must neither invent evidence nor veto an otherwise relevant post.
  const evidence = findRecordMonitoringEvidence(result, record);
  const confirmed = result.relevance === 'relevant' && evidence.length > 0;
  return {
    version: MONITORING_EVIDENCE_VERSION,
    status: confirmed ? 'confirmed' : 'needs_review',
    evidence,
    reason: confirmed ? '主帖包含品牌或车型线索，结合整体语境判断为相关'
      : result.relevance === 'irrelevant' ? '内容被判定为与监控对象无关'
        : evidence.length ? '主帖已有车型线索，整体相关性尚未确认'
          : '主帖缺少可核验的品牌或车型线索',
  };
}
