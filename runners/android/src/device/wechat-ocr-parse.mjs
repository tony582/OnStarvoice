import {createHash} from 'node:crypto';
import {comparable, similarity} from '../shared/wechat-text-match.mjs';
export {comparable, similarity} from '../shared/wechat-text-match.mjs';

// Pure readers of recognized text rows ({text, conf, x, y, w, h} in screenshot pixels) for WeChat 8.0.80 on the
// calibrated 1080x2242 DE106 screen. Nothing here touches the phone.

export const SCREEN = Object.freeze({width: 1080, height: 2242});
// Two result columns (measured on DE106): captions start near the edge, names follow the avatar.
const COLUMNS = Object.freeze([{x0: 18, x1: 531}, {x0: 548, x1: 1061}]);
// Below the search box, tabs and sort row nothing on the results page is a card.
export const RESULTS_TOP = 480;
// The comment input box at the bottom of the panel; no tap may land here.
export const COMMENT_INPUT_TOP = 2100;
export const COMMENT_REPLY_BODY_X = 200;

const DURATION = /^(?:\d{1,2}[:：-]\d{2}(?:[:：]\d{2})?|00)$/u;
const FOLD = /[.。…·•]+$/u;
const center = row => ({x: row.x + Math.round(row.w / 2), y: row.y + Math.round(row.h / 2)});
const byPosition = (a, b) => a.y - b.y || a.x - b.x;

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
  const match = joined.match(/^(.*?)[.。…·\s]*((?:\d{1,4}\s*(?:分钟|小时|天|周|星期|个月|月|年)(?:\s*前)?)|刚刚|今天|昨天|前天|(?:\d{4}年)?\d{1,2}月\d{1,2}日)[^]*$/u);
  return match ? {author: match[1], timeLabel: match[2]} : {author: joined, timeLabel: ''};
}
// The avatar left of the name is sometimes read as a stray glyph or digit followed by a space.
const cleanAuthor = text => String(text).replace(/^[^\p{L}\p{N}]+/u, '').replace(/^[\p{N}\p{P}]\s+/u, '')
  .replace(FOLD, '').trim();

/**
 * Result cards in reading order. The author/time row and caption locate a card; a washed-out duration cannot
 * hide it. Duration is optional supporting evidence, never a second source of cards. Screen-bottom cards wait
 * until their author row is fully visible after a scroll.
 */
export function parseResultCards(rows, {now = Date.now()} = {}) {
  const cards = [];
  for (const [column, {x0, x1}] of COLUMNS.entries()) {
    const inColumn = row => row.x >= x0 && row.x < x1;
    const visible = rows.filter(row => inColumn(row) && row.y > RESULTS_TOP && row.y + row.h <= SCREEN.height);
    const candidates = visible.filter(row => row.x <= x0 + 110 && row.h >= 25 && row.h <= 56).sort(byPosition);
    const metadataYs = [];
    for (const candidate of candidates) {
      if (metadataYs.some(y => Math.abs(y - candidate.y) < 20)
        || /^\d{1,2}[:：-]\d{2}/u.test(candidate.text.trim())) continue;
      // Keep an avatar glyph to the left out of a name that has its own OCR box.
      const metaRows = visible.filter(row => row.x >= candidate.x - 5 && Math.abs(row.y - candidate.y) < 20
        && row.h >= 25 && row.h <= 60);
      const {author, timeLabel} = splitAuthorTime(metaRows);
      const name = cleanAuthor(author);
      if (!name || !/[\p{L}\p{N}]/u.test(name)) continue;
      // A merged name/time can start at the column edge. A name without readable time needs the avatar indent.
      if (!timeLabel && candidate.x < x0 + 55) continue;
      const captionRows = visible.filter(row => row.x <= x0 + 70 && row.y >= candidate.y - 150
        && row.y <= candidate.y - 55 && row.h >= 25 && row.h <= 70).sort(byPosition);
      if (!captionRows.length) continue;
      const duration = visible.filter(row => row.x <= x0 + 80 && row.y >= candidate.y - 265
        && row.y <= candidate.y - 160 && DURATION.test(row.text.replace(/\s+/gu, '')))
        .sort((a, b) => Math.abs(candidate.y - a.y - 200) - Math.abs(candidate.y - b.y - 200))[0];
      const anchorY = duration?.y ?? candidate.y - 185;
      const likeRow = duration && visible.find(row => Math.abs(row.y - duration.y) < 20 && row.x > x0 + 250);
      const tapY = Math.max(RESULTS_TOP + 60, candidate.y - 420);
      if (tapY >= anchorY || tapY >= captionRows[0].y) continue;
      const card = {column, anchorY, metadataY: candidate.y, durationLabel: duration?.text.trim() ?? '',
        snippet: captionRows.map(row => row.text).join(''), author: name, timeLabel: timeLabel.trim(),
        likeLabel: likeRow ? (likeRow.text.match(/\d[\d.,万wW]*/u)?.[0] ?? '') : '',
        age: parseTimeLabel(timeLabel, now), tap: {x: Math.round((x0 + x1) / 2), y: tapY}};
      card.cardKey = cardKey(card);
      cards.push(card);
      metadataYs.push(candidate.y);
    }
  }
  // Names on the same two-column card row can differ by a few pixels.
  return cards.sort((a, b) => (Math.abs(a.metadataY - b.metadataY) < 40 ? 0 : a.metadataY - b.metadataY) || a.column - b.column);
}

