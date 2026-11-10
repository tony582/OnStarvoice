import {DeviceError, throwIfAborted} from './bounded.mjs';
import {pause} from './ui-wait.mjs';
import {UNICODE_IME} from './adb-screen.mjs';
import {ACTIVITY, MAIN_TABS, WECHAT_MAIN} from './wechat-profile.mjs';
import {comparable, findText} from './wechat-ocr-parse.mjs';
import {ARTICLE_ACTIVITIES, ARTICLE_LANDING, ARTICLE_SEARCH, ARTICLE_LINK, articleSortTarget, articleBodyRows, footerEvidence, isArticleResults,
  parseArticleCards, parseArticleHeader, sameArticleTitle, cardMatchesHeader, resultsTop, findTab, hasArticleTabs} from './wechat-article-parse.mjs';
import {createArticleReader} from './wechat-article-reader.mjs';
const fail = (code, message, details = {}) => new DeviceError(code, message, {deviceSettled: true, ...details});
const HAZARDS = [ACTIVITY.chooseChat, ACTIVITY.chooseContact, ACTIVITY.sendConfirm, 'com.tencent.mm.ui.chatting.ChattingUI'];
const latestOrder = cards => cards.map(card => card.age?.minHours).filter(Number.isFinite)
  .every((age, i, all) => i === 0 || age + 0.5 >= all[i - 1]);

