import {COMMENT_INPUT_TOP, comparable, similarity} from './wechat-ocr-parse.mjs';

// Reads the WeChat 8.0.80 comment panel from recognized text rows (DE106, 1080 px wide, measured 2026-11-05):
// header "评论 N" near y 664; the post's own author row (with 作者) and caption; then per comment a line
// "昵称 [地区] 时间" at x≈149 (replies indented to x≈210–240), its text lines below, and its like count at the right.
export const PANEL_TOP = 640;
const TOP_LEVEL_X = [120, 185];
const REPLY_X = [186, 320];
const LIKE_X = 860;
const TIME_AT_END = /^(.*?)[\s.。…·]*((?:\d{1,4}\s*(?:分钟|小时|天|周|星期|个月|年)前)|刚刚|昨天|前天|(?:\d{4}年)?\d{1,2}月\d{1,2}日|\d{1,2}-\d{1,2})$/u;
const BADGES = /(已帮作者上热门|帮作者上热门|作者赞过|作者|置顶|热评)/gu;
const NOISE_PREFIX = /^[^\p{L}\p{N}]+/u;
// "4条回复～"; OCR sometimes reads 复 or the arrow as く/～, so only the number and 条回 are required.
const REPLIES = /^(?:展开)?(\d{1,4})\s*条回/u;
const REPLIES_TAIL = /\s*(?:展开)?\d{1,4}\s*条回\S{0,2}$/u;

function header(row) {
  const text = row.text.normalize('NFKC').trim();
  const match = text.match(TIME_AT_END);
  if (!match || !match[1].trim()) return null;
  const tokens = match[1].replace(BADGES, ' ').replace(NOISE_PREFIX, '').trim().split(/\s+/u).filter(Boolean);
  if (!tokens.length) return null;
  let location = '';
  if (tokens.length > 1 && /^[一-龥]{2,3}$/u.test(tokens.at(-1))) location = tokens.pop();
  // Verified/medal glyphs after a name come back as symbols (∞, ♥, V).
  const author = tokens.join(' ').replace(/[\s.。…·•∞♥♡❤✓√()（）]+0*$/u, '').replace(/\s+0+$/u, '').trim();
  return author ? {author, location, timeLabel: match[2].replace(/\s+/gu, '')} : null;
}

const number = text => {
  const match = String(text).match(/(\d+(?:\.\d+)?)\s*(万|w|W)?/u);
  if (!match) return null;
  return Math.round(Number(match[1]) * (match[2] ? 10_000 : 1));
};

/**
 * One screenshot of the open panel → {headerCount, post, comments, expand, bottomCut}. `expand` lists the
 * "N条回复" controls with their tap points; `bottomCut` is true when the last comment may continue below.
 */
export function parseCommentScreen(rows, {bottom = COMMENT_INPUT_TOP} = {}) {
  const visible = rows.filter(row => row.y >= PANEL_TOP - 20 && row.y + row.h <= bottom).sort((a, b) => a.y - b.y || a.x - b.x);
  const title = visible.find(row => row.y < PANEL_TOP + 60 && /^评论/u.test(row.text.replace(/\s+/gu, '')));
  const headerCount = title ? number(title.text.replace(/^评论/u, '')) : null;
  const comments = [], expand = [];
  let post = null, current = null, captionOpen = false;
  for (const row of visible) {
    if (row === title || row.y < PANEL_TOP + 60) continue;
    const inTop = row.x >= TOP_LEVEL_X[0] && row.x <= TOP_LEVEL_X[1];
    const inReply = row.x >= REPLY_X[0] && row.x <= REPLY_X[1];
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
    if (head && /作者/u.test(row.text) && !post) {
      post = {...head, caption: ''}; captionOpen = true; current = null;
      continue;
    }
    if (head) {
      current = {...head, content: '', likeCount: null, reply: inReply, headerY: row.y, lastY: row.y};
      current.key = `${comparable(head.author)}@${row.y}`;
      comments.push(current); captionOpen = false;
      continue;
    }
    if (captionOpen && post && inTop) {
      if (/^[♪◎♫]|上热门|人帮过/u.test(row.text)) { captionOpen = false; continue; }
      post.caption += row.text; continue;
    }
    if (current && (row.x >= (current.reply ? REPLY_X[0] : TOP_LEVEL_X[0])) && row.y - current.lastY < 140) {
      current.content += row.text; current.lastY = row.y;
    }
  }
  const last = comments.at(-1);
  return {headerCount, post, expand, comments: comments.filter(item => item.content.trim())
    .map(({key: _key, headerY: _y, lastY, ...item}) => ({...item, content: item.content.replace(REPLIES_TAIL, '').trim(),
      cut: bottom - lastY < 130 && item === last})),
  bottomCut: !!last && bottom - last.lastY < 130};
}

/**
 * Merge screens in scroll order. Overlapping comments (same author, near-identical text) are kept once; a cut
 * comment is replaced by its longer, later reading. Replies point at the index of their top-level comment.
 */
export function mergeCommentScreens(screens, {limit = Infinity} = {}) {
  const merged = [];
  let parentIndex = null;
  for (const screen of screens) {
    for (const item of screen.comments) {
      const author = comparable(item.author);
      const existing = merged.findIndex(seen => comparable(seen.author) === author
        && (similarity(seen.content, item.content) >= 0.85 || comparable(seen.content).startsWith(comparable(item.content))
          || comparable(item.content).startsWith(comparable(seen.content))));
      if (existing >= 0) {
        const seen = merged[existing];
        if (comparable(item.content).length > comparable(seen.content).length) Object.assign(seen, {content: item.content, cut: item.cut});
        if (seen.likeCount === null && item.likeCount !== null) seen.likeCount = item.likeCount;
        if (!item.reply) parentIndex = existing;
        continue;
      }
      if (merged.length >= limit) continue;
      const entry = {author: item.author, location: item.location, timeLabel: item.timeLabel, content: item.content,
        likeCount: item.likeCount, reply: item.reply, parentIndex: item.reply ? parentIndex : null, cut: item.cut};
      merged.push(entry);
      if (!item.reply) parentIndex = merged.length - 1;
    }
  }
  return merged.map(({cut: _cut, ...item}) => item);
}
