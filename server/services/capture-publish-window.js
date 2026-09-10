const DAY_MS = 86400000;
const SHANGHAI_OFFSET_MS = 8 * 3600000;
const WINDOW_DAYS = {day: 1, week: 7, month: 30};
const WINDOWS = new Set([...Object.keys(WINDOW_DAYS), 'halfyear']);
const KEYWORD_TASKS = new Set(['unattended_keyword_capture', 'keyword_capture', 'search_capture', 'keyword_orchestration', 'capture.search', 'keyword']);
const DATE_FIELDS = ['publishDateRaw', 'publishTime', 'publishDate'];
const REGION_SUFFIX = /\s+(?:北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)$/u;

const text = value => typeof value === 'string' ? value.trim() : '';
function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
    catch { return {}; }
  }
  return {};
}

function validCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31 &&
    date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

// No Date.parse fallback: arbitrary text and rollover dates must stay unverified.
// Zone-free platform dates have Shanghai semantics, independent of server TZ.
function absoluteDate(value) {
  const numeric = value.match(/^(20\d{2})([-/.])(\d{1,2})\2(\d{1,2})(?:[T ](\d{1,2})[:：](\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/iu);
  const chinese = numeric ? null : value.match(/^(20\d{2})年(\d{1,2})月(\d{1,2})日?(?: (\d{1,2})[:：](\d{2})(?::(\d{2}))?)?$/u);
  if (!numeric && !chinese) return null;
  const parts = numeric
    ? [numeric[1], numeric[3], numeric[4], numeric[5], numeric[6], numeric[7], numeric[8], numeric[9]]
    : [chinese[1], chinese[2], chinese[3], chinese[4], chinese[5], chinese[6], undefined, undefined];
  const [year, month, day] = parts.slice(0, 3).map(Number);
  if (!validCalendarDate(year, month, day)) return null;
  if (parts[3] === undefined) {
    const start = Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS;
    return {start, end: start + DAY_MS, precision: 'day'};
  }
  const hour = Number(parts[3]), minute = Number(parts[4]), second = Number(parts[5] || 0);
  const millisecond = Number((parts[6] || '').padEnd(3, '0'));
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offset = SHANGHAI_OFFSET_MS;
  if (parts[7]?.toUpperCase() === 'Z') offset = 0;
  else if (parts[7]) {
    const zone = parts[7].match(/^([+-])(\d{2})(?::?(\d{2}))?$/u);
    const hours = Number(zone[2]), minutes = Number(zone[3] || 0);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
    offset = (hours * 60 + minutes) * 60000 * (zone[1] === '+' ? 1 : -1);
  }
  const start = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offset;
  const precision = parts[5] === undefined ? 'minute' : parts[6] === undefined ? 'second' : 'instant';
  return {start, end: start + (precision === 'minute' ? 60000 : precision === 'second' ? 1000 : 0), precision};
}

function instant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) && value.getTime() > 0 ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : null;
  if (/^\d{13}$/u.test(text(value))) return Number(value);
  const parsed = absoluteDate(text(value));
  return parsed && parsed.precision !== 'day' ? parsed.start : null;
}

function shanghaiDay(timestamp) {
  const date = new Date(timestamp + SHANGHAI_OFFSET_MS);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - SHANGHAI_OFFSET_MS;
}

function cutoffFor(window, reference) {
  if (window !== 'halfyear') return reference - WINDOW_DAYS[window] * DAY_MS;
  const date = new Date(reference + SHANGHAI_OFFSET_MS);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 6);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime() - SHANGHAI_OFFSET_MS;
}

function isKeywordTask(task, metadata) {
  const identifiers = [task.task_type, task.feature_key, task.execution_mode, metadata.promotedBusinessTaskType,
    metadata.businessTaskType, metadata.workflow, metadata.execution_mode].map(text).filter(Boolean);
  // An attached patrol can inherit its parent's search filters. Its own workflow
  // always wins over a keyword-looking task type or plan snapshot.
  if (identifiers.some(value => /patrol|blogger|single_note|official|capture\.(?:comments|enhancement|detail)/u.test(value))) return false;
  return identifiers.some(value => KEYWORD_TASKS.has(value));
}

function sourceCandidate(record) {
  const payload = object(record.payload);
  const index = Array.isArray(payload.items) ? payload.items.findIndex(value => value && typeof value === 'object' && !Array.isArray(value)) : -1;
  const first = index < 0 ? {} : object(payload.items[index]);
  const candidates = [[object(payload.detailPayload), 'payload.detailPayload', true],
    [object(first.detailPayload), `payload.items[${index}].detailPayload`, true],
    [first, `payload.items[${index}]`, false], [payload, 'payload', false]];
  for (const [value, path, isDetail] of candidates) {
    const field = DATE_FIELDS.find(field => text(value[field]));
    if (field) return {value, path, field, isDetail, raw: text(value[field]), payload};
  }
  return null;
}

function cleanDate(value) {
  return value.replace(/\s+/gu, ' ').replace(/^(?:发布于|发表于|发布时间\s*[:：]?)\s*/u, '').replace(REGION_SUFFIX, '').trim();
}

