import {recordDiagnostic} from './diagnostics.mjs';
import {sameCard} from '../device/wechat-ocr-parse.mjs';

export const CARD_DIAGNOSTICS_KEY = 'diagnostics:cards';
export const CARD_DIAGNOSTICS_LIMIT = 3000;
// Completion stats are numeric only. The ordinary result.reason still carries the readable reason.
export const WECHAT_STOP_CODES = Object.freeze({results_end: 1, publish_window_end: 2, link_limit: 3,
  card_limit: 4, swipe_limit: 5, keyword_time_limit: 6, batch_time_limit: 7, task_deadline: 8,
  user_stop: 9, remote_stop: 9, operator_takeover: 9, lease_expired: 10, usb_disconnected: 10});

/** Private, local-only evidence. No author, caption or screen data is returned as completion statistics. */
export function createWechatCardTrace({store, task, clock}) {
  const known = [];
  let screens = 0;
  const write = entry => recordDiagnostic(store, {at: new Date(clock.wallNow()).toISOString(),
    runId: task?.identity?.discoveryRunId ?? null, itemId: task?.identity?.itemId ?? null,
    keyword: task?.keyword ?? null, ...entry}, {key: CARD_DIAGNOSTICS_KEY, limit: CARD_DIAGNOSTICS_LIMIT});
  const record = (card, disposition, extra = {}, screen = screens) => {
    const entry = known.find(item => sameCard(item.card, card));
    if (entry && !['duplicate', 'missing_on_reread'].includes(disposition)) entry.handled = true;
    write({event: 'card', screen, column: card.column ?? null, cardKey: card.cardKey,
      author: card.author ?? '', snippet: card.snippet ?? '', timeLabel: card.timeLabel ?? '',
      age: card.age ?? null, disposition, ...extra});
  };
  return {
    get screens() { return screens; },
    get cardsSeen() { return known.length; },
    observe(cards, source) {
      screens++;
      write({event: 'screen', screen: screens, source,
        rawOcrRows: cards.screenEvidence?.rawOcrRows ?? null, parsedCards: cards.length});
      for (const card of cards) {
        const previous = known.find(item => sameCard(item.card, card));
        if (previous?.handled) record(card, 'duplicate');
        else if (!previous) known.push({card, screen: screens, handled: false});
      }
      return cards;
    },
    record,
    finish(reason) {
      for (const item of known.filter(item => !item.handled)) record(item.card, 'not_opened', {reason}, item.screen);
    },
  };
}
