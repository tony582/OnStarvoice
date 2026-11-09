import {cardKey, comparable, findWord, parseTimeLabel, similarity} from './wechat-ocr-parse.mjs';

export const ARTICLE_ACTIVITY = 'com.tencent.mm.plugin.brandservice.ui.timeline.preload.ui.TmplWebViewMMUI';
export const ARTICLE_LINK_ACTIVITY = 'com.tencent.mm.plugin.webview.ui.tools.fts.MMSosWebViewUI';
export const ARTICLE_ACTIVITIES = Object.freeze([ARTICLE_ACTIVITY, ARTICLE_LINK_ACTIVITY]);
export const ARTICLE_SEARCH = 'com.tencent.mm.plugin.webview.ui.tools.fts.MMFTSSOSHomeWebViewUI';
export const ARTICLE_LANDING = 'com.tencent.mm.plugin.lite.ui.WxaLiteAppLiteUI';
export const ARTICLE_LINK = /^https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]{8,128}\/?(?:[?#][^\s]{0,1024})?$/u;
export const position = (a, b) => a.y - b.y || a.x - b.x;
const DATE = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*(\d{1,2})[:：](\d{2}))?/u;
const TIME = /(\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}|(?:\d{4}年)?\d{1,2}月\d{1,2}日|\d{1,4}(?:分钟|小时|天|周|个月|年)前?|今天|昨天|前天|刚刚)\s*$/u;
const LOCATIONS = '内蒙古 黑龙江 新疆 西藏 宁夏 广西 香港 澳门 北京 天津 上海 重庆 河北 河南 云南 辽宁 湖南 安徽 山东 江苏 浙江 江西 湖北 甘肃 山西 陕西 吉林 福建 贵州 广东 青海 四川 海南 台湾'.split(' ');
export function metric(raw, {read = false} = {}) {
  const text = String(raw ?? '').trim().replace(/^(?:阅读|赞|分享|推荐)\s*/u, '');
  const hit = text.match(/^(\d+(?:\.\d+)?)(万|亿)?(\+)?$/u);
  return {raw: text || null, value: hit ? Number(hit[1]) * ({万: 10000, 亿: 100000000}[hit[2]] ?? 1) : null,
    ...(read ? {precision: !hit ? 'unknown' : hit[3] ? 'lower_bound' : hit[2] ? 'rounded' : 'exact'} : {})};
}
export function articleSortTarget(rows, sort) {
  const label = {all: '不限', latest: '最新', hot: '最热'}[sort];
  return label ? findWord(rows.map(row => ({...row, text: row.text.replace(/[｜|]/gu, ' ')})), label,
    {region: {y0: 350, y1: 520}})[0] : null;
}
export function isArticleResults(rows, keyword, {controlledInput = false} = {}) {
  const wanted = comparable(keyword);
  const keywordSeen = rows.some(row => {
    if (!(row.y > 90 && row.y < 230 && row.x > 90 && row.x < 800)) return false;
    const shown = comparable(row.text); if (shown === wanted) return true;
    // Only the keyword just entered by this flow may use a physically truncated field. Its rendered width
    // must fill the input, and the query must be wider than that field; short terms still require exact text.
    const prefix = comparable(row.text.replace(/[Qq○◯°⌕…\/]+$/u, ''));
    const units = [...String(keyword)].reduce((sum, char) => sum + (/[^\x00-\x7f]/u.test(char) ? 1 : 0.55), 0);
    return controlledInput && row.w >= 400 && row.x + row.w >= 650 && prefix.length < wanted.length
      && units * row.h * 0.8 > 600 && wanted.startsWith(prefix);
  });
  return keywordSeen && !!findWord(rows, '文章', {region: {y0: 240, y1: 350}}).length && !!articleSortTarget(rows, 'all');
}
export function parseArticleCards(rows, {now = Date.now()} = {}) {
  const visible = rows.filter(row => row.y >= 520 && row.y + row.h < 2070).sort(position);
  const cards = []; let previousBottom = 510;
  for (const row of visible) {
    if (row.x < 220 || row.x > 500) continue;
    const time = row.text.match(TIME); if (!time) continue;
    const author = row.text.slice(0, time.index).trim().replace(/[·•]$/u, '').trim();
    if (!author || author.length > 60) continue;
    const block = visible.filter(item => item.y > previousBottom && item.y < row.y - 10);
    const summaryRows = block.filter(item => item.x >= 220 && item.x < 450 && item.h >= 35);
    const summaryTop = summaryRows[0]?.y ?? Infinity;
    let titleRows = block.filter(item => item.x < 150 && item.h >= 40 && item.y < summaryTop);
    // A previous card's thumbnail can extend below its account line; keep the final contiguous title block.
    for (let i = titleRows.length - 1; i > 0; i--) {
      if (titleRows[i].y - titleRows[i - 1].y > 115) { titleRows = titleRows.slice(i); break; }
    }
    if (!titleRows.length) { previousBottom = row.y + row.h; continue; }
    const title = titleRows.map(item => item.text).join('');
    const summary = summaryRows.map(item => item.text).join('');
    const card = {title, snippet: title, summary, author, account: author, timeLabel: time[1], age: parseTimeLabel(time[1], now),
      tap: {x: Math.round(Math.min(900, titleRows[0].x + titleRows[0].w / 2)), y: Math.round(titleRows[0].y + titleRows[0].h / 2)},
      anchorY: row.y, column: 0, contentType: 'article'};
    cards.push({...card, cardKey: cardKey(card)}); previousBottom = row.y + row.h;
  }
  return cards;
}
const HEADER_LOCATIONS = [...LOCATIONS, '美国', '英国', '日本', '韩国', '加拿大', '澳大利亚', '新加坡', '法国', '德国', '意大利', '新西兰', '马来西亚', '泰国', '越南', '印度', '俄罗斯'];
const validAccount = value => !!value && value.length <= 60 && !/[，,。；;！？!?：:]/u.test(value);
function publicationRow(row) {
  if (row.y < 350 || row.y >= 760 || row.x < 30 || row.x > 500 || row.h > 50) return null;
  const match = row.text.match(DATE); if (!match) return null;
  const account = row.text.slice(0, match.index).trim().replace(/^原创\s*/u, '');
  if (account && !validAccount(account)) return null;
  const trailing = row.text.slice(match.index + match[0].length).trim().replace(/\s*\d{0,3}\s*听全文$/u, '').trim();
  const location = HEADER_LOCATIONS.find(value => trailing === value) ?? null;
  // Publication metadata is a complete small-font row, never a date embedded in a sentence. A date-only
  // row additionally needs an observed location; a minute timestamp may omit the location.
  if ((trailing && !location) || (!match[4] && !location)) return null;
  const [, year, month, day, hour = '00', minute = '00'] = match;
  const date = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute));
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() + 1 !== +month || date.getUTCDate() !== +day
    || +hour > 23 || +minute > 59) return null;
  return {row, match, account, location};
}
export function parseArticleHeader(rows, {card = null} = {}) {
  const meta = rows.map(publicationRow).filter(Boolean).sort((a, b) => position(a.row, b.row))[0];
  const dated = meta?.row, match = meta?.match;
  let titleRows = rows.filter(row => row.y >= 245 && row.y + row.h < (dated?.y ?? 500) && row.h >= 49 && row.x >= 30 && row.x < 200
    && !/^原创\s/u.test(row.text)).sort(position);
  // On the verified profile, the title begins around y=277 and has a larger font than publication metadata.
  // A body paragraph at the top of a restored viewport is not a title merely because a date follows it.
  if (!titleRows.length || titleRows[0].y > 335 || titleRows[0].h < Math.max(55, (dated?.h ?? 40) + 8)
    || titleRows.some((row, index) => index > 0 && row.y - titleRows[index - 1].y > 120)) titleRows = [];
  const title = titleRows.map(row => row.text).join('') || card?.title || card?.snippet || '';
  const accountRows = rows.filter(row => row.y > (titleRows.at(-1)?.y ?? 230) && row.y < (dated?.y ?? 600)
    && (!dated || dated.y - row.y < 120) && row.h <= 48 && row.x >= 30 && row.x < 300).sort(position);
  let account = meta?.account ?? '';
  if (!account && dated) account = rows.filter(row => row !== dated && Math.abs(row.y - dated.y) < 18
    && row.h <= 50 && row.x >= 30 && row.x + row.w <= dated.x + 20).sort(position).map(row => row.text).join(' ').trim();
  if (!account && accountRows.length) account = accountRows.at(-1).text.replace(/^原创\s*/u, '').trim();
  const halves = account.match(/^(.+?)\s+\1$/u); if (halves) account = halves[1];
  const accountObserved = validAccount(account);
  if (!accountObserved) account = card?.account || card?.author || null;
  let publishedAt = null, timePrecision = 'unknown';
  if (match) {
    const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    timePrecision = match[4] ? 'minute' : 'date';
    publishedAt = match[4] ? `${date}T${match[4].padStart(2, '0')}:${match[5]}:00+08:00` : date;
  }
  return {title, account, author: account, publishedAt, timeLabel: match?.[0] ?? card?.timeLabel ?? null, timePrecision, location: meta?.location ?? null,
    contentType: card?.contentType === 'image' ? 'image' : 'article', source: 'screen_ocr',
    titleObserved: titleRows.length > 0, bodyTop: dated ? dated.y + dated.h + 30 : 540, headerVerified: !!meta && titleRows.length > 0 && accountObserved};
}
export function footerEvidence(rows) {
  const read = rows.find(row => row.x < 180 && row.y > 240 && row.y < 2050 && /^阅读\s*\d/u.test(row.text)
    && rows.some(other => other.x > 750 && Math.abs(other.y - row.y) < 70 && /不喜欢/u.test(other.text)));
  const header = rows.find(row => row.x < 130 && row.y > (read?.y ?? 240) && row.y < 2050 && /^留言\s*\d*$/u.test(row.text));
  return {read, header, bodyEndY: read?.y ?? null};
}
export function parseArticleMetrics(rows) {
  const read = footerEvidence(rows).read;
  const bar = rows.filter(row => row.y >= 2160 && row.y < 2220);
  const at = (x0, x1) => bar.find(row => row.x >= x0 && row.x < x1)?.text;
  // Verified four-icon bar; three-icon variant uses shifted slots, distinguished by the 分享 label.
  const three = bar.some(row => row.x >= 790 && row.x < 900 && /^分享/u.test(row.text));
  const four = bar.some(row => row.x >= 570 && row.x < 680 && /^(?:\d|赞|喜欢)/u.test(row.text));
  if (!three && !four) return {read: metric(read?.text, {read: true}), like: metric(null), share: metric(null), recommend: metric(null)};
  return {read: metric(read?.text, {read: true}), like: metric(at(three ? 710 : 570, three ? 790 : 680)),
    share: metric(at(three ? 790 : 680, three ? 900 : 790)), recommend: metric(at(three ? 930 : 790, three ? 1020 : 905))};
}
export function articleBodyRows(rows, {first = false, header = null, reachedEnd = false} = {}) {
  if (reachedEnd) return [];
  const {bodyEndY} = footerEvidence(rows);
  return rows.filter(row => row.y >= (first ? header?.bodyTop ?? 550 : 260) && row.y + row.h < Math.min(1900, bodyEndY ?? 1900)
    && !(first && row.y < (header?.bodyTop ?? 550) + 100 && /(?:听全文|A[I1l]摘要|A[I1l]总结)/u.test(row.text))
    && !/^(?:听全文|听|AI总结|AI摘要|原文|已复制到剪贴板)$/u.test(row.text.trim())
    && !/^(?:.*听全文.*AI.*|上一篇|下一篇|＜上一篇|<上一篇)/u.test(row.text.trim())).sort(position);
}
export function sameArticleTitle(left, right) { return similarity(left, right) >= 0.78; }