export function createWechatArticleFlow({screen, view, rememberIme = () => {}, restoreIme = null, now = Date.now, wait = pause}) {
  let context = null, currentCard = null, reader = null, opening = null, currentHeader = null, copiedArticleUrl = null, readerBodyRequired = null;
  const assertPage = async (wanted, {signal} = {}) => {
    throwIfAborted(signal);
    let current;
    for (let attempt = 0; attempt < 13; attempt++) {
      throwIfAborted(signal); current = await view.activity({signal});
      if (current.activity !== 'com.tencent.mm.plugin.webview.stub.WebViewStubProxyUI' || attempt === 12) break;
      await wait(250, signal);
    }
    if (HAZARDS.includes(current.activity)) {
      await screen.back({signal});
      throw fail('unexpected_screen', 'WeChat entered a chat or send confirmation; the article operation stopped');
    }
    if (current.package !== 'com.tencent.mm' || ![wanted].flat().includes(current.activity)) {
      throw fail('screen_unverified', 'The expected WeChat article screen is not in front', {observed: current.activity});
    }
    return current;
  };
  const waitFor = async (wanted, {signal, timeoutMs = 7000} = {}) => {
    const deadline = now() + timeoutMs;
    while (true) {
      try { return await assertPage(wanted, {signal}); }
      catch (error) { if (error.code !== 'screen_unverified' || now() >= deadline) throw error; }
      await wait(250, signal);
    }
  };
  // Do not apply the Channels reader's broad body-text challenge detector to articles. A paragraph mentioning
  // "安全验证" or "发送给" is untrusted article content, never a device instruction.
  const look = async options => {
    const shot = await view.capture(options); const rows = (await shot.text).rows;
    const oneStep = rows.find(row => row.y >= 250 && row.y < 500 && row.x > 300 && row.x < 800);
    const shiftedStatus = rows.some(row => row.x > 240 && row.y > 550 && row.y < 650 && /^\d{1,2}[:：]\d{2}/u.test(row.text));
    if (oneStep && (/^One Step$/iu.test(oneStep.text.trim()) || shiftedStatus)
      && rows.some(row => row.x < 110 && Math.abs(row.y - oneStep.y) < 65)
      && rows.some(row => row.x > 900 && Math.abs(row.y - oneStep.y) < 65)) {
      throw fail('system_overlay_blocked', 'The phone system One Step overlay must be closed before article collection');
    }
    return rows;
  };
  const tap = async (target, allowed, signal) => {
    await assertPage(allowed, {signal}); await screen.tap(Math.round(target.center?.x ?? target.x), Math.round(target.center?.y ?? target.y), {signal});
  };
  const requireContext = ({pending = false} = {}) => {
    if (!context || (!pending && context.verified !== true)) throw fail('search_context_unverified', 'No verified article search');
    return context;
  };
  const results = async (signal, attempts = 4, {scrolledOk = true} = {}) => {
    const {keyword, verified} = requireContext({pending: !scrolledOk});
    for (let i = 0; i < attempts; i++) {
      await assertPage(ARTICLE_SEARCH, {signal});
      const rows = await look({signal});
      if (isArticleResults(rows, keyword, {controlledInput: true, scrolledOk: scrolledOk && verified === true})) return {rows, cards: parseArticleCards(rows, {now: now(), top: resultsTop(rows)})};
      await wait(850, signal);
    }
    throw fail('search_context_unverified', 'The article tab and keyword were not confirmed');
  };
  const typeKeyword = async (keyword, box, signal) => {
    let original = await screen.defaultIme({signal});
    if (original === UNICODE_IME) original = restoreIme;
    if (!original || original.startsWith('io.appium.settings/')) throw fail('input_method_unknown', 'The phone keyboard to restore is unknown');
    rememberIme(original);
    await tap(box, ARTICLE_SEARCH, signal);
    await wait(300, signal);
    await screen.key(123, {signal}); await screen.key(67, {repeat: 80, signal});
    await screen.enableIme(UNICODE_IME, {signal}); await screen.setIme(UNICODE_IME, {signal});
    try { await wait(300, signal); await screen.typeUnicode(keyword, {signal}); await wait(350, signal); }
    finally { await screen.setIme(original, {timeoutMs: 5000}); await screen.disableIme(UNICODE_IME, {timeoutMs: 5000}); }
  };
  const submitQuery = async (keyword, signal) => {
    await screen.launch(WECHAT_MAIN, {clearTop: true, signal}); await waitFor(ACTIVITY.main, {signal});
    let rows = [];
    for (let i = 0; i < 4; i++) {
      rows = await look({signal});
      if (MAIN_TABS.every(label => findText(rows, label, {region: {y0: 2050, y1: 2242}}).length)) break;
      await wait(700, signal);
    }
    const discover = findText(rows, '发现', {region: {y0: 2050, y1: 2242}})[0];
    if (!discover || !MAIN_TABS.every(label => findText(rows, label).length)) throw fail('login_state_unverified', 'WeChat main tabs are not visible');
    await tap(discover, ACTIVITY.main, signal); await wait(900, signal); rows = await look({signal});
    const entry = findText(rows, '搜一搜', {region: {y0: 250, y1: 1800, x1: 500}})[0];
    if (!entry) throw fail('article_entry_missing', 'The 搜一搜 entry was not found');
    await tap(entry, ACTIVITY.main, signal); await waitFor([ARTICLE_LANDING, ARTICLE_SEARCH], {signal}); await wait(900, signal);
    rows = await look({signal});
    if ((await view.activity({signal})).activity === ARTICLE_LANDING) {
      const field = findText(rows, '搜索', {region: {y0: 300, y1: 800, x1: 850}})[0]
        ?? findText(rows, '搜索或提问', {region: {y0: 200, y1: 800, x1: 850}})[0];
      if (!field) throw fail('search_box_missing', 'The 搜一搜 search field was not found');
      await tap(field, ARTICLE_LANDING, signal); await waitFor(ARTICLE_SEARCH, {signal}); await wait(600, signal);
      rows = await look({signal});
    }
    let field;
    for (let attempt = 0; attempt < 5; attempt++) {
      field = rows.find(row => row.y > 90 && row.y < 240 && row.x > 90 && row.x < 700 && row.w >= 80);
      if (field) break;
      await wait(700, signal); await assertPage(ARTICLE_SEARCH, {signal}); rows = await look({signal});
    }
    if (!field) throw fail('search_box_missing', 'The article keyword field was not found');
    await typeKeyword(keyword, {x: field.x + Math.min(field.w / 2, 250), y: field.y + field.h / 2}, signal);
    rows = await look({signal});
    const submit = findText(rows, '搜索', {region: {y0: 90, y1: 380, x0: 700}})[0];
    if (!submit) throw fail('search_submit_missing', 'The search button was not found');
    await tap(submit, ARTICLE_SEARCH, signal); await wait(1800, signal);
  };
  const seekHeader = async (signal, budgetMs = 30000) => {
    const deadline = now() + Math.min(30000, Math.max(1000, budgetMs));
    // Read articles reopen at their remembered position. Short gestures bound each movement;
    // continuation calls keep seeking this same article without reopening it.
    for (let attempt = 0; attempt < 8; attempt++) {
      await assertPage(ARTICLE_ACTIVITIES, {signal});
      const articleRows = await look({signal}); opening.readings++;
      const header = parseArticleHeader(articleRows, {card: opening.card});
      if (opening.swipes >= 80 || opening.readings >= 100) {
        opening = null; await screen.back({signal}); throw fail('article_header_unverified', 'The actual article header could not be reached within the bounded scan');
      }
      if (header.headerVerified) {
        const bodyReady = articleBodyRows(articleRows, {first: true, header}).length > 0 || !!footerEvidence(articleRows).read;
        const candidate = opening.headerCandidate;
        if (!bodyReady || !candidate || !sameArticleTitle(candidate.title, header.title)
          || !sameArticleTitle(candidate.account, header.account) || Math.abs(candidate.bodyTop - header.bodyTop) > 30) {
          opening.headerCandidate = bodyReady ? header : null;
          if (now() >= deadline - 2500) break;
          await wait(650, signal); continue;
        }
        const actual = opening.card; opening = null;
        if (actual && !cardMatchesHeader(actual, header)) {
          await screen.back({signal}); throw fail('article_identity_unverified', 'The visible article title or account did not match the result');
        }
        currentCard = actual ?? {title: header.title, snippet: header.title, account: header.account, author: header.account}; currentHeader = header; return {opened: true, hasMore: false, title: header.title};
      }
      opening.headerCandidate = null;
      if (now() >= deadline - 3500) break;
      if (articleRows.filter(row => row.y > 200 && row.y < 2080).length >= 3) {
        await assertPage(ARTICLE_ACTIVITIES, {signal}); await screen.swipe(540, 900, 540, 1400, 1100, {signal}); opening.swipes++;
      }
      await wait(600, signal);
    }
    return {opened: false, hasMore: true, headerScrolls: opening.swipes};
  };
  const flow = {
    async search({keyword, sort = 'latest', scope = 'all', duration = 'all', signal}) {
      flow.reset();
      if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 60 || !['all', 'latest', 'hot'].includes(sort)
        || scope !== 'all' || duration !== 'all') throw fail('unsupported_search', 'Article collection currently supports all accounts and all/latest/hot sorting');
      await submitQuery(keyword, signal);
      let articleTab, emptyWaits = 0, tabSwipes = 0;
      while (true) {
        await assertPage(ARTICLE_SEARCH, {signal});
        const rows = await look({signal}); articleTab = findTab(rows, '文章');
        if (articleTab) break;
        // A blank first paint is not evidence that the tab is offscreen. Wait before any horizontal gesture.
        if (!hasArticleTabs(rows)) {
          if (emptyWaits++ >= 4) break;
          await wait(800, signal); continue;
        }
        if (tabSwipes >= 4) break;
        await assertPage(ARTICLE_SEARCH, {signal});
        const left = tabSwipes++ < 2;
        await screen.swipe(left ? 920 : 290, 305, left ? 290 : 920, 305, 1000, {signal}); await wait(700, signal);
      }
      if (!articleTab) throw fail('article_tab_missing', 'The 文章 category was not found');
      await tap(articleTab, ARTICLE_SEARCH, signal); await wait(1800, signal);
      context = {keyword, sort, verified: false};
      let page = await results(signal, 4, {scrolledOk: false});
      const sortTarget = articleSortTarget(page.rows, sort);
      if (!sortTarget) throw fail('sort_unverified', 'The article sort controls were not found');
      await tap(sortTarget, ARTICLE_SEARCH, signal); await wait(2300, signal); page = await results(signal, 4, {scrolledOk: false});
      if (sort === 'latest' && !latestOrder(page.cards)) {
        await wait(1500, signal); page = await results(signal, 4, {scrolledOk: false});
        if (!latestOrder(page.cards)) throw fail('sort_unverified', 'The newest-first article order was not confirmed');
      }
      context.verified = true;
      return {verified: true, keyword, sort, scope, duration, cards: page.cards,
        sortVerified: sort === 'latest' && page.cards.length >= 3 ? 'ascending_ages' : 'control_tapped'};
    },
    async readCards({signal} = {}) { return (await results(signal)).cards; },
    async openCard({card, signal, budgetMs = 30000}) {
      requireContext();
      if (!opening) {
        reader = null; currentCard = null; currentHeader = null; copiedArticleUrl = null; readerBodyRequired = null;
        const page = await results(signal, 2);
        const actual = page.cards.find(item => item.cardKey === card.cardKey || (sameArticleTitle(item.title, card.title ?? card.snippet)
          && comparable(item.author) === comparable(card.author)));
        if (!actual) throw fail('card_open_failed', 'The selected article is no longer visible');
        await tap(actual.tap, ARTICLE_SEARCH, signal); await waitFor(ARTICLE_ACTIVITIES, {signal}); await wait(1100, signal);
        opening = {card: actual, swipes: 0, readings: 0};
      } else if (opening.card.cardKey !== card.cardKey) throw fail('article_identity_unverified', 'Another article header is still being located');
      return seekHeader(signal, budgetMs);
    },
    async openArticleLink({url, signal, budgetMs = 30000}) {
      const started = now();
      if (!ARTICLE_LINK.test(url ?? '')) throw fail('article_link_invalid', 'Only a verified WeChat article short link can be opened');
      if (!opening) {
        flow.reset(); await submitQuery(url, signal); context = {keyword: url, directLink: true};
        let target;
        for (let attempt = 0; attempt < 5; attempt++) {
          await assertPage(ARTICLE_SEARCH, {signal}); const rows = await look({signal});
          const visit = findText(rows, '访问网页', {region: {y0: 330, y1: 650, x0: 200, x1: 600}})[0];
          // OCR can read the i in weixin as l. The exact target is typed, then verified again by copyLink.
          const domain = visit && rows.some(row => row.x > 200 && row.y > visit.y && row.y < visit.y + 150
            && /^mp\.we[il]xin\.qq\.com\/s\//iu.test(row.text.trim()));
          if (visit && domain) { target = visit; break; }
          await wait(650, signal);
        }
        if (!target) throw fail('article_link_entry_unverified', 'The 访问网页 entry and WeChat article domain were not confirmed');
        await tap(target, ARTICLE_SEARCH, signal); await waitFor(ARTICLE_ACTIVITIES, {signal, timeoutMs: 10000}); await wait(900, signal);
        opening = {card: null, url, swipes: 0, readings: 0};
      } else if (opening.url !== url) throw fail('article_identity_unverified', 'A different article link is still being opened');
      return seekHeader(signal, Math.max(1000, budgetMs - (now() - started)));
    },
    async copyLink({signal} = {}) {
      copiedArticleUrl = null;
      await assertPage(ARTICLE_ACTIVITIES, {signal});
      const before = (await screen.readClipboard({signal}))?.trim();
      let rows, more;
      for (let attempt = 0; attempt < 3; attempt++) {
        await assertPage(ARTICLE_ACTIVITIES, {signal}); rows = await look({signal});
        more = rows.find(row => row.y >= 90 && row.y < 210 && row.x > 900 && /^[•·.⋯…]{2,}$/u.test(row.text.trim()));
        if (more) break;
        await wait(450, signal);
      }
      // This icon can disappear from OCR. Only a previously verified article on the calibrated profile may
      // use its measured menu location; the opened menu and every subsequent action still require labels.
      if (!more && (!currentHeader?.headerVerified || !currentCard)) throw fail('share_sheet_unverified', 'The article menu button was not found');
      await tap(more ? {x: more.x + more.w / 2, y: more.y + more.h / 2} : {x: 1000, y: 148}, ARTICLE_ACTIVITIES, signal); await wait(750, signal);
      rows = await look({signal});
      if (!findText(rows, '转发给朋友', {region: {y0: 1500, y1: 1800}}).length || !findText(rows, '取消', {region: {y0: 2080, y1: 2240}}).length) {
        await screen.back({signal}); throw fail('share_sheet_unverified', 'The article share menu was not confirmed');
      }
      await assertPage(ARTICLE_ACTIVITIES, {signal});
      await screen.swipe(900, 1850, 330, 1850, 1100, {signal}); await wait(450, signal);
      rows = await look({signal});
      const copy = findText(rows, '复制链接', {region: {y0: 1850, y1: 2050}})[0];
      if (!copy) { await screen.back({signal}); throw fail('share_sheet_unverified', 'The 复制链接 option was not found'); }
      await tap(copy, ARTICLE_ACTIVITIES, signal); await wait(200, signal);
      rows = await look({signal}); await assertPage(ARTICLE_ACTIVITIES, {signal});
      const shareUrl = (await screen.readClipboard({signal}))?.trim() ?? '';
      const fresh = shareUrl !== before || rows.some(row => /已复制到剪贴板/u.test(row.text));
      if (!ARTICLE_LINK.test(shareUrl) || !fresh) throw fail('link_not_copied', 'No verified article link was copied');
      copiedArticleUrl = shareUrl;
      return {shareUrl};
    },
    async readArticle(options = {}) {
      const started = now(); await assertPage(ARTICLE_ACTIVITIES, options);
      const bodyRequired = options.bodyRequired !== false;
      if (!bodyRequired && (!currentHeader?.headerVerified || !currentCard || !copiedArticleUrl || opening)) {
        throw fail('article_identity_unverified', 'Supplemental reading requires the verified article and a fresh copied link');
      }
      if (reader && readerBodyRequired !== bodyRequired) throw fail('article_reader_mode_mismatch', 'The current article reader mode cannot change between chunks');
      if (!reader) {
        // Link pages can restore their previous scroll position after the initial header has painted.
        // Reuse the bounded header seeker immediately before the first body screen, including after copying.
        // When the caller has a verified DOM body, continue from the current position to the footer instead.
        if (bodyRequired) {
          opening ??= {card: currentCard, swipes: 0, readings: 0};
          const ready = await seekHeader(options.signal, Math.min(20000, options.budgetMs ?? 35000));
          if (ready.hasMore) return {hasMore: true, pagesRead: 0,
            article: {...currentHeader, content: '', bodyStatus: 'partial', bodyReason: 'restoring_article_start', metrics: null},
            comments: {status: 'unknown', postingState: 'unknown', reason: 'restoring_article_start', headerCount: null, items: []}};
        }
        readerBodyRequired = bodyRequired;
        reader = createArticleReader({screen, look, assertArticle: options => assertPage(ARTICLE_ACTIVITIES, options), card: currentCard,
          initialHeader: currentHeader, bodyRequired, now, wait});
      }
      return reader.read({...options, budgetMs: Math.max(1000, (options.budgetMs ?? 35000) - (now() - started))});
    },
    async returnToResults({signal} = {}) {
      requireContext(); await assertPage(ARTICLE_ACTIVITIES, {signal}); await screen.back({signal});
      await waitFor(ARTICLE_SEARCH, {signal}); await wait(650, signal); const page = await results(signal);
      reader = null; currentCard = null; currentHeader = null; copiedArticleUrl = null; readerBodyRequired = null; return page.cards;
    },
    async recoverResults({signal} = {}) {
      requireContext(); const page = await view.activity({signal});
      if (page.activity === ARTICLE_SEARCH) return (await results(signal)).cards;
      if (ARTICLE_ACTIVITIES.includes(page.activity)) return flow.returnToResults({signal});
      await assertPage([...ARTICLE_ACTIVITIES, ARTICLE_SEARCH], {signal});
    },
    async scroll({signal} = {}) {
      await results(signal); await assertPage(ARTICLE_SEARCH, {signal});
      await screen.swipe(540, 1850, 540, 950, 1100, {signal}); await wait(900, signal);
      await results(signal); return {scrolled: true};
    },
    async parkHome({signal} = {}) {
      await screen.launch(WECHAT_MAIN, {clearTop: true, signal}); await waitFor(ACTIVITY.main, {signal});
      let rows = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        await assertPage(ACTIVITY.main, {signal}); rows = await look({signal});
        if (MAIN_TABS.every(label => findText(rows, label, {region: {y0: 2050, y1: 2242}}).length)) break;
        await wait(650, signal);
      }
      if (!MAIN_TABS.every(label => findText(rows, label, {region: {y0: 2050, y1: 2242}}).length)) throw fail('home_unverified', 'WeChat home tabs were not confirmed');
      flow.reset(); return {parked: true};
    },
    reset() { context = null; currentCard = null; reader = null; opening = null; currentHeader = null; copiedArticleUrl = null; readerBodyRequired = null; },
  };
  return flow;
}
