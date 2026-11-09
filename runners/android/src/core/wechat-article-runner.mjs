import {BudgetLedger} from './budget.mjs';
import {OperationGate} from './operation-gate.mjs';
import {RunnerFault, requireEvidence} from './errors.mjs';
import {DeviceClosureJournal, readDeviceClosure} from './device-closure.mjs';
import {recordDiagnostic} from './diagnostics.mjs';
import {faultDetails} from './discovery-runner.mjs';
import {cardPrefilter, POST_PAUSE_MS, DEFAULT_CLOCK as CLOCK, outcome, sleep, validateWechatIdentity} from './wechat-runner.mjs';
import {articleEvent, articleWorkKey, canonicalArticleUrl, articleWindowState, mergeArticleCapture} from './wechat-article-evidence.mjs';

const METHODS = ['inspect', 'search', 'readCards', 'openCard', 'copyLink', 'readArticle', 'returnToResults', 'recoverResults', 'scroll'];
const RECOVERABLE = new Set(['card_open_failed', 'share_sheet_unverified', 'link_not_copied', 'screen_unverified',
  'article_link_invalid', 'article_header_unverified', 'article_identity_unverified', 'article_unavailable']);

function validate(task, permit, device) {
  validateWechatIdentity(task, permit);
  requireEvidence(task?.platform === 'wechat_articles' && task.keyword?.trim() && task.filters, 'invalid_task');
  requireEvidence(['keyword', 'patrol', undefined].includes(task.mode), 'invalid_task_mode');
  requireEvidence((task.filters.scope ?? 'all') === 'all' && (task.filters.duration ?? 'all') === 'all', 'unsupported_article_filters');
  for (const method of METHODS) requireEvidence(typeof device[method] === 'function', 'invalid_device_adapter');
  if (task.mode === 'patrol') {
    requireEvidence(!!canonicalArticleUrl(task.patrolTarget?.url), 'invalid_patrol_target');
    requireEvidence(typeof device.openArticleLink === 'function', 'invalid_device_adapter');
  }
}

