import { DeviceError } from './bounded.mjs';
import { appNodes, byId, readDetail, detailMatchesCard, readSearch } from './douyin-profile.mjs';
import { readUntil, READ_TIMEOUT_MS, RETRY_DELAY_MS } from './ui-wait.mjs';

/** Default budget for re-reading a detail that was already verified once (copy flow). */
export const DETAIL_READY_BUDGET_MS = 15_000;
// Errors below are thrown only after a completed read: nothing is in flight on the phone.
const settled = (code, message, details = {}) => new DeviceError(code, message, { ...details, deviceSettled: true });
// After an expand tap, stop waiting as soon as the page shows it will not become the selected work.
const EXPAND_UNCHANGED_READS = 3;
const EXPAND_LEFT_DETAIL_READS = 3;
// 40.6.0 appends a UI "收起" after expansion; the whitespace before it varies ("\n收起", " 收起", "收起").
const COLLAPSE_SUFFIX = /\s*收起$/u;
// The collapsed caption ends with an ellipsis and an inline "展开" ("... 展开", "…展开").
const COLLAPSED_CAPTION = /(?:\.\.\.|…)\s*展开$/u;

// On some videos 40.6.0 answers the inline "展开" with a detail panel over the video instead of
// expanding in place: author g_5, full caption g=7, heading "相关推荐" g_f (measured on the DE106,
// 2026-09-26). The share button is hidden until the panel is closed again. The caption node ends with
// the publish time ("…#车载大屏    23小时前"); that suffix is removed only when it is exactly the time the
// detail page showed before the tap, so the rest must still equal the card caption.
function readCaptionPanel(tree, publishTime = null) {
  const headings = byId(tree, 'g_f').filter(node => node.attributes.text === '相关推荐');
  const captions = byId(tree, 'g=7'); const authors = byId(tree, 'g_5');
  if (headings.length !== 1 || captions.length !== 1 || authors.length !== 1) return null;
  let title = captions[0].attributes.text?.trimEnd() ?? ''; const author = authors[0].attributes.text;
  if (publishTime && title.endsWith(publishTime) && /\s$/u.test(title.slice(0, -publishTime.length))) {
    title = title.slice(0, -publishTime.length).trimEnd();
  }
  return title.trim() && author?.trim() ? { kind: 'video', title, author } : null;
}
// The detail page's own publish time (" · 23小时前"), read before the tap.
function detailPublishTime(tree) {
  const nodes = byId(tree, '4wp');
  const value = nodes.length === 1 ? (nodes[0].attributes.text ?? '').replace(/^[\s·]+/u, '').trim() : '';
  return value || null;
}

// Remove the UI collapse label only when the remaining full text AND author match the card exactly.
// Whitespace is not identity (normalizeCaption drops it), so accepting any spacing before "收起" is not a looser match.
function readCardDetail(tree, card) {
  const detail = readDetail(tree);
  if (!detail || detailMatchesCard(detail, card)) return detail;
  const captions = byId(tree, 'desc');
  if (detail.kind === 'video' && captions.length === 1
    && captions[0].attributes.clickable === 'true' && COLLAPSE_SUFFIX.test(detail.title)) {
    const expanded = {...detail, title: detail.title.replace(COLLAPSE_SUFFIX, '')};
    if (detailMatchesCard(expanded, card)) return expanded;
  }
  return detail;
}

/** Diagnostic counts only; captions and authors never leave the device layer through uploaded details. */
export function describeDetailTree(tree) {
  const count = id => byId(tree, id).length;
  return { appNodes: appNodes(tree).length, noteCaption: count('tv_desc'), noteAuthor: count('w67'), noteShare: count('n00'),
    videoCaption: count('desc'), videoAuthor: count('title'), videoShare: count('vmj') };
}