/** True when a card is the same work as one already seen (OCR differs slightly between screenshots). */
export function sameCard(a, b) {
  if (a.cardKey === b.cardKey) return true;
  const authors = comparable(a.author), other = comparable(b.author);
  const authorsAgree = authors && other && (authors.startsWith(other) || other.startsWith(authors) || similarity(authors, other) >= 0.6);
  return authorsAgree && similarity(a.snippet, b.snippet) >= 0.75;
}

/**
 * Where to tap 评论 on a work page, from a screenshot of its lower part. The bar's counts (喜欢 转发 推荐 评论) are read
 * under their icons; the comment icon sits 65 px above the rightmost count (measured 2026-11-06: counts at y 2131 → icon
 * 2085; with the 「↑更多视频」 strip counts at y 1951). No count read: shifted by the strip if it is there, else `fallback`.
 */
export function commentButton(rows, {fallback, shift}) {
  const counts = rows.filter(row => row.x >= 700 && row.y >= 1700 && row.y <= 2200
    && /^(?:\d+(?:\.\d+)?万?|评论)$/u.test(String(row.text).normalize('NFKC').replace(/\s+/gu, '')));
  const rightmost = counts.sort((a, b) => b.x - a.x)[0];
  if (rightmost) return {x: fallback.x, y: rightmost.y + Math.round(rightmost.h / 2) - 65, from: 'counts'};
  const strip = rows.some(row => row.y >= 1950 && /更多视频/u.test(row.text));
  return strip ? {x: fallback.x, y: fallback.y - shift, from: 'more_videos'} : {...fallback, from: 'fixed'};
}

const dashed = value => comparable(value).replace(/[–—－~～]/gu, '-').replace(/-+$/u, '');
/**
 * The 时长 or 范围 button in the filter row (`filter` from SEARCH_FILTERS): its own label, or the option it shows once one
 * was picked ("5分钟以下～"). `shows` is that option's key, or 'all' while the button still reads its own label.
 */
export function filterButton(rows, filter) {
  const inRow = rows.filter(row => row.y >= 370 && row.y <= 490 && row.x >= 480).sort(byPosition);
  for (const row of inRow) {
    const text = dashed(row.text);
    const shown = Object.entries(filter.options).find(([, label]) => text.includes(dashed(label)));
    if (shown || text.includes(comparable(filter.button))) return {...row, center: center(row), shows: shown ? shown[0] : 'all'};
  }
  return null;
}
/** One option in the open bottom sheet of `filter`; null unless the sheet's own title is there too. */
export function sheetOption(rows, filter, key) {
  const label = filter.options[key];
  if (!label || !findText(rows, filter.button, {region: {y0: 1650, y1: 1850}}).length) return null;
  const goal = dashed(label);
  const option = rows.filter(row => row.y >= 1820 && dashed(row.text) === goal).sort(byPosition)[0];
  return option ? {...option, center: center(option)} : null;
}

// 转发给朋友 (2026-11-09, 8.0.80): share sheet → 选择聊天 picker → 「发送给：…」 sheet → toast 「已发送」.
/** 转发给朋友 on the share sheet's first row; the tap goes on its icon, just above the label. */
export function forwardEntry(rows) {
  const label = findText(rows, '转发给朋友', {region: {y0: 1500, y1: 1800, x1: 300}})[0];
  return label ? {x: label.center.x, y: label.y - 40} : null;
}
/** The picker's search field (「Q 搜索」 under the title). */
export function pickerSearch(rows) {
  return findText(rows, '搜索', {region: {y0: 200, y1: 340, x1: 600}, exact: false})[0] ?? null;
}
/** A contact or chat row whose name is exactly `name`, below the search field (which echoes the typed name). */
export function pickerMatch(rows, name) {
  const goal = comparable(name);
  const row = rows.filter(r => r.y >= 360 && r.y < COMMENT_INPUT_TOP && comparable(r.text) === goal).sort(byPosition)[0];
  return row ? {...row, center: center(row)} : null;
}
/** The confirmation sheet: 「发送给：」, the recipient's name right under it, and its 发送 / 取消 buttons. */
export function sendConfirmation(rows, name) {
  const title = rows.find(r => /^发送给/u.test(String(r.text).normalize('NFKC').trim()));
  const goal = comparable(name);
  const named = Boolean(title) && rows.some(r => r.y > title.y && r.y < title.y + 260 && comparable(r.text) === goal);
  const send = findText(rows, '发送', {region: {y0: 1800, y1: 2200, x0: 540}})[0] ?? null;
  const cancel = findText(rows, '取消', {region: {y0: 1800, y1: 2200, x1: 540}})[0] ?? null;
  return {confirmed: Boolean(title && named && send), send, cancel};
}
export const forwardToastSeen = rows => rows.some(r => /已发送/u.test(r.text));

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