/** Each read yields before the operation deadline. Body collection does not depend on comment availability. */
export async function runWechatArticleTask({task, store, device, permit, clock = CLOCK, actionTimeoutMs = 60_000,
  preview, bodySource = 'page_dom', resumeAuthorized = false, deviceClosureVerified = null,
  prefilter = null, random = Math.random, postPauseMs = POST_PAUSE_MS}) {
  let ledger, gate, result, failure = null, lastEventId = null;
  const stats = {posts: 0, comments: 0, partialBodies: 0, unavailableBodies: 0, outsideWindow: 0, timeUnverified: 0};
  const note = (event, error = null, extra = {}) => recordDiagnostic(store, {at: new Date(clock.wallNow()).toISOString(), event,
    runId: task?.identity?.discoveryRunId ?? null, itemId: task?.identity?.itemId ?? null, keyword: task?.keyword ?? null,
    code: error?.code ?? null, operation: error?.operation ?? null, details: error ? faultDetails(error) : null, ...extra});
  const hours = Number.isFinite(task?.filters?.publishWindowHours) ? task.filters.publishWindowHours : null;
  const record = (card, rank, shareUrl, read, capturedAt) => {
    const window = task.mode === 'patrol' ? 'inside' : articleWindowState(read.article, capturedAt, hours);
    if (window === 'outside') { stats.outsideWindow++; return; }
    if (window === 'unknown') { stats.timeUnverified++; return; }
    const event = articleEvent({task, card, rank, shareUrl, ...read, capturedAt});
    if (!store.getEvent(event.eventId)) {
      store.recordEvent(event); stats.posts++; stats.comments += event.comments.items.length;
      if (event.article.bodyStatus === 'partial') stats.partialBodies++;
      if (event.article.bodyStatus === 'unavailable') stats.unavailableBodies++;
    }
    lastEventId = event.eventId;
  };
  try {
    validate(task, permit, device); permit.assertAllowed();
    requireEvidence(['page_dom', 'screen_ocr'].includes(bodySource), 'invalid_article_source');
    if (bodySource === 'page_dom') requireEvidence(typeof preview?.resolveArticle === 'function', 'preview_unavailable');
    ledger = new BudgetLedger({task, store, clock, resumeAuthorized});
    gate = new OperationGate({permit, beforeAction: () => ledger.assertAllowed(), timeoutMs: actionTimeoutMs,
      journal: new DeviceClosureJournal({store, task, clock, deviceClosureVerified})});
    const call = (method, params = {}) => gate.run((signal, {budgetMs}) => device[method]({...params, signal,
      budgetMs: Math.min(35_000, Math.max(1, budgetMs - 2000))}), method);
    const state = await call('inspect');
    requireEvidence(state?.deviceId === task.deviceId, 'device_identity_mismatch');
    if (state.readyForSearch === false) throw new RunnerFault(state.reason ?? 'device_not_ready');
    const patrol = task.mode === 'patrol';
    const commentLimit = task.comments?.enabled === true ? Math.max(0, Math.min(500, task.comments.limit ?? 50)) : 0;
    const readOpened = async (card, rank, shareUrl) => {
      // The normal runtime uses the same desktop preview service as Channels. OCR remains an explicit
      // diagnostic mode; a refused or challenged web page never silently falls back to another access path.
      const page = bodySource === 'page_dom' ? await gate.run(signal => preview.resolveArticle(shareUrl, {signal}), 'resolveArticle') : null;
      if (page) {
        requireEvidence(canonicalArticleUrl(page.url) === canonicalArticleUrl(shareUrl), 'article_link_mismatch');
        requireEvidence(page.source === 'page_dom' && page.title?.trim() && page.account?.trim()
          && (page.content?.trim() || page.images?.length), 'article_page_incomplete');
        const window = patrol ? 'inside' : articleWindowState(page, clock.wallNow(), hours);
        if (window === 'outside') { stats.outsideWindow++; return; }
        if (window === 'unknown') { stats.timeUnverified++; return; }
      }
      let read, merged;
      for (let chunk = 0; chunk < 80; chunk++) {
        try {
          read = await call('readArticle', {limit: commentLimit, maxPages: 8, bodyRequired: !page});
          merged = mergeArticleCapture(page, read, clock.wallNow());
        }
        catch (error) {
          if (error.code === 'budget_exhausted' && merged?.article?.title && merged.article.account) {
            if (!page) merged.article = {...merged.article, bodyStatus: 'partial', bodyReason: error.details.reason};
            else merged.comments = {...merged.comments, status: commentLimit ? 'partial' : 'disabled', reason: error.details.reason};
            record(card, rank, shareUrl, merged, clock.wallNow());
          }
          throw error;
        }
        if (!read.hasMore) break;
        if (chunk === 79) {
          if (!page) merged.article = {...merged.article, bodyStatus: 'partial', bodyReason: 'reader_chunk_limit'};
          else merged.comments = {...merged.comments, status: commentLimit ? 'partial' : 'disabled', reason: 'reader_chunk_limit'};
        }
      }
      record(card, rank, shareUrl, merged, clock.wallNow());
    };
    if (patrol) {
      const url = canonicalArticleUrl(task.patrolTarget.url);
      ledger.beforeCard();
      let opened;
      for (let chunk = 0; chunk < 80; chunk++) {
        opened = await call('openArticleLink', {url});
        if (!opened?.hasMore) break;
      }
      requireEvidence(opened?.opened === true, 'article_header_unverified');
      const copied = canonicalArticleUrl((await call('copyLink')).shareUrl);
      requireEvidence(copied === url, 'article_link_mismatch');
      await readOpened(null, 1, url); ledger.noteLink(articleWorkKey(url));
      result = {status: 'completed', reason: 'patrol_relocated'};
    }
    if (!patrol) {
      const sort = hours !== null ? 'latest' : task.filters.sort ?? 'all';
      const searched = await call('search', {keyword: task.keyword, sort, scope: 'all'});
      requireEvidence(searched?.verified === true, 'search_context_unverified');
      let cards = searched.cards, emptyPages = 0, old = 0, rank = 0, skips = 0;
      const seen = new Set(), links = new Set(ledger.item.links);
      const decide = cardPrefilter(prefilter, task, permit, clock, ledger);
      while (!result) {
        const fresh = cards.filter(card => !seen.has(card.cardKey));
        if (!fresh.length) {
          if (++emptyPages >= 2) {
            result = {status: 'completed', reason: 'results_end'}; break;
          }
          ledger.beforeSwipe(); await call('scroll'); cards = await call('readCards'); continue;
        }
        emptyPages = 0;
        const skip = await decide(fresh), card = fresh[0];
        seen.add(card.cardKey); rank++;
        if (hours !== null && card.age?.minHours > hours) {
          if (++old >= 2) { result = {status: 'completed', reason: 'publish_window_end'}; break; }
          continue;
        }
        if (card.age) old = 0;
        if (skip.has(card.cardKey)) continue;
        ledger.beforeCard();
        let shareUrl;
        try {
          let opened;
          for (let chunk = 0; chunk < 80; chunk++) {
            opened = await call('openCard', {card});
            if (!opened?.hasMore) break;
          }
          requireEvidence(opened?.opened === true, 'article_header_unverified');
          shareUrl = canonicalArticleUrl((await call('copyLink')).shareUrl);
          requireEvidence(!!shareUrl, 'article_link_invalid');
          if (links.has(articleWorkKey(shareUrl))) {
            cards = await call('returnToResults'); continue;
          }
          await readOpened(card, rank, shareUrl);
          links.add(articleWorkKey(shareUrl)); ledger.noteLink(articleWorkKey(shareUrl)); skips = 0;
        } catch (error) {
          if (!RECOVERABLE.has(error.code) || error.deviceSettled !== true || ++skips > 4) throw error;
          ledger.noteSkippedCard(); note('wechat_article_skipped', error);
          cards = await call('recoverResults'); continue;
        }
        cards = await call('returnToResults');
        await sleep(postPauseMs[0] + Math.round(random() * (postPauseMs[1] - postPauseMs[0])), permit.signal);
        permit.assertAllowed();
      }
    }
    if (result.status === 'completed' && (stats.partialBodies || stats.unavailableBodies)) {
      result = {...result, status: 'completed_with_warnings', reason: 'article_body_incomplete'};
    }
    if (result.status === 'completed' && stats.timeUnverified) result = {...result, status: 'completed_with_warnings', reason: 'article_time_unverified'};
  } catch (error) { failure = error; result = {...outcome(error), message: error.message, details: faultDetails(error)}; }
  if (ledger) {
    try { ledger.finish(result.status, result.reason); }
    catch (error) { failure = error; result = {...outcome(error), message: error.message, details: faultDetails(error)}; }
  }
  note('task_finished', failure, {status: result.status, reason: result.reason, stats: {...ledger?.summary(), ...stats}});
  const deviceClosure = task?.deviceId ? readDeviceClosure(store, task.deviceId) : null;
  const deviceIdle = !deviceClosure?.required && (gate ? gate.deviceIdle : true);
  return {...result, stats: ledger ? {...ledger.summary(), ...stats} : null, lastEventId, deviceIdle,
    stopConfirmationRequired: !deviceIdle, deviceClosure, pendingEvents: store.pendingCount()};
}
