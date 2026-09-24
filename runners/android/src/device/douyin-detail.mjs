import { DeviceError } from './bounded.mjs';
import { appNodes, byId, readDetail, detailMatchesCard, readSearch } from './douyin-profile.mjs';
import { readUntil, READ_TIMEOUT_MS, RETRY_DELAY_MS } from './ui-wait.mjs';

/** Default budget for re-reading a detail that was already verified once (copy flow). */
export const DETAIL_READY_BUDGET_MS = 15_000;
// Errors below are thrown only after a completed read: nothing is in flight on the phone.
const settled = (code, message, details = {}) => new DeviceError(code, message, { ...details, deviceSettled: true });

// 40.6.0 places its expand/collapse label inside the clickable video caption.
// Remove that UI suffix only when the remaining full text AND author match the card.
function readCardDetail(tree, card) {
  const detail = readDetail(tree);
  if (!detail || detailMatchesCard(detail, card)) return detail;
  const captions = byId(tree, 'desc');
  if (detail.kind === 'video' && captions.length === 1
    && captions[0].attributes.clickable === 'true' && detail.title.endsWith(' 收起')) {
    const expanded = {...detail, title: detail.title.slice(0, -3)};
    if (detailMatchesCard(expanded, card)) return expanded;
  }
  return detail;
}

/** Diagnostic counts only; captions and authors never leave the device layer through errors. */
export function describeDetailTree(tree) {
  const count = id => byId(tree, id).length;
  return { appNodes: appNodes(tree).length, noteCaption: count('tv_desc'), noteAuthor: count('w67'), noteShare: count('n00'),
    videoCaption: count('desc'), videoAuthor: count('title'), videoShare: count('vmj') };
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
    && captions[0].attributes.clickable === 'true' && /\.\.\.\s+展开$/u.test(detail.title);
  if (detail.kind !== 'video' || !sameAuthor || (!separateExpand && !inlineExpand)) {
    throw settled('detail_identity_unverified', 'Opened detail differs from the selected card', { stage: 'loaded' });
  }
  // Expand the observed control; a truncated prefix alone never verifies identity.
  await ui.clickId(separateExpand ? '0s0' : 'desc', { signal });
  const expanded = await readUntil({ ui, signal, budgetMs, now,
    predicate: current => detailMatchesCard(readCardDetail(current, card), card) });
  const result = readCardDetail(expanded.tree, card);
  if (!expanded.matched || !detailMatchesCard(result, card)) {
    throw settled('detail_identity_unverified', 'Expanded detail did not match', { stage: 'expanded', attempts: expanded.attempts });
  }
  return result;
}

/**
 * Verify that the open detail is the selected card. The hierarchy is re-read, never re-clicked,
 * while the budget allows; identity is checked strictly on every read. Outcomes:
 * - matching detail (possibly after one expand of the same-author video caption);
 * - detail_identity_unverified: a detail loaded but it is another work;
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
      { attempts: outcome.attempts, elapsedMs: Math.round(outcome.elapsedMs) });
  }
  throw settled('detail_ui_not_ready', 'The detail page did not expose a readable work inside the action budget',
    { attempts: outcome.attempts, elapsedMs: Math.round(outcome.elapsedMs), budgetMs, observed,
      activity: await currentActivity(ui, signal) });
}