function yearlessUpperBound(value, captureTimestamp) {
  const parts = value.match(/^(\d{1,2})-(\d{1,2})$/u);
  if (!parts || captureTimestamp === null) return null;
  // This is an upper bound, not an inferred publication year. A past month/day
  // could belong to any earlier year, all of which are older. A future month/day
  // is left unknown. Use the date source's observation year to avoid treating a
  // fresh January post as old when a task started in the previous December.
  const year = new Date(captureTimestamp + SHANGHAI_OFFSET_MS).getUTCFullYear();
  const parsed = absoluteDate(`${year}-${parts[1]}-${parts[2]}`);
  if (!parsed || parsed.start > shanghaiDay(captureTimestamp)) return null;
  return parsed;
}

function upperBoundEvidence(parsed, basis) {
  return {...parsed, upperBoundTimestamp: parsed.end > parsed.start ? parsed.end : parsed.start + 1, upperBoundBasis: basis};
}

function parseEvidence(raw, captureTimestamp, absoluteOnly = false, dateSourceTimestamp = null) {
  const clean = cleanDate(raw);
  const edited = clean.match(/^(?:编辑于|更新于|最近编辑|最后编辑)\s*[:：]?\s*(.+)$/u);
  if (edited) {
    const fullDate = absoluteDate(edited[1]);
    if (fullDate) return upperBoundEvidence(fullDate, 'edited_date');
    const yearless = absoluteOnly ? yearlessUpperBound(edited[1], dateSourceTimestamp) : null;
    return yearless ? upperBoundEvidence(yearless, 'edited_yearless_date') : {reason: 'publish_time_edited'};
  }
  const absolute = absoluteDate(clean);
  if (absolute) return absolute;
  if (absoluteOnly) {
    const yearless = yearlessUpperBound(clean, dateSourceTimestamp);
    return yearless ? upperBoundEvidence(yearless, 'publish_yearless_date') : {reason: 'detail_publish_time_not_absolute'};
  }
  if (/^\d{1,2}[-/.月]\d{1,2}日?(?:\s|$)/u.test(clean)) return {reason: 'publish_year_missing'};
  const relative = clean.match(/^(\d{1,6})\s*(分钟|小时)前$/u);
  const days = clean.match(/^(\d{1,6})\s*天前$/u);
  const named = clean.match(/^(今天|昨天|前天)(?:\s*(\d{1,2})[:：](\d{2}))?$/u);
  if (relative || days || named || clean === '刚刚') {
    if (captureTimestamp === null) return {reason: 'relative_reference_missing'};
    if (relative || clean === '刚刚') {
      const duration = relative ? Number(relative[1]) * (relative[2] === '小时' ? 3600000 : 60000) : 0;
      return {start: captureTimestamp - duration, end: captureTimestamp - duration, precision: 'relative'};
    }
    const back = days ? Number(days[1]) : {今天: 0, 昨天: 1, 前天: 2}[named[1]];
    const start = shanghaiDay(captureTimestamp) - back * DAY_MS;
    if (named?.[2] !== undefined) {
      if (Number(named[2]) > 23 || Number(named[3]) > 59) return {reason: 'publish_time_invalid'};
      const exact = start + Number(named[2]) * 3600000 + Number(named[3]) * 60000;
      return {start: exact, end: exact + 60000, precision: 'minute'};
    }
    return {start, end: start + DAY_MS, precision: 'day'};
  }
  return {reason: clean ? 'publish_time_invalid' : 'publish_time_missing'};
}

/** The caller supplies a server-authoritative task after checking tenant and
 * capture lineage. Client-supplied filters in record.payload are never read.
 * All timestamps in the result are milliseconds; interval ends are exclusive.
 * now is only a future-date sanity bound, never a rolling publish-window anchor. */
