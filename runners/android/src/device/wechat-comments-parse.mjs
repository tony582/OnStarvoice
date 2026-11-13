import {COMMENT_INPUT_TOP, COMMENT_REPLY_BODY_X, comparable, similarity} from './wechat-ocr-parse.mjs';

// Reads the WeChat 8.0.80 comment panel from recognized text rows (DE106, 1080 px wide, measured 2026-11-05):
// header "评论 N" near y 664; the post's own author row (with 作者) and caption; then per comment a line
// "昵称 [地区] 时间" at x≈149 (replies indented to x≈210–240), its text lines below, and its like count at the right.
export const PANEL_TOP = 640;
const TOP_LEVEL_X = [120, 185];
const REPLY_X = [186, 320];
const LIKE_X = 860;
const TIME_AT_END = /^(.*?)[\s.。…·]*((?:\d{1,4}\s*(?:分钟|小时|天|周|星期|个月|年)前)|刚刚|昨天|前天|(?:\d{4}年)?\d{1,2}月\d{1,2}日|\d{1,2}-\d{1,2})$/u;
const COMMENT_BADGES = /已?帮作者上热门|作者(?:赞|回复)过|置顶|热评/gu;
const NOISE_PREFIX = /^[^\p{L}\p{N}]+/u;
// "4条回复～"; OCR sometimes reads 复 or the arrow as く/～, so only the number and 条回 are required.
const REPLIES = /^(?:展开)?(\d{1,4})\s*条回/u;
const REPLIES_TAIL = /\s*(?:展开)?\d{1,4}\s*条回\S{0,2}$/u;
// A highlighted search term in a comment carries a small magnifier/link icon that OCR reads as "Q" or "°"
// right after the term ("OTAQ算是", "NVH°功底"); a model name like "Q5" or "25°C" is left alone.
const TERM_ICON = /(?<=[\p{Script=Han}A-Za-z])(?:Q(?=[\p{Script=Han}，。！？、+\s]|$)|°(?![CF]))/gu;
export const cleanCommentText = text => String(text).replace(TERM_ICON, '').trim();
const cleanCapturedComment = text => cleanCommentText(String(text ?? '').replace(REPLIES_TAIL, '').replace(/首评$/u, '')).replace(TRAILING_GLYPH, '').trim();
// An image or sticker comment has its header line and no text under it. A text line starts ~60 px below its header;
// the image comment measured on 2026-11-06 left 400 px before the next row. Such a comment is kept as 「[图片]」.
export const IMAGE_COMMENT = '[图片]';
const IMAGE_GAP = 200;
// The IP regions WeChat shows after a commenter's name (provinces and regions; longest first so 黑龙江 wins over 龙江).
const REGIONS = ['内蒙古', '黑龙江', '北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '江苏', '浙江', '安徽', '福建', '江西',
  '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '广西', '西藏', '宁夏', '新疆', '香港', '澳门'];
// Labels on their own line, never part of a comment: 「首评」 (first comment) and friends sit under the text.
const LABEL = /^(?:首评|作者赞过|作者回复过|置顶|热评)$/u;
const LABEL_BELOW = new Set(['首评', '作者赞过', '作者回复过']);
// A sticker at the end of a line comes back as a lone bracket or @; a real comment does not end that way.
const TRAILING_GLYPH = /[（(@]$/u;

function header(row) {
  const text = row.text.normalize('NFKC').trim();
  const match = text.match(TIME_AT_END);
  if (!match || !match[1].trim()) return null;
  const byline = match[1].replace(COMMENT_BADGES, ' ');
  const tokens = byline.replace(/作者/gu, ' ').replace(NOISE_PREFIX, '').trim().split(/\s+/u).filter(Boolean);
  if (!tokens.length) return null;
  let location = '';
  if (tokens.length > 1 && /^[一-龥]{2,3}$/u.test(tokens.at(-1))) location = tokens.pop();
  else {
    // OCR sometimes runs the IP region into the name: 「哟改名字了997200四川」, 「凌晨三点…山东」 (2026-11-06).
    const last = tokens.at(-1);
    const region = REGIONS.find(name => last.length > name.length && last.endsWith(name));
    if (region) { location = region; tokens[tokens.length - 1] = last.slice(0, -region.length); }
  }
  // Verified/medal glyphs after a name come back as symbols (∞, ♥, V).
  const author = tokens.join(' ').replace(/[\s.。…·•∞♥♡❤✓√()（）°]+0*$/u, '').replace(/\s+0+$/u, '').trim();
  return author ? {author, location, timeLabel: match[2].replace(/\s+/gu, ''), postAuthor: byline.includes('作者')} : null;
}

const number = text => {
  const match = String(text).match(/(\d+(?:\.\d+)?)\s*(万|w|W)?/u);
  if (!match) return null;
  return Math.round(Number(match[1]) * (match[2] ? 10_000 : 1));
};

/**
 * The bylines also provide scroll anchors when a comment body is cut off.
 */
export function parseCommentScreen(rows, {bottom = COMMENT_INPUT_TOP} = {}) {
  const visible = rows.filter(row => {
    const gap = bottom - row.y - row.h;
    // A cropped byline at the bottom can otherwise be mistaken for the previous comment's body.
    return row.y >= PANEL_TOP - 20 && gap >= 0 && (row.h >= 35 || gap > 12);
  }).sort((a, b) => a.y - b.y || a.x - b.x);
  const title = visible.find(row => row.y < PANEL_TOP + 60 && /^评论/u.test(row.text.replace(/\s+/gu, '')));
  const headerCount = title ? number(title.text.replace(/^评论/u, '')) : null;
  const comments = [], expand = [];
  // An ad card in the list carries a 「广告」 mark at the right of its title line; nothing in it is a comment.
  const adLines = visible.filter(row => row.x >= 800 && /^广告/u.test(row.text.replace(/\s+/gu, ''))).map(row => row.y);
  let post = null, current = null, captionOpen = false, inAd = false;
  for (const row of visible) {
    if (row === title || row.y < PANEL_TOP + 60) continue;
    if (adLines.some(y => Math.abs(row.y - y) < 40)) { current = null; captionOpen = false; inAd = true; continue; }
    const inTop = row.x >= TOP_LEVEL_X[0] && row.x <= TOP_LEVEL_X[1];
    const inReply = row.x >= REPLY_X[0] && row.x <= REPLY_X[1];
    // 「首评」 and similar labels close the comment above them: whatever follows (often an ad) is not its text.
    const label = row.text.replace(/\s+/gu, '').match(LABEL);
    if (label) { if (LABEL_BELOW.has(label[0])) current = null; continue; }
    if (row.x >= LIKE_X) {
      if (current && Math.abs(row.y - current.headerY) < 30 && current.likeCount === null) current.likeCount = number(row.text);
      continue;
    }
    const replies = row.text.replace(/\s+/gu, '').match(REPLIES);
    if (replies && (inTop || inReply)) {
      expand.push({count: Number(replies[1]), tap: {x: row.x + Math.round(row.w / 2), y: row.y + Math.round(row.h / 2)},
        parent: current && !current.reply ? current.key : null});
      current = null; captionOpen = false;
      continue;
    }
    const head = (inTop || inReply) ? header(row) : null;
    if (head) inAd = false;
    else if (inAd) continue;
    if (head) {
      const {postAuthor, ...byline} = head;
      if (postAuthor && inTop && !post && !comments.length) {
        post = {...byline, caption: ''}; captionOpen = true; current = null;
        continue;
      }
      current = {...byline, content: '', likeCount: null, reply: inReply, headerY: row.y, lastY: row.y};
      current.key = `${comparable(byline.author)}@${row.y}`;
      comments.push(current); captionOpen = false;
      continue;
    }
    if (captionOpen && post && inTop) {
      if (/^[♪◎♫]|上热门|人帮过/u.test(row.text)) { captionOpen = false; continue; }
      post.caption += row.text; continue;
    }
    if (current && row.x >= TOP_LEVEL_X[0] && row.y - current.lastY < 140) {
      // OCR can merge a reply avatar into its byline. The first body row supplies the indentation.
      if (!current.content) current.reply = row.x >= COMMENT_REPLY_BODY_X;
      current.content += row.text; current.lastY = row.y;
    }
  }
  // A header near the bottom with no text yet is left for the next screen; only a clear gap below means an image.
  const nextRowY = y => visible.find(row => row.y > y + 20 && row.x < LIKE_X)?.y ?? bottom;
  for (const item of comments) {
    if (!item.content.trim() && nextRowY(item.headerY) - item.headerY >= IMAGE_GAP) item.content = IMAGE_COMMENT;
  }
  const last = comments.at(-1);
  const anchors = comments.map(({author, timeLabel}) => ({author, timeLabel}));
  return {headerCount, post, expand, anchors, comments: comments.map(({key: _key, headerY: _y, lastY, ...item}) => ({...item,
      content: cleanCapturedComment(item.content),
      cut: bottom - lastY < 130 && item === last})).filter(item => item.content),
  bottomCut: !!last && bottom - last.lastY < 130};
}

// Letters and digits only: the same comment read twice differs in punctuation, a badge or a sticker glyph.
const bareText = value => comparable(value).replace(/[^\p{L}\p{N}]/gu, '');
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
/** Two readings of one commenter: a medal or emoji after the name can come back as one more or one other character. */
export function namesAgree(a, b) {
  const x = bareText(a), y = bareText(b);
  if (x === y) return Boolean(x);
  const shorter = Math.min(x.length, y.length);
  return shorter >= 3 && Math.abs(x.length - y.length) <= 1 && commonPrefix(x, y) >= shorter - 1;
}
/** Two readings of one comment text: cut short, a sticker read as a character, a small OCR slip. */
export function textsAgree(a, b, {aCut = false, bCut = false} = {}) {
  const x = bareText(a), y = bareText(b);
  if (!x || !y) { const original=comparable(a); return Boolean(original) && original===comparable(b); }
  if (x === y) return true;
  const [short, long, cut] = x.length <= y.length ? [x, y, aCut] : [y, x, bCut];
  if (short.length < long.length && short.length >= 4 && long.startsWith(short.slice(0, -1))) return cut === true;
  return similarity(x, y) >= 0.8;
}
export const sameComment = (a, b) => namesAgree(a.author, b.author) && textsAgree(a.content, b.content, {aCut:a.cut,bCut:b.cut});

function withinTwoEdits(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  // Only the diagonal band can lead to a distance of two or less.
  let previous = new Map([[0, 0], [1, 1], [2, 2]]);
  for (let i = 1; i <= a.length; i++) {
    const current = new Map();
    for (let j = Math.max(0, i - 2); j <= Math.min(b.length, i + 2); j++) {
      current.set(j, j === 0 ? i : Math.min((previous.get(j) ?? 3) + 1, (current.get(j - 1) ?? 3) + 1,
        (previous.get(j - 1) ?? 3) + Number(a[i - 1] !== b[j - 1])));
    }
    if ([...current.values()].every(cost => cost > 2)) return false;
    previous = current;
  }
  return previous.get(b.length) <= 2;
}

const withoutBadge = name => name.replace(/(?:[凶∞]+0{0,2}|0{1,2})$/u, '');
function adjacentNamesAgree(a, b) {
  const left = comparable(a), right = comparable(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const leftName = withoutBadge(left), rightName = withoutBadge(right);
  return leftName === right || rightName === left || Boolean(leftName && leftName === rightName);
}

function adjacentOcrVariant(a, b) {
  if (!a.location || !a.timeLabel || a.location !== b.location || a.timeLabel !== b.timeLabel
    || !adjacentNamesAgree(a.author, b.author)) return false;
  const x = bareText(a.content), y = bareText(b.content);
  // Tiny comments need stronger evidence than an edit allowance of two characters.
  return similarity(x, y) >= 0.8 || (Math.min(x.length, y.length) >= 5 && withinTwoEdits(x, y));
}

/**
 * Merge screens in scroll order. Overlapping comments (same commenter, same text as far as OCR lets us tell) are
 * kept once; a cut comment is replaced by its longer, later reading. Replies point at the index of their top-level comment.
 */
export function mergeCommentScreens(screens, {limit = Infinity} = {}) {
  const merged = [];
  let parentIndex = null, previous = new Map();
  for (const screen of screens) {
    const current = new Map();
    const items = screen.comments.map(raw => ({...raw, content: cleanCapturedComment(raw.content)})).filter(item => item.content);
    for (const item of items) {
      const floor=item.reply ? parentIndex : null;
      let existing = merged.findIndex(seen => Boolean(seen.reply)===Boolean(item.reply)
        && (!item.reply || (floor !== null && seen.parentIndex===floor)) && sameComment(seen, item));
      if (existing < 0 && !item.reply) {
        const match = [...previous].find(([index, before]) => !before.reply && !current.has(index) && adjacentOcrVariant(before, item)
          && !items.some(other => other !== item && !other.reply && sameComment(before, other)));
        if (match) existing = match[0];
      }
      if (existing >= 0) {
        const seen = merged[existing];
        if (comparable(item.content).length > comparable(seen.content).length) Object.assign(seen, {content: item.content, cut: item.cut});
        if (seen.likeCount === null && item.likeCount !== null) seen.likeCount = item.likeCount;
        current.set(existing, item);
        if (!item.reply) parentIndex = existing;
        continue;
      }
      if (merged.length >= limit) { if (!item.reply) parentIndex=null; continue; }
      const entry = {author: item.author, location: item.location, timeLabel: item.timeLabel, content: item.content,
        likeCount: item.likeCount, reply: item.reply, parentIndex: item.reply ? parentIndex : null, cut: item.cut};
      current.set(merged.length, item);
      merged.push(entry);
      if (!item.reply) parentIndex = merged.length - 1;
    }
    previous = current;
  }
  return merged.map(({cut: _cut, ...item}) => item);
}
