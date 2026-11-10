import {comparable, similarity} from './wechat-text-match.mjs';

export function canonicalArticleUrl(value) {
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.username || url.password || url.port
    || !/^\/s\/[A-Za-z0-9_-]{8,128}\/?$/u.test(url.pathname)) return '';
  return `https://mp.weixin.qq.com${url.pathname.replace(/\/$/u, '')}`;
}

export function sameArticleTitle(left, right) { return similarity(left, right) >= 0.78; }
// A result card can show only the tail of a long title (its first line sits under the sticky bar) and the
// header byline can read "作者 公众号". Containment of at least 6 characters counts as the same text.
const contains = (whole, part) => { const a = comparable(whole), b = comparable(part);
  return [...b.replace(/[^\p{L}\p{N}]/gu, '')].length >= 6 && a.includes(b); };
const nameParts = value => String(value ?? '').normalize('NFKC').trim().split(/\s+/u).map(comparable);
const sameName = (left, right) => { const a = comparable(left), b = comparable(right);
  // A visible byline can contain both the author and the account. Match complete name tokens, never a
  // substring such as 安吉星 inside the distinct account 安吉星服务.
  return !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 2
    && (nameParts(left).includes(b) || nameParts(right).includes(a)))); };
export function cardMatchesHeader(card, header) {
  const title = card?.title ?? card?.snippet;
  return (sameArticleTitle(header?.title, title) || contains(header?.title, title)) && sameName(header?.account, card?.account ?? card?.author);
}
