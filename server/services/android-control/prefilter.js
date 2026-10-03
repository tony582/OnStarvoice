import {PREFILTER_PROMPT_VERSION} from '../relevance-prefilter.js';
import {truncateWellFormed} from '../../utils/well-formed-text.js';
import {fail,id,identity,WORKFLOW} from './validation.js';
import {currentAttempt} from './leases.js';
import {mobileRelevancePrefilterEnabled} from './mobile-tasks.js';

// Result-card screening for the phone (README.md, "Card prefilter"). The phone
// sends the new cards of one results page; the server asks the same relevance
// prefilter the browser uses and the phone skips only what it clearly says to
// skip. Every failure here is fail-open on the phone: it opens the card.
export const MOBILE_PREFILTER_MAX_CARDS = 8;
const CARD_ID = /^[a-f0-9]{64}$/;
// The prefilter keeps the first 500/200 characters; this only bounds what we hold.
const TITLE_MAX = 2000, AUTHOR_MAX = 400, REASON_MAX = 160;

export function prefilterInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_BODY', 400);
  identity(body.identity);
  const requestId = id(body.requestId, 'REQUEST_ID');
  if (!Array.isArray(body.cards) || body.cards.length === 0) fail('CARDS_REQUIRED', 400);
  if (body.cards.length > MOBILE_PREFILTER_MAX_CARDS) fail('TOO_MANY_CARDS', 413);
  const seen = new Set();
  const cards = body.cards.map(card => {
    // A card id is the phone's sha256 of [title, author]: never empty and never
    // carrying ':' (the prefilter would read text after ':' as a record id).
    if (!card || typeof card !== 'object' || Array.isArray(card) || typeof card.cardId !== 'string'
      || !CARD_ID.test(card.cardId) || typeof card.title !== 'string' || typeof card.author !== 'string') fail('INVALID_CARD', 422);
    if (seen.has(card.cardId)) fail('DUPLICATE_CARD_ID', 422);
    seen.add(card.cardId);
    return {cardId: card.cardId, title: truncateWellFormed(card.title, TITLE_MAX), author: truncateWellFormed(card.author, AUTHOR_MAX)};
  });
  return {requestId, cards};
}

// The attempt is checked in its own short transaction: currentAttempt locks the
// agent slot and the item/attempt rows, and the model call may take 20 s, so it
// must never run while those locks are held (renew would time out behind it).
async function verifyAttempt(transaction, principal, body) {
  return transaction(async tx => {
    const {ident, task, item, current} = await currentAttempt(tx, principal, body.identity);
    if (!current || item.metadata?.deviceHeld !== true || task.metadata?.workflow !== WORKFLOW) fail('STALE_ATTEMPT');
    // The keyword is the item's, never the phone's: it scopes the judgement.
    return {ident, keyword: item.keyword, enabled: mobileRelevancePrefilterEnabled(task.metadata?.planSnapshot)};
  });
}

function judgement(card, item) {
  if (!item) return {cardId: card.cardId, status: 'model_error', modelDecision: null, tenantRelevance: null,
    confidence: null, protectedSignal: false, executionDisposition: 'collect_full', reason: 'AI 未返回该卡片，按原流程打开'};
  const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence) ? item.confidence : null;
  const word = (value, max = 40) => typeof value === 'string' ? value.slice(0, max) : null;
  return {cardId: card.cardId, status: word(item.status) || 'model_error', modelDecision: word(item.modelDecision),
    tenantRelevance: word(item.tenantRelevance), confidence, protectedSignal: item.protectedSignal === true,
    executionDisposition: word(item.executionDisposition, 80) || 'collect_full',
    reason: typeof item.reason === 'string' ? truncateWellFormed(item.reason, REASON_MAX) : ''};
}

// One answer per request card, in request order. A missing or repeated id is
// answered as unjudged so the phone opens that card.
export function mapPrefilterItems(cards, items) {
  const byId = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = item?.itemId;
    byId.set(key, byId.has(key) ? null : item);
  }
  return cards.map(card => judgement(card, byId.get(card.cardId)));
}

export async function prefilterCards({transaction, prefilter}, principal, body) {
  const {requestId, cards} = prefilterInput(body);
  const {ident, keyword, enabled} = await verifyAttempt(transaction, principal, body);
  if (!enabled) return {enabled: false, degraded: false, items: []};
  // externalId stays '' so the service never touches records.business_visibility:
  // a card is not a record yet. The card id is content-derived, so the service
  // cache still recognises the same card in a later run.
  const result = await prefilter({tenantId: principal.tenantId, body: {
    requestId, idempotencyKey: `android:${ident.attemptId}:${requestId}`, platform: 'douyin', stage: 'list', keyword,
    promptVersion: PREFILTER_PROMPT_VERSION, mode: 'conservative', skipThreshold: 0.97,
    taskId: ident.taskId, runId: ident.discoveryRunId, keywordRunId: ident.itemId,
    items: cards.map(c => ({itemId: c.cardId, externalId: '', title: c.title, author: c.author, noteType: '', publishTime: ''})),
  }});
  const items = mapPrefilterItems(cards, result?.items);
  return {enabled: true, degraded: result?.degraded === true || items.some(item => item.status !== 'ok'), items};
}
