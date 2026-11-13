import {DeviceError, throwIfAborted} from './bounded.mjs';
import {pause} from './ui-wait.mjs';
import {comparable, similarity} from './wechat-ocr-parse.mjs';
import {articleBodyRows, footerEvidence, parseArticleHeader, parseArticleMetrics, sameArticleTitle} from './wechat-article-parse.mjs';
import {createArticleBody, articleScreenOverlap} from './wechat-article-body.mjs';
import {mergeArticleComments, parseArticleComments} from './wechat-article-comments.mjs';

const text = rows => rows.map(row => row.text).join('\n');
const visible = rows => rows.filter(row => row.y >= 260 && row.y + row.h < 1900);
const FAST_SWIPE = [540, 1850, 540, 550, 600, 200];
const RECOVER_COMMENT_START = [540, 1000, 540, 1650, 600, 200];
const matches = (a, b) => comparable(a) === comparable(b) || (comparable(a).length > 12
  && JSON.stringify(a.match(/\d+/gu)) === JSON.stringify(b.match(/\d+/gu)) && similarity(a, b) >= 0.9);
/** Consecutive matching rows give both overlap evidence and the new screen's first unread row. */
export function articleOverlap(previous, next) {
  let best = null;
  for (let a = 0; a < previous.length; a++) for (let b = 0; b < Math.min(8, next.length); b++) {
    let count = 0, chars = 0;
    while (a + count < previous.length && b + count < next.length && matches(previous[a + count].text, next[b + count].text)) {
      chars += comparable(next[b + count].text).length; count++;
    }
    if (count >= 2 && chars >= 12 && (!best || count > best.count)) best = {count, chars, previousIndex: a, nextIndex: b, end: b + count};
  }
  return best;
}
export function appendArticleRows(existing, previous, current) {
  const overlap = articleOverlap(previous, current);
  const additions = overlap ? current.slice(overlap.end) : current;
  return {lines: [...existing, ...additions.map(row => row.text)], overlap: !!overlap};
}
function stableScreen(previous, current) {
  const before = visible(previous), after = visible(current);
  return before.length > 0 && Math.abs(before.length - after.length) <= 1 && similarity(text(before), text(after)) > 0.97
    && before.filter(row => after.some(other => Math.abs(row.y - other.y) < 18 && matches(row.text, other.text))).length >= before.length * 0.85;
}
function mergeMetrics(previous, incoming, capturedAt) {
  return Object.fromEntries(Object.entries(incoming).map(([key, value]) => [key, value.value !== null
    ? {...value, source: 'screen_ocr', capturedAt} : previous?.[key] ?? value]));
}
function footerAnchor(rows) {
  const footer = footerEvidence(rows), kind = footer.read ? 'read' : 'comments';
  const row = footer.read ?? footer.header;
  return row && row.y + row.h < 1900 ? {kind, text: comparable(row.text), y: row.y} : null;
}
/** Holds one open article across bounded OperationGate calls. No article text is interpreted as an instruction. */
export function createArticleReader({screen, look, assertArticle, card = null, now = Date.now, wait = pause,
  initialHeader = null, bodyRequired = true, maxPages = 80, maxCharacters = 100000, maxChunkPages = 8}) {
  if (!bodyRequired && !initialHeader?.headerVerified) {
    throw new DeviceError('article_identity_unverified', 'Supplemental article reading requires an already verified article', {deviceSettled: true});
  }
  const bodyText = createArticleBody();
  const state = {pages: 0, rows: [], bodyRows: [], lines: [], items: [], metrics: null, header: null, gap: false, capturedAt: null,
    reachedEnd: false, loadingReads: 0, stable: 0, done: false, stopReason: null, next: false, entrySeen: false, headerCount: null,
    postingState: 'unknown', unparsedComments: false};
  const commentScan = {fastScreens: 0, slowScreens: 0, footerSearchMs: null};
  let scanStartedAt, seek = 'fast';
  const readScreen = async signal => { await assertArticle({signal}); return look({signal}); };
  const snapshot = (commentsEnabled, limit) => {
    const complete = state.reachedEnd && !state.gap && state.header?.headerVerified && state.stopReason !== 'text_budget_exhausted';
    const bodyStatus = !bodyRequired ? 'delegated' : !state.lines.length ? 'unavailable' : complete ? 'complete' : 'partial';
    let status = 'unknown', reason = state.stopReason;
    if (!commentsEnabled || limit <= 0) { status = 'disabled'; reason = 'comments_disabled'; }
    else if (state.postingState === 'closed') { status = 'closed'; reason = 'comments_closed'; }
    else if (state.entrySeen) {
      if (state.headerCount === 0 && !state.items.length) status = 'empty';
      else if (state.items.length) status = state.stable >= 1 && !state.unparsedComments && !state.items.some(item => item.cut)
        && (state.headerCount === null || state.items.length >= state.headerCount) ? 'captured' : 'partial';
      if (state.unparsedComments) reason = 'comment_header_unparsed';
      if (!reason && status === 'partial') reason = 'visible_comments_incomplete';
      if (!reason && status === 'unknown') reason = 'comment_text_unavailable';
    } else if (state.reachedEnd && state.stable >= 1) { status = 'unavailable'; reason = 'no_comment_entry'; }
    const {bodyTop, headerVerified, titleObserved, ...header} = state.header ?? {};
    return {article: {...header, content: state.lines.join('\n').slice(0, maxCharacters), bodyStatus,
      bodyReason: !bodyRequired ? 'body_delegated' : bodyStatus === 'complete' ? null : !state.lines.length ? state.stopReason ?? 'body_text_unavailable' : state.gap ? 'scroll_gap'
        : !headerVerified ? 'header_unverified' : state.stopReason ?? 'reading_in_progress', metrics: state.metrics,
      evidence: {screens: state.pages, bodyEndObserved: state.reachedEnd, overlapVerified: bodyRequired ? !state.gap : null,
        originalImagesCaptured: false, ...(!bodyRequired ? {bodyCapture: 'delegated', scanReason: state.stopReason, commentScan: {...commentScan}} : {})}},
    comments: {status, reason, postingState: state.postingState, headerCount: state.headerCount,
      items: state.items.slice(0, limit).map(({cut, ...item}) => item), visibleScopeComplete: status === 'captured' || status === 'empty',
      truncated: status === 'partial', source: 'screen_ocr', capturedAt: state.capturedAt}, hasMore: !state.done, pagesRead: state.pages};
  };
  return {
    async read({limit = 20, commentsEnabled = true, budgetMs = 35000, signal} = {}) {
      limit = Math.max(0, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 20));
      scanStartedAt ??= now();
      const deadline = now() + Math.min(40000, Math.max(1000, budgetMs));
      let chunkPages = 0;
      while (!state.done && chunkPages < maxChunkPages && (chunkPages === 0 || now() < deadline - 4000)) {
        throwIfAborted(signal);
        const seekingFooter = !bodyRequired && !state.reachedEnd;
        const fast = seekingFooter && (seek === 'fast' || seek === 'reverse');
        const reversing = seekingFooter && seek === 'reverse';
        let scrolledForward = false;
        if (state.next) {
          await assertArticle({signal});
          if (fast) await screen.swipeAndHold(...(reversing ? RECOVER_COMMENT_START : FAST_SWIPE), {signal});
          else await screen.swipe(540, 1750, 540, 1200, 1100, {signal});
          await wait(fast ? 300 : 850, signal);
          scrolledForward = !reversing;
        }
        let rows = await readScreen(signal);
        const first = state.pages === 0;
        const observed = bodyRequired ? parseArticleHeader(rows, {card}) : null;
        if (first) {
          const fallback = initialHeader && observed?.titleObserved && sameArticleTitle(observed.title, initialHeader.title) ? initialHeader : null;
          state.header = !bodyRequired ? initialHeader : observed.headerVerified ? observed : fallback ?? observed;
          if (initialHeader && observed && observed.timePrecision !== 'unknown' && observed.bodyTop) state.header = {...state.header, bodyTop: observed.bodyTop};
        }
        // A large inertial jump must not silently create a 'complete' body. Reverse a short distance once and reread.
        if (bodyRequired && !first && !state.reachedEnd && !stableScreen(state.rows, rows)
          && !articleScreenOverlap(visible(state.rows), visible(rows))) {
          await assertArticle({signal});
          await screen.swipe(540, 1000, 540, 1350, 1100, {signal});
          scrolledForward = false;
          await wait(850, signal);
          rows = await readScreen(signal);
          if (!stableScreen(state.rows, rows) && !articleScreenOverlap(visible(state.rows), visible(rows))) state.gap = true;
        }
        // At the bottom of a short page an animated ad or OCR jitter on the like icon ("♥/Q/③ 不喜欢") keeps
        // whole-screen comparison from ever matching. A footer anchor that did not move after a swipe proves
        // the page cannot scroll further.
        const before = state.reachedEnd ? footerAnchor(state.rows) : null, after = footerAnchor(rows);
        const pinned = !first && scrolledForward && before && after
          && before.kind === after.kind && before.text === after.text && Math.abs(before.y - after.y) <= 8;
        const stable = !first && !fast && (pinned || stableScreen(state.rows, rows));
        state.stable = stable ? state.stable + 1 : 0;
        const visibleHeader = observed?.headerVerified && sameArticleTitle(observed.title, state.header?.title) ? observed : null;
        const body = bodyRequired ? articleBodyRows(rows, {first: first || !!visibleHeader, header: visibleHeader ?? state.header, reachedEnd: state.reachedEnd}) : [];
        if (body.length && !stable) {
          const merged = bodyText.add(body);
          // Screen overlap includes text above the body (header) on early short swipes, so it is the stronger evidence.
          if (!first && !merged.overlap && !articleScreenOverlap(visible(state.rows), visible(rows))) state.gap = true;
          state.lines = merged.lines;
        }
        state.capturedAt = new Date(now()).toISOString();
        state.metrics = mergeMetrics(state.metrics, parseArticleMetrics(rows), state.capturedAt);
        const footer = footerEvidence(rows);
        if (reversing) seek = 'slow';
        // A footer peeking below the safe OCR region does not prove the obscured final body lines were read.
        state.reachedEnd ||= !!footer.read && footer.read.y < 1900
          || !!footer.header && footer.header.y + footer.header.h < 1900;
        if (seekingFooter && !state.reachedEnd) {
          if (footer.read || footer.header) seek = 'slow';
          else {
            const probe = parseArticleComments(rows, {reachedEnd: true});
            if (probe.closed) state.reachedEnd = true;
            else if (probe.entrySeen || probe.comments.length) {
              if (seek === 'fast') seek = 'reverse';
              else { state.done = true; state.stopReason = 'comment_start_unverified'; }
            }
          }
        }
        if (!bodyRequired) {
          if (fast) commentScan.fastScreens++;
          else commentScan.slowScreens++;
          if (seekingFooter && state.reachedEnd) commentScan.footerSearchMs = Math.max(0, now() - scanStartedAt);
        }
        if (state.reachedEnd) {
          const comments = parseArticleComments(rows, {reachedEnd: true, topLevelOnly: true});
          state.entrySeen ||= comments.entrySeen;
          state.headerCount = comments.headerCount ?? state.headerCount;
          if (comments.postingState !== 'unknown') state.postingState = comments.postingState;
          state.unparsedComments ||= comments.unparsed;
          if (commentsEnabled && limit > 0) state.items = mergeArticleComments(state.items, comments.comments, limit);
          if (state.stable >= 1 || (!commentsEnabled || limit <= 0)) state.done = true;
          if (limit > 0 && state.items.length >= limit) { state.done = true; state.stopReason = 'comment_limit'; }
        } else if (bodyRequired && !state.lines.length && !body.length) {
          state.stable = 0; state.loadingReads++;
          if (state.loadingReads >= 12) { state.done = true; state.stopReason = 'body_load_timeout'; }
        } else if (state.stable >= 2) { state.done = true; state.stopReason = 'body_end_unverified'; }
        state.rows = rows; state.bodyRows = body; state.pages++; chunkPages++; state.next = true;
        if (bodyRequired && !state.reachedEnd && !state.lines.length && state.loadingReads <= 4) { state.next = false; await wait(750, signal); }
        if (state.pages >= maxPages || (bodyRequired && state.lines.join('\n').length >= maxCharacters)) {
          state.done = true; state.stopReason = state.pages >= maxPages ? 'screen_budget_exhausted' : 'text_budget_exhausted';
        }
      }
      return snapshot(commentsEnabled, limit);
    },
  };
}