export function evaluateCapturePublishWindow({record = {}, task = null, now = null} = {}) {
  const result = {applies: false, status: 'not_applicable', reason: '', window: null,
    referenceTimestamp: null, cutoffTimestamp: null, referenceSource: null,
    publishTimestamp: null, publishEndTimestamp: null, publishTimeRaw: null, source: null, precision: null,
    upperBoundTimestamp: null, upperBoundBasis: null, upperBoundExclusive: null};
  const answer = (status, reason, extra = {}) => ({...result, status, reason, ...extra});
  if (record?.record_type !== 'keyword_notes') return answer('not_applicable', 'record_type_not_keyword_notes');
  if (!['xiaohongshu', 'douyin'].includes(record.platform)) return answer('not_applicable', 'platform_not_supported');
  if (!task || typeof task !== 'object') return answer('not_applicable', 'task_missing');
  const metadata = object(task.metadata);
  if (!isKeywordTask(task, metadata)) return answer('not_applicable', 'task_not_keyword_capture');
  const plan = object(task.plan_snapshot ?? task.planSnapshot ?? metadata.planSnapshot ?? metadata.plan_snapshot);
  if ((task.platform || plan.platform) !== record.platform) return answer('not_applicable', 'task_platform_mismatch');
  const keyword = text(record.keyword);
  if (!keyword) return answer('not_applicable', 'record_keyword_missing');
  // An explicit plan scope (even empty/invalid) is authoritative. Only legacy
  // tasks without a plan keywords field may fall back to metadata.keywords.
  const keywords = Object.hasOwn(plan, 'keywords') ? plan.keywords : metadata.keywords;
  if (!Array.isArray(keywords) || !keywords.some(value => text(value) === keyword)) {
    return answer('not_applicable', 'task_keyword_mismatch');
  }
  const window = object(plan.searchFilters).publishTime;
  if (window === 'all' || window === null || window === undefined || window === '') return answer('not_applicable', 'time_window_unrestricted');
  if (!WINDOWS.has(window)) return answer('not_applicable', 'time_window_unsupported');
  result.applies = true;
  result.window = window;
  const started = instant(task.started_at), created = instant(task.created_at);
  const reference = started ?? created;
  if (reference === null) return answer('unverified', 'task_reference_missing');
  result.referenceTimestamp = reference;
  result.referenceSource = started === null ? 'created_at' : 'started_at';
  result.cutoffTimestamp = cutoffFor(window, reference);
  const candidate = sourceCandidate(record);
  if (!candidate) return answer('unverified', 'publish_source_missing');
  result.source = `${candidate.path}.${candidate.field}`;
  result.publishTimeRaw = candidate.raw;
  const provenance = ['publishDateSource', 'publishTimeSource', 'publish_date_source'].map(field => text(candidate.value[field])).join(' ');
  if (/title|content|body|fallback|guess|infer|capture_time|last_edited/iu.test(provenance) || candidate.value.publishTimeKnown === false || candidate.value.publishDateKnown === false) {
    return answer('unverified', 'publish_source_untrusted');
  }
  if (record.platform === 'xiaohongshu' && !candidate.isDetail && text(candidate.value.publishDateSource) !== 'date_element') {
    return answer('unverified', 'publish_source_untrusted');
  }
  const sourceId = candidate.value.noteId || candidate.value.externalId;
  if (record.external_id && sourceId && String(sourceId) !== String(record.external_id)) return answer('unverified', 'publish_source_identity_mismatch');
  const observed = [candidate.value.captureTimestamp, candidate.value.capture_timestamp, candidate.payload.captureTimestamp,
    candidate.payload.capture_timestamp, record.capture_timestamp].map(instant).find(value => value !== null) ?? null;
  const current = instant(now);
  const captureTimestamp = observed !== null && observed >= reference - 5 * 60000 &&
    (current === null || observed <= current + 5 * 60000) ? observed : null;
  const ownObserved = [candidate.value.captureTimestamp, candidate.value.capture_timestamp].map(instant).find(value => value !== null) ?? null;
  const dateSourceTimestamp = ownObserved === captureTimestamp ? ownObserved : null;
  const evidence = parseEvidence(candidate.raw, captureTimestamp, candidate.isDetail, dateSourceTimestamp);
  if (evidence.reason) return answer('unverified', evidence.reason);
  // Keep raw date precision. A derived midnight ISO value must not turn a
  // date-only label into proof that the whole boundary date has expired.
  for (const field of ['publishTime', 'publishDate']) {
    if (field === candidate.field || !text(candidate.value[field])) continue;
    const additional = absoluteDate(cleanDate(text(candidate.value[field])));
    if (!additional) continue;
    const end = value => value.end > value.start ? value.end - 1 : value.end;
    const conflict = evidence.upperBoundTimestamp !== undefined
      ? additional.start >= evidence.upperBoundTimestamp
      : Math.max(evidence.start, additional.start) > Math.min(end(evidence), end(additional));
    if (conflict) {
      return answer('unverified', 'publish_time_conflict');
    }
  }
  const sanityReference = captureTimestamp ?? current ?? reference;
  if (evidence.start > sanityReference + DAY_MS || !Number.isFinite(evidence.start) || evidence.start <= 0) {
    return answer('unverified', 'publish_time_future_or_invalid');
  }
  if (evidence.upperBoundTimestamp !== undefined) {
    const out = evidence.upperBoundTimestamp <= result.cutoffTimestamp;
    const reason = evidence.upperBoundBasis.startsWith('edited_') ? 'edited_upper_bound' : 'publish_year_upper_bound';
    // Recent edits and a plausible current-year date never prove recent
    // publication. Bounds must not be persisted as real publish timestamps.
    return answer(out ? 'out_of_range' : 'unverified', `${reason}_${out ? 'before_window' : 'not_proven'}`, {
      upperBoundTimestamp: evidence.upperBoundTimestamp, upperBoundBasis: evidence.upperBoundBasis, upperBoundExclusive: true,
    });
  }
  const out = evidence.end > evidence.start ? evidence.end <= result.cutoffTimestamp : evidence.start < result.cutoffTimestamp;
  return answer(out ? 'out_of_range' : 'in_range', out ? 'publish_time_before_window' : 'publish_time_within_window', {
    publishTimestamp: evidence.start, publishEndTimestamp: evidence.end, precision: evidence.precision,
  });
}
