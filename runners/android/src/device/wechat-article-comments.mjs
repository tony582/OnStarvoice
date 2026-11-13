import {COMMENT_REPLY_BODY_X, comparable, similarity} from './wechat-ocr-parse.mjs';
import {footerEvidence, position} from './wechat-article-parse.mjs';
const REGIONS = '内蒙古 黑龙江 新疆 西藏 宁夏 广西 香港 澳门 北京 天津 上海 重庆 河北 河南 云南 辽宁 湖南 安徽 山东 江苏 浙江 江西 湖北 甘肃 山西 陕西 吉林 福建 贵州 广东 青海 四川 海南 台湾'.split(' ');
const TIME = /((?:\d{4}年)?\d{1,2}月\d{1,2}日|\d{1,2}-\d{1,2}|\d+(?:分钟|小时|天|周|个月)前?|昨天|前天|刚刚)\s*$/u;
const CLOSED = /^(?:作者已关闭留言|该文章已关闭留言|留言功能已关闭|评论已关闭|暂不开放留言)$/u;
const IGNORE = /^(?:回复[凸赞]*\s*\d*|首评|作者赞过|作者回复过|精选留言|写留言|暂无留言|暂无评论|展开.*回复|共\d+条回复)$/u;
const REPLY_X = 225;
function authorIdentity(author) {
  const value = String(author ?? '').trim();
  return !value || /^(?:总|[\p{P}\p{S}])$/u.test(value) ? {author: '', authorUncertain: true} : {author: value};
}
function validTime(value) {
  if (typeof value !== 'string' || value.match(TIME)?.[0] !== value) return false;
  const date = value.match(/^(?:(\d{4})年)?(\d{1,2})(?:月|-)(\d{1,2})日?$/u);
  if (!date) return true;
  const year = Number(date[1] ?? 2000), month = Number(date[2]), day = Number(date[3]);
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function sameComment(old, item) {
  if (old.reply !== item.reply || old.timeLabel !== item.timeLabel || !validTime(item.timeLabel)) return false;
  const oldRegion = REGIONS.includes(old.location), newRegion = REGIONS.includes(item.location);
  if (oldRegion && newRegion && old.location !== item.location) return false;
  const sameKnownAuthor = old.author && item.author && !old.authorUncertain && !item.authorUncertain
    && comparable(old.author) === comparable(item.author);
  // Hidden/foreign IP already used same-name matching. Cross-name evidence must have known equal regions.
  if (!sameKnownAuthor && !(oldRegion && newRegion && old.location === item.location)) return false;
  const before = comparable(old.content), after = comparable(item.content);
  return !!before && !!after && (similarity(before, after) >= (sameKnownAuthor ? 0.7 : 0.9)
    || before.includes(after) || after.includes(before));
}
const authorQuality = item => (item.author.match(/\p{Script=Han}/gu)?.length ?? 0) * 100 + (item.author ? 1 : 0);
export function parseArticleComments(rows, {reachedEnd = false, topLevelOnly = false} = {}) {
  const footer = footerEvidence(rows);
  const from = footer.header?.y ?? footer.read?.y ?? (reachedEnd ? 205 : Infinity);
  const relevant = rows.filter(row => row.y >= from && row.y + row.h < 1900).sort(position);
  const closed = relevant.some(row => row.x < 200 && CLOSED.test(row.text.trim()));
  const restricted = relevant.some(row => row.x < 200 && /^作者已设置关注后可以留言$/u.test(row.text.trim()));
  const open = relevant.some(row => row.x < 200 && /^写留言$/u.test(row.text.trim()));
  const count = footer.header?.text.match(/\d+/u);
  const headers = [], uncertainBoundaries = [];
  const inScope = reply => !topLevelOnly || !reply;
  // OCR sometimes drops 广's dot (厂告). The label and brand share a baseline; start at its upper edge,
  // not the label's y, so every ad line is excluded. Brand names in ordinary comments are never a signal.
  const adBoundaries = relevant.filter(row => row.x > 900 && row.w <= 180 && row.h <= 60 && /^[广厂]告[\p{P}\p{S}\s]*$/u.test(row.text.trim()))
    .map(marker => Math.min(marker.y, ...relevant.filter(row => row.x >= 140 && row.x < 850 && row.h <= 75
      && Math.abs(row.y + row.h / 2 - marker.y - marker.h / 2) <= 30).map(row => row.y)));
  for (const row of relevant) {
    if (row.x < 140 || row.x > 430 || row.h > 75) continue;
    const date = row.text.match(TIME);
    if (!date) {
      if (REGIONS.some(region => row.text.includes(region)) && /\d{1,2}月\d{1,2}[日口ロ号]?$/u.test(row.text.trim())) {
        uncertainBoundaries.push(row);
      }
      continue;
    }
    const prefix = row.text.slice(0, date.index).trim();
    const location = REGIONS.find(region => prefix.endsWith(region)) ?? null;
    const replyControl = relevant.some(other => other.x > 800 && Math.abs(other.y - row.y) < 55 && /^回复/u.test(other.text));
    // Foreign/hidden IP locations cannot be split reliably from a display name using OCR alone. Preserve
    // the visible byline and text when the adjacent reply control proves a comment; mark coverage partial.
    if (!location && !replyControl) { uncertainBoundaries.push(row); continue; }
    const author = location ? prefix.slice(0, -location.length).trim() : prefix;
    if (!author || author.length > 60) { uncertainBoundaries.push(row); continue; }
    const identity = authorIdentity(author);
    headers.push({...row, ...identity, location, timeLabel: date[1]});
  }
  const boundaries = [...headers.map(row => row.y), ...uncertainBoundaries.map(row => row.y), ...adBoundaries];
  const nextBoundary = row => Math.min(1900, ...boundaries.filter(y => y > row.y));
  const bodyLines = (row, next) => relevant.filter(item => item.y > row.y + row.h - 10 && item.y < next - 5
    && item.x >= 120 && item.x < 850 && !IGNORE.test(item.text.trim())
    && !/^(?:•|作者已设置|留言\d|展开\d)/u.test(item.text.trim()));
  const isReply = (row, first) => first && first.y - row.y < 140
    ? first.x >= COMMENT_REPLY_BODY_X : row.x >= REPLY_X;
  const uncertainTop = new Set(uncertainBoundaries.filter(row => inScope(isReply(row, bodyLines(row, nextBoundary(row))[0])))
    .map(row => row.y));
  let unparsed = uncertainTop.size > 0;
  const comments = headers.map(row => {
    const next = nextBoundary(row), lines = bodyLines(row, next);
    const reply = isReply(row, lines[0]);
    if (!row.location || row.authorUncertain) unparsed ||= inScope(reply);
    const last = lines.at(-1);
    const cut = uncertainTop.has(next) || next === 1900 && (row.y > 1700 || (last?.y ?? 0) + (last?.h ?? 0) > 1800);
    const likes = relevant.find(item => Math.abs(item.y - row.y) < 40 && item.x > 940 && /^\d+$/u.test(item.text));
    return {author: row.author, ...(row.authorUncertain ? {authorUncertain: true} : {}), location: row.location, timeLabel: row.timeLabel,
      content: lines.map(item => item.text).join(''), likeCount: likes ? Number(likes.text) : null, reply, cut};
  }).filter(item => item.content && inScope(item.reply));
  // The centered invitation is a system empty state only in the observed comment area, not a comment
  // containing those words. Keep normal comment text intact and never override an observed nonzero count.
  const emptyPrompt = !headers.length && !unparsed && !(Number(count?.[0]) > 0) && footer.header && (open || restricted)
    && relevant.find(row => Math.abs(row.x + row.w / 2 - 540) < 140 && row.h <= 60
      && /^还没有留言(?:[，,]?\s*来写首评)?$/u.test(row.text.trim()));
  const empty = !!emptyPrompt || relevant.some(row => row.x < 200 && /^(暂无留言|暂无评论)$/u.test(row.text.trim()));
  return {comments, unparsed, headerCount: count ? Number(count[0]) : empty ? 0 : null, empty,
    postingState: closed ? 'closed' : restricted ? 'followers_only' : open || emptyPrompt ? 'open' : 'unknown', closed,
    entrySeen: !!footer.header || closed || restricted || open || empty,
    bottomCut: comments.some(item => item.cut)};
}
export function mergeArticleComments(existing, incoming, limit = 500) {
  const normalizeAuthor = ({authorUncertain, ...item}) => ({...item, ...authorIdentity(authorUncertain === true ? '' : item.author)});
  const output = existing.map(normalizeAuthor);
  let parentIndex = output.findLastIndex(item => !item.reply);
  for (const incomingItem of incoming) {
    const item = normalizeAuthor(incomingItem);
    const index = output.findIndex(old => sameComment(old, item) && (!item.reply || old.parentIndex === (parentIndex >= 0 ? parentIndex : null)));
    if (!item.reply) parentIndex = index >= 0 ? index : output.length < limit ? output.length : -1;
    if (index >= 0) {
      const previous = output[index];
      const identity = authorIdentity((authorQuality(item) > authorQuality(previous) ? item : previous).author);
      if ((previous.cut && !item.cut) || (item.cut === previous.cut && item.content.length > previous.content.length)) output[index] = {...previous, ...item};
      else if (!item.cut) output[index].cut = false;
      delete output[index].authorUncertain;
      Object.assign(output[index], identity);
    } else if (output.length < limit) {
      output.push({...item, parentIndex: item.reply && parentIndex >= 0 ? parentIndex : null});
    }
  }
  return output;
}
