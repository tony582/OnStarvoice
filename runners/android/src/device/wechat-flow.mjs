import {DeviceError, throwIfAborted} from './bounded.mjs';
import {pause} from './ui-wait.mjs';
import {UNICODE_IME} from './adb-screen.mjs';
import {ACTIVITY, MAIN_TABS, MORE_VIDEOS_SHIFT, POINT, REGION, SWIPE, WECHAT_MAIN, WECHAT_SCHEME_ENTRY, feedLink} from './wechat-profile.mjs';
import {commentButton, findText, findWord, isResultsPage, parseResultCards} from './wechat-ocr-parse.mjs';
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
  const typeKeyword = async (keyword, signal) => {
    let original = await screen.defaultIme({signal});
    if (original === UNICODE_IME) original = restoreIme;
    if (!original || original.startsWith('io.appium.settings/')) throw settled('input_method_unknown', 'The phone keyboard to restore is unknown');
    rememberIme(original);
    await screen.tap(POINT.searchBox.x, POINT.searchBox.y, {signal});
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
  const flow = {
    /** Main screen (logged in) → 发现 → 视频号 → search → keyword → 视频 tab → sort. Returns the first results. */
    async search({keyword, sort = 'latest', signal}) {
      context = null;
      if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 60 || !SORTS.has(sort)) {
        throw settled('unsupported_search', 'Unsupported Channels keyword or sort');
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
      for (let tries = 0; tries < 2; tries++) {
        await screen.tap(POINT.sort[sort].x, POINT.sort[sort].y, {signal});
        await pause(2000, signal);
        page = await resultsPage(keyword, signal);
        // The re-sorted list loads after the page itself: give late cards a few more readings.
        for (let wait = 0; wait < 3 && !page.cards.length; wait++) { await pause(1200, signal); page = await resultsPage(keyword, signal); }
        if (sort !== 'latest' || agesAscending(page.cards)) {
          context = {keyword, sort, verifiedAt: now()};
          return {verified: true, keyword, sort, cards: page.cards, sortVerified: sort === 'latest' ? (page.cards.length >= 3 ? 'ascending_ages' : 'too_few_cards') : 'tapped'};
        }
      }
      throw settled('sort_unverified', 'The newest-first order was not confirmed on the results');
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
