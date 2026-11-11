// Pure cross-platform matching. No database writes, network, or changes to report/triage semantics.
export const NON_POST_TYPES = new Set(['comment', 'comments', 'record_comment', 'comment_detail', 'official_content', 'blogger_profile']);
const PLATFORMS = new Set(['douyin', 'xiaohongshu', 'wechat_channels']);
const HOUR = 3_600_000;
const text = value => String(value ?? '').normalize('NFKC');
const chars = value => Array.from(value);
const length = value => chars(value).length;
const meaningfulLength = value => (value.match(/[\p{L}\p{N}]/gu) || []).length;
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const ms = value => value === null || value === undefined || value === '' ? NaN : new Date(value).getTime();
const removeEmoji = value => value.replace(/[0-9#*]\uFE0F?\u20E3/gu, '')
  .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D]/gu, '');

export function normalizeAuthor(value) {
  return removeEmoji(text(value)).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Object input joins the title and first 500 body characters (including when the title is empty). */
export function normalizeContent(value) {
  const input = value && typeof value === 'object'
    ? `${value.title ?? ''}\n${chars(String(value.content ?? '')).slice(0, 500).join('')}` : value;
  return removeEmoji(text(input)).toLowerCase()
    .replace(/(?:https?:\/\/|www\.)[^\s]+/giu, '')
    .replace(/#[^\s#，。！？、；：,.!?;:]+#?/gu, '')
    .replace(/@[^\s@#，。！？、；：,.!?;:]+/gu, '')
    .replace(/\s/gu, '');
}

function bigrams(value) {
  const points = chars(value), counts = new Map();
  for (let i = 1; i < points.length; i++) {
    const key = points[i - 1] + points[i];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
function dice(a, b) {
  let common = 0, total = 0;
  for (const [key, n] of a) { common += Math.min(n, b.get(key) || 0); total += n; }
  for (const n of b.values()) total += n;
  return total ? 2 * common / total : 0;
}

// Suffix automaton: exact longest common substring in linear time, avoiding 500 x 500 per candidate.
function suffixes(value) {
  const states = [{len: 0, link: -1, next: new Map()}];
  let last = 0;
  for (const char of chars(value)) {
    const current = states.length;
    states.push({len: states[last].len + 1, link: 0, next: new Map()});
    let p = last;
    while (p >= 0 && !states[p].next.has(char)) { states[p].next.set(char, current); p = states[p].link; }
    if (p >= 0) {
      const q = states[p].next.get(char);
      if (states[p].len + 1 === states[q].len) states[current].link = q;
      else {
        const clone = states.length;
        states.push({len: states[p].len + 1, link: states[q].link, next: new Map(states[q].next)});
        while (p >= 0 && states[p].next.get(char) === q) { states[p].next.set(char, clone); p = states[p].link; }
        states[q].link = states[current].link = clone;
      }
    }
    last = current;
  }
  return states;
}
function commonSubstring(states, value) {
  let state = 0, size = 0, best = 0, meaningfulBest = 0;
  const prefix = [0];
  for (const char of chars(value)) {
    prefix.push(prefix.at(-1) + meaningfulLength(char));
    while (state && !states[state].next.has(char)) { state = states[state].link; size = states[state].len; }
    if (states[state].next.has(char)) { state = states[state].next.get(char); size++; }
    else { state = 0; size = 0; }
    best = Math.max(best, size);
    meaningfulBest = Math.max(meaningfulBest, prefix.at(-1) - prefix[prefix.length - 1 - size]);
  }
  return {rawLength: best, meaningfulLength: meaningfulBest};
}

function prepare(record) {
  const tenant = String(record?.tenant_id ?? ''), id = String(record?.id ?? '');
  const author = normalizeAuthor(record?.author_name ?? record?.author);
  const platform = text(record?.platform).trim().toLowerCase();
  if (!tenant || !id || !PLATFORMS.has(platform) || NON_POST_TYPES.has(record.record_type) || length(author) < 2) return null;
  const published = ms(record.published_ts ?? record.published_at), created = ms(record.created_at);
  const time = Number.isFinite(published) ? published : created;
  if (!Number.isFinite(time)) return null;
  const content = normalizeContent(record), meaningfulContentLength = meaningfulLength(content);
  if (meaningfulContentLength < 8) return null;
  return {record, tenant, id, platform, author, content, time, created: Number.isFinite(created) ? created : Infinity,
    meaningfulContentLength, authorGrams: bigrams(author), contentGrams: bigrams(content), timeSource: Number.isFinite(published) ? 'published' : 'created_at'};
}
function authorMatch(a, b) {
  const score = dice(a.authorGrams, b.authorGrams), shortest = Math.min(length(a.author), length(b.author));
  const rule = a.author === b.author ? 'exact' : shortest >= 3 && (a.author.includes(b.author) || b.author.includes(a.author))
    ? 'contains' : score >= 0.8 ? 'dice' : null;
  return rule ? {rule, score} : null;
}
function eligiblePair(a, b) {
  return a.tenant === b.tenant && a.id !== b.id && a.platform !== b.platform && Math.abs(a.time - b.time) <= 72 * HOUR;
}
function matchPrepared(a, b) {
  if (!eligiblePair(a, b)) return null;
  const author = authorMatch(a, b);
  if (!author) return null;
  const contentDice = dice(a.contentGrams, b.contentGrams);
  a.substrings ??= suffixes(a.content);
  const substring = commonSubstring(a.substrings, b.content);
  const shorterMeaningful = Math.min(a.meaningfulContentLength, b.meaningfulContentLength);
  const shorter = Math.min(length(a.content), length(b.content));
  const contains = shorterMeaningful >= 12 && (a.content.includes(b.content) || b.content.includes(a.content));
  const contentRules = [];
  if (contentDice >= 0.6) contentRules.push('dice');
  if (substring.meaningfulLength >= 15) contentRules.push('substring');
  if (contains) contentRules.push('contains');
  const commonSubstringCoverage = substring.meaningfulLength / shorterMeaningful;
  // A repeated signature must not connect otherwise unrelated long posts through a short shared fragment.
  if (!contentRules.length || (contentDice < 0.6 && commonSubstringCoverage < 0.4 && contentDice < 0.3)) return null;
  return {score: contentDice, evidence: {version: 1, authorRule: author.rule, authorDice: author.score,
    contentRules, contentDice, longestCommonSubstring: substring.rawLength, longestCommonSubstringMeaningful: substring.meaningfulLength,
    shorterContentLength: shorter, shorterMeaningfulContentLength: shorterMeaningful, commonSubstringCoverage,
    hoursApart: Math.abs(a.time - b.time) / HOUR, timeSources: [a.timeSource, b.timeSource]}};
}

/** null means one of the four required rules failed; successful evidence contains every content criterion. */
export function matchPair(a, b) {
  const left = prepare(a), right = prepare(b);
  return left && right ? matchPrepared(left, right) : null;
}

const comparePrepared = (a, b) => lexical(a.tenant, b.tenant) || (a.created === b.created ? 0 : a.created - b.created) || lexical(a.id, b.id);
function preparedRecords(records) {
  const seen = new Set();
  return records.map(prepare).filter(Boolean).sort(comparePrepared).filter(row => {
    const key = JSON.stringify([row.tenant, row.id]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function candidatePairs(records) {
  const pairs = [], tenants = new Map();
  for (let i = 0; i < records.length; i++) {
    const current = records[i];
    if (!tenants.has(current.tenant)) tenants.set(current.tenant, new Map());
    const index = tenants.get(current.tenant), candidates = new Set();
    // Exact/containing authors and Dice >= .8 must share at least one character bigram.
    for (const gram of current.authorGrams.keys()) for (const j of index.get(gram) || []) candidates.add(j);
    for (const j of [...candidates].sort((a, b) => a - b)) {
      if (eligiblePair(records[j], current) && authorMatch(records[j], current)) pairs.push([j, i]);
    }
    for (const gram of current.authorGrams.keys()) {
      if (!index.has(gram)) index.set(gram, []);
      index.get(gram).push(i);
    }
  }
  return pairs;
}
/** Candidate records, not all pairs: tenant-separated author bigram index, then author/time/platform gates. */
export function buildCandidatePairs(records) {
  const prepared = preparedRecords(records);
  return candidatePairs(prepared).map(([a, b]) => [prepared[a].record, prepared[b].record]);
}

/** Deterministic bounded union; exclusions constrain entire groups, including indirect A-B-C paths. */
export function groupCrossPosts(records, {exclusions = [], maxGroupSize = 6} = {}) {
  if (!Number.isInteger(maxGroupSize) || maxGroupSize < 2 || maxGroupSize > 6) throw new RangeError('maxGroupSize must be between 2 and 6');
  const prepared = preparedRecords(records), parents = prepared.map((_, i) => i), members = prepared.map((_, i) => [i]);
  const key = (tenant, a, b) => JSON.stringify([String(tenant), ...[String(a), String(b)].sort(lexical)]);
  const blocked = new Set(exclusions.map(row => key(row.tenant_id, row.record_a, row.record_b)));
  const find = i => parents[i] === i ? i : (parents[i] = find(parents[i]));
  const edges = candidatePairs(prepared).map(([a, b]) => ({a, b, match: matchPrepared(prepared[a], prepared[b])}))
    .filter(edge => edge.match).sort((a, b) => b.match.score - a.match.score || a.b - b.b || a.a - b.a);
  const accepted = [];
  for (const edge of edges) {
    const left = find(edge.a), right = find(edge.b);
    if (left !== right) {
      if (members[left].length + members[right].length > maxGroupSize) continue;
      if (members[left].some(a => members[right].some(b => blocked.has(key(prepared[a].tenant, prepared[a].id, prepared[b].id))))) continue;
      const first = Math.min(left, right), second = Math.max(left, right);
      parents[second] = first; members[first].push(...members[second]); members[second] = [];
    }
    accepted.push(edge);
  }
  const groups = new Map();
  for (let i = 0; i < prepared.length; i++) {
    const root = find(i);
    if (members[root].length < 2) continue;
    if (!groups.has(root)) groups.set(root, {tenantId: prepared[root].tenant, groupId: prepared[root].id, records: [], matches: []});
    groups.get(root).records.push(prepared[i].record);
  }
  for (const {a, b, match} of accepted) groups.get(find(a))?.matches.push({recordA: prepared[a].id, recordB: prepared[b].id, ...match});
  return [...groups.values()];
}