const clip = (value, max = 300) => typeof value === 'string' ? value.slice(0, max) : null;
// Visible text nodes, so a local diagnostic shows where a caption actually went after a tap.
function visibleTexts(tree) {
  return appNodes(tree).filter(node => (node.attributes.text || '').length >= 8).slice(0, 12)
    .map(node => ({ id: (node.attributes['resource-id'] || '').split('/').pop().slice(0, 40),
      length: node.attributes.text.length, text: clip(node.attributes.text, 60) }));
}
const workFields = work => work ? { kind: work.kind, title: clip(work.title), author: clip(work.author, 80) } : null;
/**
 * A local-only record of why a card could not be verified (the core keeps it in the private state
 * database for `diagnose`). It is deliberately not one of the uploaded completion detail keys.
 */
function diagnosticFor({ card, detail = null, after = null, extra = {} }) {
  return { card: { title: clip(card?.title), author: clip(card?.author, 80) },
    detail: workFields(detail), after: workFields(after), ...extra };
}

async function currentActivity(ui, signal) {
  if (typeof ui.currentActivity !== 'function') return null;
  try { return await ui.currentActivity({ signal }); } catch { return null; }
}

// The detail is loaded but differs from the card. Only a same-author video with a visible
// expand control may be expanded once; the full caption must then match exactly.
async function expandAndVerify({ ui, tree, detail, card, signal, budgetMs, now }) {
  const expand = byId(tree, '0s0');
  const sameAuthor = detail.author === card.author || detail.author === `@${card.author}`;
  const captions = byId(tree, 'desc');
  const separateExpand = expand.length === 1 && expand[0].attributes.text === '展开';
  const inlineExpand = expand.length === 0 && captions.length === 1
    && captions[0].attributes.clickable === 'true' && COLLAPSED_CAPTION.test(detail.title);
  if (detail.kind !== 'video' || !sameAuthor || (!separateExpand && !inlineExpand)) {
    throw settled('detail_identity_unverified', 'Opened detail differs from the selected card', { stage: 'loaded',
      diagnostic: diagnosticFor({ card, detail, extra: { stage: 'loaded', sameAuthor, expandButtons: expand.length,
        captionNodes: captions.length, texts: visibleTexts(tree) } }) });
  }
  // Expand through the observed control only: the dedicated button, or the inline "展开" at the caption's end.
  // A truncated prefix never verifies identity, and the caption centre is never tapped because it can be a link.
  let tap = null;
  const startedAt = now();
  if (separateExpand) await ui.clickId('0s0', { signal });
  else tap = await ui.tapIdNearEnd('desc', { signal });
  let outcome = 'timeout', unchanged = 0, left = 0, changedTitle = null, last = null, panel = null, panelMismatches = 0;
  const publishTime = detailPublishTime(tree);
  const expanded = await readUntil({ ui, signal, budgetMs, now, predicate: current => {
    const shown = readCaptionPanel(current, publishTime);
    if (shown) {
      if (detailMatchesCard(shown, card)) { panel = shown; outcome = 'panel'; return true; }
      // A panel that keeps showing another text or author belongs to another work.
      last = shown; left = 0;
      if (++panelMismatches >= 2) { outcome = 'panel_mismatch'; return true; }
      return false;
    }
    const found = readCardDetail(current, card);
    if (detailMatchesCard(found, card)) return true;
    last = found ?? last;
    if (!found) {
      unchanged = 0; changedTitle = null;
      if (++left >= EXPAND_LEFT_DETAIL_READS) { outcome = 'left_detail'; return true; }
      return false;
    }
    left = 0;
    if (found.title === detail.title) {
      changedTitle = null;
      if (++unchanged >= EXPAND_UNCHANGED_READS) { outcome = 'no_change'; return true; }
      return false;
    }
    unchanged = 0;
    // The caption changed but reads the same twice in a row without matching: it is another text.
    if (found.title === changedTitle) { outcome = 'mismatch'; return true; }
    changedTitle = found.title;
    return false;
  } });
  if (panel) {
    return closeCaptionPanel({ ui, card, detail, panel, signal, now, tap,
      budgetMs: Math.max(budgetMs - (now() - startedAt), READ_TIMEOUT_MS + RETRY_DELAY_MS) });
  }
  const result = readCardDetail(expanded.tree, card);
  if (detailMatchesCard(result, card)) return result;
  throw settled('detail_identity_unverified', 'Expanded detail did not match', { stage: 'expanded', expandOutcome: outcome,
    attempts: expanded.attempts, diagnostic: diagnosticFor({ card, detail, after: last, extra: { stage: 'expanded',
      expandOutcome: outcome, control: separateExpand ? 'button' : 'inline', tap, texts: visibleTexts(expanded.tree),
      activity: await currentActivity(ui, signal) } }) });
}

