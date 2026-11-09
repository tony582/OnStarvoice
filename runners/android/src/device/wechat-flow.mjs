import {DeviceError, throwIfAborted} from './bounded.mjs';
import {pause} from './ui-wait.mjs';
import {UNICODE_IME} from './adb-screen.mjs';
import {ACTIVITY, MAIN_TABS, MORE_VIDEOS_SHIFT, POINT, REGION, SEARCH_FILTERS, SWIPE, WECHAT_MAIN, WECHAT_SCHEME_ENTRY, feedLink}
  from './wechat-profile.mjs';
import {commentButton, filterButton, findText, findWord, forwardEntry, forwardToastSeen, isResultsPage, parseResultCards, pickerMatch,
  pickerSearch, sendConfirmation, sheetOption} from './wechat-ocr-parse.mjs';
import {readCommentPanel} from './wechat-comment-reader.mjs';

export const SHARE_LINK = /^https:\/\/weixin\.qq\.com\/sph\/[A-Za-z0-9_-]{4,40}$/u;
const KEY = Object.freeze({moveEnd: 123, del: 67});
const SORTS = new Set(['all', 'latest', 'hot']);
const settled = (code, message, details = {}) => new DeviceError(code, message, {deviceSettled: true, ...details});

// The keyword sort read back from the first results: with 最新 the visible cards' ages never decrease.
export function agesAscending(cards) {
  const ages = cards.map(card => card.age?.minHours).filter(Number.isFinite);
  if (ages.length < 3) return true;
  return ages.every((age, index) => index === 0 || age + 0.5 >= ages[index - 1]);
}

/**
 * The WeChat Channels search flow on one phone, adb and OCR only. Every method finishes with the phone on a
 * known screen (or throws with deviceSettled once nothing is in flight). `rememberIme` persists the owner's input
 * method before the Unicode keyboard is selected, so a crash in between can be repaired by the next probe.
 */
