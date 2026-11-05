import {RunnerFault} from './errors.mjs';
import {wechatPostEvent} from './wechat-evidence.mjs';
import {comparable, similarity} from '../device/wechat-ocr-parse.mjs';

// Negative patrol of one Channels post (docs/hotfix/20261105-wechat-channels-mobile.md). The stored share link is
// read through the preview page first (counts, still there?). With comments in the plan the phone also looks the
// post up again: it searches the start of the caption, opens at most MAX_OPENS cards whose author and text fit,
// and accepts a card only when its own preview has the same publish second and author. A post that cannot be
// found is never declared deleted: the run reports patrol_not_relocated and the server cools it down.
export const MAX_OPENS = 3;
const MAX_PAGES = 2;

const authorFits = (card, nickname) => {
  const a = comparable(card.author), b = comparable(nickname);
  return Boolean(a && b && (a.startsWith(b) || b.startsWith(a) || similarity(a, b) >= 0.6));
};
// Letters and digits only: card snippets and stored captions differ in punctuation, spaces and hashtags marks.
const bare = value => comparable(value).replace(/[^\p{L}\p{N}]/gu, '');
const textFits = (card, target) => {
  const snippet = bare(card.snippet), caption = bare(target.content || target.title);
  return Boolean(snippet && caption && (caption.includes(snippet.slice(0, 8)) || similarity(snippet, caption.slice(0, snippet.length + 4)) >= 0.6));
};
export const sameWork = (info, target) => Boolean(info && !info.unavailable && Number.isSafeInteger(target.createtime)
  && info.createtime === target.createtime && comparable(info.nickname) === comparable(target.author));

/** One patrol item: call(method, params) runs a gated device action; resolve(link) reads a preview. */
export async function runWechatPatrol({task, call, resolve, commentLimit, clock, record, note}) {
  const target = task.patrolTarget;
  if (!target || typeof target.url !== 'string') throw new RunnerFault('invalid_patrol_target');
  let stored = null;
  try { stored = await resolve(target.url); } catch (error) { note('wechat_patrol_preview_failed', error); }
  const reference = {...target, createtime: Number.isSafeInteger(target.createtime) ? target.createtime : stored?.createtime ?? null};
  if (stored && !stored.unavailable && !sameWork(stored, reference)) stored = null;
  let found = null;
  if (commentLimit > 0) {
    // The server sends the start of the caption (hashtags and emoji removed) as the task keyword.
    let cards = (await call('search', {keyword: task.keyword, sort: 'all'})).cards;
    const tried = new Set();
    for (let page = 0; page < MAX_PAGES && !found && tried.size < MAX_OPENS; page++) {
      for (const card of cards.filter(item => !tried.has(item.cardKey) && authorFits(item, reference.author) && textFits(item, reference))) {
        if (tried.size >= MAX_OPENS) break;
        tried.add(card.cardKey);
        await call('openCard', {card});
        const {shareUrl} = await call('copyLink');
        let info = null;
        try { info = await resolve(shareUrl); } catch (error) { note('wechat_patrol_preview_failed', error); }
        if (sameWork(info, reference)) {
          const comments = await call('readComments', {limit: commentLimit});
          found = {card, shareUrl, info, comments};
        }
        cards = await call('returnToResults');
        if (found) break;
      }
      if (!found && page + 1 < MAX_PAGES) { await call('scroll'); cards = await call('readCards'); }
    }
  }
  const capturedAt = clock.wallNow();
  if (found) {
    record(wechatPostEvent({task, card: found.card, rank: null, shareUrl: found.shareUrl, info: found.info, comments: found.comments, capturedAt}));
    return {status: 'completed', reason: 'patrol_relocated'};
  }
  if (stored && !stored.unavailable) {
    record(wechatPostEvent({task, card: null, rank: null, shareUrl: target.url, info: stored,
      comments: {status: commentLimit > 0 ? 'not_relocated' : 'disabled', items: []}, capturedAt}));
    return {status: 'completed', reason: commentLimit > 0 ? 'patrol_counts_only' : 'patrol_preview'};
  }
  return {status: 'completed_with_warnings', reason: 'patrol_not_relocated'};
}
