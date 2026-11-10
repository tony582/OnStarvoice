import {comparable, similarity} from './wechat-ocr-parse.mjs';
import {footerEvidence, position} from './wechat-article-parse.mjs';
const REGIONS = '内蒙古 黑龙江 新疆 西藏 宁夏 广西 香港 澳门 北京 天津 上海 重庆 河北 河南 云南 辽宁 湖南 安徽 山东 江苏 浙江 江西 湖北 甘肃 山西 陕西 吉林 福建 贵州 广东 青海 四川 海南 台湾'.split(' ');
const TIME = /((?:\d{4}年)?\d{1,2}月\d{1,2}日|\d{1,2}-\d{1,2}|\d+(?:分钟|小时|天|周|个月)前?|昨天|前天|刚刚)\s*$/u;
const CLOSED = /^(?:作者已关闭留言|该文章已关闭留言|留言功能已关闭|评论已关闭|暂不开放留言)$/u;
const IGNORE = /^(?:回复[凸赞]*\s*\d*|首评|作者赞过|作者回复过|精选留言|写留言|暂无留言|暂无评论|展开.*回复|共\d+条回复)$/u;
export function parseArticleComments(rows, {reachedEnd = false} = {}) {
  const footer = footerEvidence(rows);
  const from = footer.header?.y ?? footer.read?.y ?? (reachedEnd ? 205 : Infinity);
  const relevant = rows.filter(row => row.y >= from && row.y + row.h < 1900).sort(position);
  const closed = relevant.some(row => row.x < 200 && CLOSED.test(row.text.trim()));
  const restricted = relevant.some(row => row.x < 200 && /^作者已设置关注后可以留言$/u.test(row.text.trim()));
  const open = relevant.some(row => row.x < 200 && /^写留言$/u.test(row.text.trim()));
  const count = footer.header?.text.match(/\d+/u);
  const headers = [], uncertainBoundaries = []; let unparsed = false;
  for (const row of relevant) {
    if (row.x < 140 || row.x > 430 || row.h > 75) continue;
    const date = row.text.match(TIME);
    if (!date) {
      if (REGIONS.some(region => row.text.includes(region)) && /\d{1,2}月\d{1,2}[日口ロ号]?$/u.test(row.text.trim())) {
        uncertainBoundaries.push(row.y); unparsed = true;
      }
      continue;
    }
    const prefix = row.text.slice(0, date.index).trim();
    const location = REGIONS.find(region => prefix.endsWith(region)) ?? null;
    const replyControl = relevant.some(other => other.x > 800 && Math.abs(other.y - row.y) < 55 && /^回复/u.test(other.text));
    // Foreign/hidden IP locations cannot be split reliably from a display name using OCR alone. Preserve
    // the visible byline and text when the adjacent reply control proves a comment; mark coverage partial.
    if (!location) { unparsed = true; if (!replyControl) continue; }
    const author = location ? prefix.slice(0, -location.length).trim() : prefix;
    if (!author || author.length > 60) { unparsed = true; continue; }
    headers.push({...row, author, location, timeLabel: date[1], reply: row.x >= 225});
  }
  // The centered invitation is a system empty state only in the observed comment area, not a comment
  // containing those words. Keep normal comment text intact and never override an observed nonzero count.
  const emptyPrompt = !headers.length && !unparsed && !(Number(count?.[0]) > 0) && footer.header && (open || restricted)
    && relevant.find(row => Math.abs(row.x + row.w / 2 - 540) < 140 && row.h <= 60
      && /^还没有留言(?:[，,]?\s*来写首评)?$/u.test(row.text.trim()));
  const empty = !!emptyPrompt || relevant.some(row => row.x < 200 && /^(暂无留言|暂无评论)$/u.test(row.text.trim()));
  const expand = relevant.filter(row => row.x >= 145 && row.x < 800 && row.y < 1980
    && /^(?:展开(?:全部)?\s*\d*\s*条?回复|共\s*\d+\s*条回复)$/u.test(row.text.trim()))
    .map(row => {
      const parent = headers.filter(header => header.y < row.y).at(-1);
      return parent ? {key: `${parent.author}|${parent.timeLabel}|${row.text}`,
        tap: {x: Math.round(row.x + row.w / 2), y: Math.round(row.y + row.h / 2)}} : null;
    }).filter(Boolean);
  const comments = headers.map((row, index) => {
    const next = Math.min(headers[index + 1]?.y ?? 1900, ...uncertainBoundaries.filter(y => y > row.y));
    const lines = relevant.filter(item => item.y > row.y + row.h - 10 && item.y < next - 5 && item.x >= row.x - 25
      && item.x < 850 && !IGNORE.test(item.text.trim()) && !/^•/u.test(item.text.trim())
      && !/^(作者已设置|留言\d|展开\d)/u.test(item.text.trim()));
    const last = lines.at(-1);
    const cut = uncertainBoundaries.includes(next) || next === 1900 && (row.y > 1700 || (last?.y ?? 0) + (last?.h ?? 0) > 1800);
    const likes = relevant.find(item => Math.abs(item.y - row.y) < 40 && item.x > 940 && /^\d+$/u.test(item.text));
    return {author: row.author, location: row.location, timeLabel: row.timeLabel,
      content: lines.map(item => item.text).join(''), likeCount: likes ? Number(likes.text) : null, reply: row.reply, cut};
  }).filter(item => item.content);
  return {comments, unparsed, expand, headerCount: count ? Number(count[0]) : empty ? 0 : null, empty,
    postingState: closed ? 'closed' : restricted ? 'followers_only' : open || emptyPrompt ? 'open' : 'unknown', closed,
    entrySeen: !!footer.header || closed || restricted || open || empty,
    bottomCut: comments.some(item => item.cut),
    unexpanded: relevant.some(row => /^(?:展开.*回复|共\d+条回复)$/u.test(row.text.trim()))};
}
export function mergeArticleComments(existing, incoming, limit = 500) {
  const output = existing.map(item => ({...item}));
  for (const item of incoming) {
    const index = output.findIndex(old => old.reply === item.reply && comparable(old.author) === comparable(item.author)
      && old.timeLabel === item.timeLabel && (similarity(old.content, item.content) >= 0.7 || comparable(old.content).includes(comparable(item.content))
        || comparable(item.content).includes(comparable(old.content))));
    if (index >= 0) {
      const previous = output[index];
      if ((previous.cut && !item.cut) || (item.cut === previous.cut && item.content.length > previous.content.length)) output[index] = {...previous, ...item};
      else if (!item.cut) output[index].cut = false;
    } else if (output.length < limit) {
      const parentIndex = item.reply ? output.findLastIndex(old => !old.reply) : null;
      output.push({...item, parentIndex: parentIndex >= 0 ? parentIndex : null});
    }
  }
  return output;
}