// The panel showed the card's full caption and author. Close it and require the very same collapsed
// detail (caption and author unchanged) before anything else uses the page; the share flow needs it.
async function closeCaptionPanel({ ui, card, detail, panel, signal, now, tap, budgetMs }) {
  await ui.back({ signal });
  const restored = await readUntil({ ui, signal, budgetMs, now, predicate: current => {
    const found = readDetail(current);
    return !readCaptionPanel(current) && found?.title === detail.title && found.author === detail.author;
  } });
  if (restored.matched) return { ...readDetail(restored.tree), title: panel.title };
  throw settled('detail_identity_unverified', 'The detail did not return after its caption panel closed', {
    stage: 'panel', expandOutcome: 'panel_not_closed', attempts: restored.attempts,
    diagnostic: diagnosticFor({ card, detail, after: readDetail(restored.tree), extra: { stage: 'panel',
      expandOutcome: 'panel_not_closed', control: 'inline', tap, texts: visibleTexts(restored.tree),
      activity: await currentActivity(ui, signal) } }) });
}

/**
 * Verify that the open detail is the selected card. The hierarchy is re-read, never re-clicked,
 * while the budget allows; identity is checked strictly on every read. Outcomes:
 * - matching detail (possibly after one expand of the same-author video caption, in place or in a caption panel
 *   that is closed again before returning);
 * - detail_identity_unverified: a detail loaded but it is another work (stage loaded/expanded);
 * - card_open_failed: the verified results page kept showing after the click (searchKeyword given);
 * - detail_ui_not_ready: no readable detail appeared inside the budget;
 * - transport faults (device_timeout, appium_*, aborted, douyin_not_foreground) propagate unchanged.
 */
export async function readVerifiedDetail({ ui, card, signal, budgetMs = DETAIL_READY_BUDGET_MS, searchKeyword = null,
  now = () => performance.now() }) {
  let observed = null;
  let resultsPageReads = 0;
  const outcome = await readUntil({ ui, signal, budgetMs, now, predicate: (tree, { elapsedMs }) => {
    if (readCardDetail(tree, card)) return true;
    observed = describeDetailTree(tree);
    if (searchKeyword && readSearch(tree, searchKeyword).verified) resultsPageReads++;
    return resultsPageReads >= 2 && elapsedMs >= 1000;
  } });
  const detail = readCardDetail(outcome.tree, card);
  if (detail) {
    if (detailMatchesCard(detail, card)) return detail;
    return expandAndVerify({ ui, tree: outcome.tree, detail, card, signal, now,
      budgetMs: Math.max(budgetMs - outcome.elapsedMs, READ_TIMEOUT_MS + RETRY_DELAY_MS) });
  }
  if (resultsPageReads >= 2) {
    throw settled('card_open_failed', 'The selected card did not open; the verified results page is still showing',
      { attempts: outcome.attempts, elapsedMs: Math.round(outcome.elapsedMs),
        diagnostic: diagnosticFor({ card, extra: { stage: 'open' } }) });
  }
  const activity = await currentActivity(ui, signal);
  throw settled('detail_ui_not_ready', 'The detail page did not expose a readable work inside the action budget',
    { attempts: outcome.attempts, elapsedMs: Math.round(outcome.elapsedMs), budgetMs, observed, activity,
      diagnostic: diagnosticFor({ card, extra: { stage: 'not_ready', observed, activity, texts: visibleTexts(outcome.tree) } }) });
}
