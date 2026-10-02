import { DeviceError } from './bounded.mjs';
import { appNodes, byId, readDetail, detailMatchesCard, readSearch } from './douyin-profile.mjs';
import { readUntil } from './ui-wait.mjs';

/** Default budget for re-reading a detail that was already verified once (copy flow). */
export const DETAIL_READY_BUDGET_MS = 15_000;
// Errors below are thrown only after a completed read: nothing is in flight on the phone.
const settled = (code, message, details = {}) => new DeviceError(code, message, { ...details, deviceSettled: true });

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
function diagnosticFor({ card, detail = null, extra = {} }) {
  return { card: { title: clip(card?.title), author: clip(card?.author, 80) }, detail: workFields(detail), ...extra };
}

async function currentActivity(ui, signal) {
  if (typeof ui.currentActivity !== 'function') return null;
  try { return await ui.currentActivity({ signal }); } catch { return null; }
}

/**
 * Verify that the open detail is the selected card. The hierarchy is re-read, never re-clicked, and nothing on the
 * detail is tapped: identity is decided from what the page shows (detailMatchesCard). Outcomes:
 * - matching detail, returned as shown (a folded caption included);
 * - detail_identity_unverified: a detail loaded but it is another work (stage loaded);
 * - card_open_failed: the verified results page kept showing after the click (searchKeyword given);
 * - detail_ui_not_ready: no readable detail appeared inside the budget;
 * - transport faults (device_timeout, appium_*, aborted, douyin_not_foreground) propagate unchanged.
 */
export async function readVerifiedDetail({ ui, card, signal, budgetMs = DETAIL_READY_BUDGET_MS, searchKeyword = null,
  now = () => performance.now() }) {
  let observed = null;
  let resultsPageReads = 0;
  const outcome = await readUntil({ ui, signal, budgetMs, now, predicate: (tree, { elapsedMs }) => {
    if (readDetail(tree)) return true;
    observed = describeDetailTree(tree);
    if (searchKeyword && readSearch(tree, searchKeyword).verified) resultsPageReads++;
    return resultsPageReads >= 2 && elapsedMs >= 1000;
  } });
  const detail = readDetail(outcome.tree);
  if (detail) {
    if (detailMatchesCard(detail, card)) return detail;
    const sameAuthor = detail.author === card.author || detail.author === `@${card.author}`;
    throw settled('detail_identity_unverified', 'Opened detail differs from the selected card', { stage: 'loaded',
      diagnostic: diagnosticFor({ card, detail, extra: { stage: 'loaded', sameAuthor,
        captionNodes: byId(outcome.tree, 'desc').length, texts: visibleTexts(outcome.tree) } }) });
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