export function createWechatFlow({screen, view, rememberIme = () => {}, restoreIme = null, now = Date.now}) {
  let context = null;
  const requireContext = () => {
    if (!context) throw settled('search_context_unverified', 'No verified Channels search');
    return context;
  };
  // `box` is the field to focus first (the Channels search box by default); the text replaces what it holds.
  const typeKeyword = async (keyword, signal, box = POINT.searchBox) => {
    let original = await screen.defaultIme({signal});
    if (original === UNICODE_IME) original = restoreIme;
    if (!original || original.startsWith('io.appium.settings/')) throw settled('input_method_unknown', 'The phone keyboard to restore is unknown');
    rememberIme(original);
    await screen.tap(box.x, box.y, {signal});
    await pause(400, signal);
    await screen.key(KEY.moveEnd, {signal});
    await screen.key(KEY.del, {repeat: 40, signal});
    await screen.enableIme(UNICODE_IME, {signal});
    await screen.setIme(UNICODE_IME, {signal});
    try {
      await pause(400, signal);
      await screen.typeUnicode(keyword, {signal});
      await pause(400, signal);
    } finally {
      // The owner's keyboard comes back even when typing failed or was stopped.
      await screen.setIme(original, {timeoutMs: 5000});
      await screen.disableIme(UNICODE_IME, {timeoutMs: 5000});
    }
  };
  const resultsPage = async (keyword, signal, attempts = 4) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const rows = await view.look({signal});
      if (isResultsPage(rows, keyword)) return {rows, cards: parseResultCards(rows, {now: now()})};
      await pause(900, signal);
    }
    throw settled('search_context_unverified', 'The keyword results page was not confirmed');
  };
  // A re-sorted or re-filtered list loads after the page itself: give late cards a few more readings.
  const settledResults = async (keyword, signal) => {
    let page = await resultsPage(keyword, signal);
    for (let wait = 0; wait < 3 && !page.cards.length; wait++) { await pause(1200, signal); page = await resultsPage(keyword, signal); }
    return page;
  };
  // 时长 / 范围: button → bottom sheet (its title confirms it) → option; the button must then show the option.
  const pickFilter = async (kind, key, keyword, signal) => {
    const filter = SEARCH_FILTERS[kind];
    const button = filterButton(await view.look({signal, roi: REGION.filterRow}), filter);
    if (!button) throw settled('filter_unverified', `The ${filter.button} button was not found`, {filter: kind});
    if (button.shows !== key) {
      await screen.tap(button.center.x, button.center.y, {signal});
      await pause(1300, signal);
      const option = sheetOption(await view.look({signal, roi: REGION.filterSheet}), filter, key);
      if (!option) throw settled('filter_unverified', `The ${filter.button} sheet or its option was not confirmed`, {filter: kind});
      await screen.tap(option.center.x, option.center.y, {signal});
      await pause(2200, signal);
      if (filterButton(await view.look({signal, roi: REGION.filterRow}), filter)?.shows !== key) {
        throw settled('filter_unverified', `The ${filter.button} choice did not take effect`, {filter: kind});
      }
    }
    return settledResults(keyword, signal);
  };
  const flow = {
    /** Main screen (logged in) → 发现 → 视频号 → search → keyword → 视频 tab → sort. Returns the first results. */
    async search({keyword, sort = 'latest', duration = 'all', scope = 'all', signal}) {
      context = null;
      if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 60 || !SORTS.has(sort)
        || !(duration === 'all' || Object.hasOwn(SEARCH_FILTERS.duration.options, duration))
        || !(scope === 'all' || Object.hasOwn(SEARCH_FILTERS.scope.options, scope))) {
        throw settled('unsupported_search', 'Unsupported Channels keyword, sort or filter');
      }
      throwIfAborted(signal);
      await screen.launch(WECHAT_MAIN, {clearTop: true, signal});
      await view.waitFor(ACTIVITY.main, {signal});
      // The main screen can still be sliding in when it takes focus: read the tab bar a few times.
      let rows = [];
      for (let attempt = 0; attempt < 4 && !MAIN_TABS.every(tab => findText(rows, tab).length); attempt++) {
        if (attempt) await pause(700, signal);
        rows = await view.look({signal, roi: REGION.bottomTabs});
      }
      if (!MAIN_TABS.every(tab => findText(rows, tab).length)) throw settled('login_state_unverified', 'WeChat main tabs are not visible');
      await screen.tap(findText(rows, '发现')[0].center.x, findText(rows, '发现')[0].center.y, {signal});
      await pause(1200, signal);
      rows = await view.look({signal});
      const entry = findText(rows, '视频号', {region: {y0: 200, y1: 1600, x1: 500}})[0];
      if (!entry) throw settled('channels_entry_missing', 'The 视频号 entry is not on the 发现 page');
      await screen.tap(entry.center.x, entry.center.y, {signal});
      await view.waitFor(ACTIVITY.channelsHome, {signal, timeoutMs: 8000});
      await pause(800, signal);
      await screen.tap(POINT.channelsSearch.x, POINT.channelsSearch.y, {signal});
      await view.waitFor(ACTIVITY.search, {signal});
      await pause(700, signal);
      await typeKeyword(keyword, signal);
      rows = await view.look({signal, roi: [600, 90, 480, 150]});
      const submit = findText(rows, '搜索', {region: {y0: 90, y1: 240, x0: 700}})[0];
      if (!submit) throw settled('search_submit_missing', 'The search button was not found');
      await screen.tap(submit.center.x, submit.center.y, {signal});
      await pause(1800, signal);
      let page = await resultsPage(keyword, signal);
      const tab = findWord(page.rows, '视频', {region: {y0: 240, y1: 350, x1: 400}})[0];
      if (!tab) throw settled('video_tab_missing', 'The 视频 results tab was not found');
      await screen.tap(tab.center.x, tab.center.y, {signal});
      await pause(1500, signal);
      let sorted = false;
      for (let tries = 0; tries < 2 && !sorted; tries++) {
        await screen.tap(POINT.sort[sort].x, POINT.sort[sort].y, {signal});
        await pause(2000, signal);
        page = await settledResults(keyword, signal);
        sorted = sort !== 'latest' || agesAscending(page.cards);
      }
      if (!sorted) throw settled('sort_unverified', 'The newest-first order was not confirmed on the results');
      // The App's own 时长 / 范围 choices, each confirmed on its button before the results are read again.
      for (const [kind, key] of [['duration', duration], ['scope', scope]]) {
        if (key !== 'all') page = await pickFilter(kind, key, keyword, signal);
      }
      if (sort === 'latest' && !agesAscending(page.cards)) throw settled('sort_unverified', 'The newest-first order was lost after filtering');
      context = {keyword, sort, verifiedAt: now()};
      return {verified: true, keyword, sort, duration, scope, cards: page.cards,
        sortVerified: sort === 'latest' ? (page.cards.length >= 3 ? 'ascending_ages' : 'too_few_cards') : 'tapped'};
    },
    async readCards({signal}) {
      const {keyword} = requireContext();
      return (await resultsPage(keyword, signal, 2)).cards;
    },
    /** One tap on the card's thumbnail; the work page must take focus. */
    async openCard({card, signal}) {
      requireContext();
      await screen.tap(card.tap.x, card.tap.y, {signal});
      try { await view.waitFor(ACTIVITY.detail, {signal, timeoutMs: 6000}); }
      catch (error) {
        if (error.code === 'screen_unverified' && error.observed === ACTIVITY.search.split('.').pop()) throw settled('card_open_failed', 'The card did not open');
        throw error;
      }
      await pause(900, signal);
      return {opened: true};
    },
    /** 转发 → second row to its end → 复制链接 (located by OCR) → a fresh share link in the clipboard. */
    async copyLink({signal}) {
      const before = await screen.readClipboard({signal});
      await screen.tap(POINT.share.x, POINT.share.y, {signal});
      await pause(1200, signal);
      await screen.swipe(...SWIPE.shareRow2, {signal});
      await pause(700, signal);
      const rows = await view.look({signal, roi: REGION.shareSheet});
      const copy = findText(rows, '复制链接', {region: {y0: 1850, y1: 2060}})[0];
      if (!copy || !findText(rows, '转发给朋友').length) {
        await screen.back({signal});
        throw settled('share_sheet_unverified', 'The share sheet or its 复制链接 entry was not confirmed');
      }
      await screen.tap(copy.center.x, copy.center.y, {signal});
      await pause(900, signal);
      await view.waitFor(ACTIVITY.detail, {signal, timeoutMs: 3000});
      const after = (await screen.readClipboard({signal}))?.trim() ?? '';
      if (!SHARE_LINK.test(after) || after === before?.trim()) throw settled('link_not_copied', 'No fresh share link was copied');
      return {shareUrl: after};
    },
    /** Comment panel open → read → closed again; the work page is in front afterwards. */
    async readComments({limit, expandLimit = 3, signal}) {
      // The bar moves up when WeChat adds its 「更多视频」 strip: find it on the screen before tapping.
      const bar = commentButton(await view.look({signal, roi: REGION.workBar}), {fallback: POINT.comments, shift: MORE_VIDEOS_SHIFT});
      await screen.tap(bar.x, bar.y, {signal});
      await pause(1500, signal);
      try { return await readCommentPanel({screen, view, limit, expandLimit, signal}); }
      finally {
        await screen.back({timeoutMs: 5000});
        await pause(700);
      }
    },
    /** Open one post straight from its export id (negative patrol); the work page must take focus. */
    async openPost({exportId, signal}) {
      context = null;
      throwIfAborted(signal);
      await screen.openLink(WECHAT_SCHEME_ENTRY, feedLink(exportId), {signal});
      await view.waitFor(ACTIVITY.detail, {signal, timeoutMs: 8000});
      await pause(1200, signal);
      return {opened: true};
    },
    /**
     * 「发到微信」 on the open work page: 转发 → 转发给朋友 → search the contact → its exact row → the 「发送给：<name>」 sheet →
     * 发送. Nothing is sent unless that sheet names the contact; any mismatch backs out to the work page first. Returns
     * whether WeChat's 「已发送」 toast was seen afterwards.
     */
    async forwardPost({recipient, signal}) {
      const leave = async () => {
        for (let presses = 0; presses < 5; presses++) {
          const current = await view.activity({signal: undefined});
          if (current.activity === ACTIVITY.detail) return;
          await screen.back({timeoutMs: 5000});
          await pause(800);
        }
      };
      await view.waitFor(ACTIVITY.detail, {signal, timeoutMs: 3000});
      const share = commentButton(await view.look({signal, roi: REGION.workBar}), {fallback: POINT.share, shift: MORE_VIDEOS_SHIFT});
      await screen.tap(share.x, share.y, {signal});
      await pause(1200, signal);
      const entry = forwardEntry(await view.look({signal, roi: REGION.shareSheet}));
      if (!entry) { await screen.back({signal}); throw settled('share_sheet_unverified', 'The share sheet or its 转发给朋友 entry was not confirmed'); }
      await screen.tap(entry.x, entry.y, {signal});
      try {
        await view.waitFor(ACTIVITY.chooseContact, {signal, timeoutMs: 6000});
        await pause(800, signal);
        const search = pickerSearch(await view.look({signal}));
        if (!search) throw settled('forward_picker_unverified', 'The chat picker search was not found');
        await typeKeyword(recipient, signal, search.center);
        await pause(1500, signal);
        const match = pickerMatch(await view.look({signal}), recipient);
        if (!match) throw settled('forward_recipient_not_found', 'No contact with exactly that name');
        await screen.tap(match.center.x, match.center.y, {signal});
        await view.waitFor(ACTIVITY.sendConfirm, {signal, timeoutMs: 5000, allowPicker: true});
        await pause(700, signal);
        const sheet = sendConfirmation(await view.look({signal}), recipient);
        if (!sheet.confirmed) {
          if (sheet.cancel) await screen.tap(sheet.cancel.center.x, sheet.cancel.center.y, {signal});
          throw settled('forward_confirm_unverified', 'The send sheet did not name that contact');
        }
        await screen.tap(sheet.send.center.x, sheet.send.center.y, {signal});
      } catch (error) {
        await leave();
        throw error;
      }
      // Sent from here on: no error may make the caller try again. The toast stays about two seconds: look at once,
      // then a few more times (the first production forward on 2026-11-09 was sent but its toast was missed).
      let toast = false;
      for (let look = 0; look < 5 && !toast; look++) {
        if (look) await pause(400);
        try { toast = forwardToastSeen(await view.look({roi: REGION.workBar})); } catch { /* the toast only confirms */ }
      }
      try { await leave(); } catch { /* parking returns to the main screen anyway */ }
      return {sent: true, confirmed: toast};
    },
    async returnToResults({signal}) {
      const {keyword} = requireContext();
      await view.waitFor(ACTIVITY.detail, {signal, timeoutMs: 3000});
      await screen.back({signal});
      await view.waitFor(ACTIVITY.search, {signal});
      await pause(600, signal);
      return (await resultsPage(keyword, signal, 3)).cards;
    },
    /**
     * After a failed card: back to the same keyword's results without opening anything. Back is pressed only on
     * the work page or a sheet over it (at most 3 times), never on the search screen itself, where it would leave
     * the keyword's results.
     */
    async recoverResults({signal}) {
      const {keyword} = requireContext();
      for (let presses = 0; ; presses++) {
        const current = await view.activity({signal});
        if (current.activity === ACTIVITY.search) break;
        if (presses >= 3 || current.activity !== ACTIVITY.detail) {
          throw settled('search_context_unverified', 'Could not return to the keyword results', {backPresses: presses});
        }
        await screen.back({signal});
        await pause(900, signal);
      }
      return (await resultsPage(keyword, signal, 3)).cards;
    },
    async scroll({signal}) {
      requireContext();
      await screen.swipe(...SWIPE.results, {signal});
      await pause(1300, signal);
      return {scrolled: true};
    },
    async parkHome({signal}) {
      context = null;
      await screen.launch(WECHAT_MAIN, {clearTop: true, signal});
      await view.waitFor(ACTIVITY.main, {signal});
      return {parked: true, reason: 'wechat_main', verifiedAt: new Date(now()).toISOString()};
    },
    reset() { context = null; },
  };
  return flow;
}
