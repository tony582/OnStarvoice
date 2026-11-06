import {createHash} from 'node:crypto';

// Pure readers of recognized text rows ({text, conf, x, y, w, h} in screenshot pixels) for WeChat 8.0.80 on the
// calibrated 1080x2242 DE106 screen. Nothing here touches the phone.

export const SCREEN = Object.freeze({width: 1080, height: 2242});
// Two result columns (measured 2026-11-05): a card's duration row sits at the thumbnail's lower left.
const COLUMNS = Object.freeze([{x0: 18, x1: 531}, {x0: 548, x1: 1061}]);
// Below the search box, tabs and sort row nothing on the results page is a card.
export const RESULTS_TOP = 480;
// The comment input box at the bottom of the panel; no tap may land here.
export const COMMENT_INPUT_TOP = 2100;

const DURATION = /^\d{1,2}[:：]\d{2}(?:[:：]\d{2})?$/u;
const FOLD = /[.。…·•]+$/u;
const center = row => ({x: row.x + Math.round(row.w / 2), y: row.y + Math.round(row.h / 2)});
const byPosition = (a, b) => a.y - b.y || a.x - b.x;

/** Comparable form of recognized text: NFKC, no spaces, no fold marks, common OCR variant characters mapped. */
export function comparable(value) {
  return String(value ?? '').normalize('NFKC').replace(/[別]/gu, '别').replace(/[\s​]+/gu, '')
    .replace(/[.。…·•｜|]+/gu, '').toLowerCase();
}

function bigrams(text) {
  const set = new Map();
  for (let i = 0; i < text.length - 1; i++) { const pair = text.slice(i, i + 2); set.set(pair, (set.get(pair) ?? 0) + 1); }
  return set;
}
/** Dice similarity of two comparable strings (0..1); short strings must match exactly. */
export function similarity(a, b) {
  const left = comparable(a), right = comparable(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 3 || right.length < 3) return 0;
  const one = bigrams(left), two = bigrams(right);
  let shared = 0;
  for (const [pair, count] of one) shared += Math.min(count, two.get(pair) ?? 0);
  return (2 * shared) / (left.length - 1 + right.length - 1);
}

export function findText(rows, wanted, {region = null, exact = true} = {}) {
  const goal = comparable(wanted);
  const hits = rows.filter(row => (!region || (row.y >= region.y0 && row.y <= region.y1 && row.x >= (region.x0 ?? 0)
    && row.x <= (region.x1 ?? SCREEN.width))) && (exact ? comparable(row.text) === goal : comparable(row.text).includes(goal)));
  return hits.sort(byPosition).map(row => ({...row, center: center(row)}));
}

/**
 * A short label OCR may read together with its neighbours as one line: with a 服务号 card on top of the results the tabs
 * came back as "视频 账号" (2026-11-05, ibuick/别克远控/上汽通用客服). Exact rows win; otherwise a row whose space-separated
 * words include the label, centred on that word's share of the row width.
 */
export function findWord(rows, wanted, {region = null} = {}) {
  const exact = findText(rows, wanted, {region});
  if (exact.length) return exact;
  const goal = comparable(wanted);
  const hits = [];
  for (const row of findText(rows, wanted, {region, exact: false})) {
    const words = String(row.text ?? '').normalize('NFKC').split(/\s+/u).filter(Boolean);
    const index = words.findIndex(word => comparable(word) === goal);
    if (index < 0) continue;
    const total = words.reduce((sum, word) => sum + word.length, 0) + words.length - 1;
    const before = words.slice(0, index).reduce((sum, word) => sum + word.length + 1, 0);
    hits.push({...row, text: words[index], center: {x: row.x + Math.round(row.w * (before + words[index].length / 2) / total), y: row.center.y}});
  }
  return hits;
}

const UNIT_HOURS = {分钟: 1 / 60, 小时: 1, 天: 24, 周: 168, 星期: 168, 个月: 720, 月: 720, 年: 8760};
/**
 * A relative or dated publication label ("8分钟前", "1 小时…", "前天", "11月3日", "2025年3月1日") as an age range in
 * hours relative to `now` (ms). Labels cut short by the card ("22 小时…") keep their number and unit. Unknown → null.
 */
export function parseTimeLabel(label, now = Date.now()) {
  const text = String(label ?? '').normalize('NFKC').replace(/\s+/gu, '').replace(FOLD, '');
  if (!text) return null;
  if (/^刚刚/u.test(text)) return {minHours: 0, maxHours: 1 / 60, precision: 'minute'};
  const relative = text.match(/^(\d{1,4})(分钟|小时|天|周|星期|个月|月|年)/u);
  if (relative) {
    const n = Number(relative[1]), unit = UNIT_HOURS[relative[2]];
    return {minHours: n * unit, maxHours: (n + 1) * unit, precision: relative[2]};
  }
  const named = text.match(/^(今天|昨天|前天)/u);
  const beijing = new Date(now + 8 * 3600_000);
  const sinceMidnight = (beijing.getUTCHours() * 60 + beijing.getUTCMinutes()) / 60;
  if (named) {
    const back = {今天: 0, 昨天: 1, 前天: 2}[named[1]];
    return {minHours: back === 0 ? 0 : sinceMidnight + (back - 1) * 24, maxHours: sinceMidnight + back * 24, precision: 'day'};
  }
  const dated = text.match(/^(?:(\d{4})[年\-/.])?(\d{1,2})[月\-/.](\d{1,2})日?$/u);
  if (dated) {
    const year = dated[1] ? Number(dated[1]) : beijing.getUTCFullYear();
    const start = Date.UTC(year, Number(dated[2]) - 1, Number(dated[3])) - 8 * 3600_000;
    if (!Number.isFinite(start) || start > now + 86_400_000) return null;
    return {minHours: Math.max(0, (now - start - 86_400_000) / 3600_000), maxHours: (now - start) / 3600_000, precision: 'day'};
  }
  return null;
}
const looksLikeTime = text => parseTimeLabel(text) !== null;

/** Card key for this task: same author and snippet → same card across screenshots (fuzzy match is separate). */
export function cardKey(card) {
  return createHash('sha256').update(JSON.stringify([comparable(card.author), comparable(card.snippet)])).digest('hex');
}

function splitAuthorTime(rows) {
  // The author/time line can come back as one row ("宏星源俞姐…22小时…") or as two rows.
  const ordered = [...rows].sort((a, b) => a.x - b.x);
  const last = ordered.at(-1);
  if (!last) return {author: '', timeLabel: ''};
  if (ordered.length > 1 && looksLikeTime(last.text)) {
    return {author: ordered.slice(0, -1).map(row => row.text).join(''), timeLabel: last.text};
  }
  const joined = ordered.map(row => row.text).join('');
  const match = joined.match(/^(.*?)[.。…·\s]*((?:\d{1,4}\s*(?:分钟|小时|天|周|星期|个月|月|年))|刚刚|今天|昨天|前天|(?:\d{4}年)?\d{1,2}月\d{1,2}日)[^]*$/u);
  return match ? {author: match[1], timeLabel: match[2]} : {author: joined, timeLabel: ''};
}
// The avatar left of the name is sometimes read as a stray glyph or digit followed by a space.
const cleanAuthor = text => String(text).replace(/^[^\p{L}\p{N}]+/u, '').replace(/^[\p{N}\p{P}]\s+/u, '')
  .replace(FOLD, '').trim();

/**
 * Result cards fully visible on one results screenshot, in reading order. Each card carries its tap point on the
 * thumbnail (never on the text or the sound button), its duration anchor and the snippet/author/time lines.
 */
export function parseResultCards(rows, {now = Date.now()} = {}) {
  const anchors = rows.filter(row => DURATION.test(row.text.replace(/\s+/gu, '')) && row.y > RESULTS_TOP)
    .map(row => ({row, column: COLUMNS.findIndex(c => row.x >= c.x0 && row.x <= c.x0 + 80)}))
    .filter(entry => entry.column >= 0);
  const cards = [];
  for (const {row: anchor, column} of anchors) {
    const {x0, x1} = COLUMNS[column];
    const inColumn = row => row.x >= x0 && row.x < x1 && row !== anchor;
    const captionRows = rows.filter(row => inColumn(row) && row.y > anchor.y + 50 && row.y < anchor.y + 175 && row.x <= x0 + 70)
      .sort(byPosition);
    const metaRows = rows.filter(row => inColumn(row) && row.y >= anchor.y + 175 && row.y < anchor.y + 265);
    if (!captionRows.length || !metaRows.length || anchor.y + 265 > SCREEN.height) continue;
    const likeRow = rows.find(row => inColumn(row) && Math.abs(row.y - anchor.y) < 20 && row.x > x0 + 250);
    const {author, timeLabel} = splitAuthorTime(metaRows);
    const snippet = captionRows.map(row => row.text).join('');
    const tapY = Math.max(RESULTS_TOP + 60, anchor.y - 240);
    if (tapY >= anchor.y) continue;
    const card = {column, anchorY: anchor.y, snippet, author: cleanAuthor(author), timeLabel: timeLabel.trim(),
      likeLabel: likeRow ? (likeRow.text.match(/\d[\d.,万wW]*/u)?.[0] ?? '') : '',
      age: parseTimeLabel(timeLabel, now), tap: {x: Math.round((x0 + x1) / 2), y: tapY}};
    card.cardKey = cardKey(card);
    cards.push(card);
  }
  // One card row: the two duration anchors of a row can differ by a few pixels.
  return cards.sort((a, b) => (Math.abs(a.anchorY - b.anchorY) < 40 ? 0 : a.anchorY - b.anchorY) || a.column - b.column);
}

/** True when a card is the same work as one already seen (OCR differs slightly between screenshots). */
export function sameCard(a, b) {
  if (a.cardKey === b.cardKey) return true;
  const authors = comparable(a.author), other = comparable(b.author);
  const authorsAgree = authors && other && (authors.startsWith(other) || other.startsWith(authors) || similarity(authors, other) >= 0.6);
  return authorsAgree && similarity(a.snippet, b.snippet) >= 0.75;
}

// Letters and digits only, for comparing text that OCR may punctuate or cut differently.
const bareText = value => comparable(value).replace(/[^\p{L}\p{N}]/gu, '');
// The search box shows about 14 characters: a longer keyword (a patrol caption start) reads back as its beginning,
// e.g. 「忍无可忍，无须再忍！凯迪拉克/」 for a 20-character query (2026-11-06). At least 8 shown characters must match.
const BOX_PREFIX_MIN = 8;
function boxShows(text, keyword) {
  if (comparable(text) === comparable(keyword)) return true;
  const shown = bareText(text), goal = bareText(keyword);
  return shown.length >= BOX_PREFIX_MIN && shown.length < goal.length && goal.startsWith(shown);
}

export function isResultsPage(rows, keyword) {
  const box = rows.some(row => row.y < 230 && row.x < 700 && boxShows(row.text, keyword));
  const tabs = rows.some(row => row.y > 230 && row.y < 360 && /视频/u.test(row.text));
  return box && tabs;
}
