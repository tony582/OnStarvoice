import {DeviceError} from './bounded.mjs';
import {byId, resource, appNodes, searchEntryNodes} from './douyin-profile.mjs';
import {pause} from './ui-wait.mjs';

export function assertDouyinScreen(tree) {
  const nodes = appNodes(tree);
  if (!nodes.length) throw new DeviceError('douyin_not_foreground', 'Douyin must be in the foreground');
  if (nodes.some(node => ['安全验证','请完成下列验证','请完成验证','点击登录','登录后查看更多'].includes(node.attributes.text))) {
    throw new DeviceError('login_or_challenge_required', 'Login or verification requires the device owner');
  }
}

// A previous keyword can leave Douyin on a screen whose hierarchy the parser rejects (seen on a
// search results page, 2026-09-26). Reading it again would fail every later keyword in seconds,
// so step back out of it a bounded number of times before giving up.
export const UNREADABLE_SCREEN_BACKS = 3;

// The screen a keyword starts on is the home feed, and reading it is slow on this phone. Measured on
// DE106 (2026-10-02): a hierarchy read takes 2 to 6 s depending on the feed item, an element lookup
// about as long, and some items do not finish within the 10 s read bound at all. A lookup had 5 s, so
// a keyword that started on a slow item failed at its first tab click, and so did every keyword after
// it, because nothing moved the feed (15 in a row at 12:16). While the first read stays slow the feed
// is moved on, a bounded number of times and for a bounded time; after that the check carries on with
// what it has. Only the first read does this: later screens are ones this check opened itself.
export const SLOW_FEED_READ_MS = 4000;
export const UNREADABLE_FEED_SKIPS = 3;
export const FEED_SKIP_BUDGET_MS = 25_000;
export const FEED_SETTLE_MS = 1200;
// The tab clicks of this check look an element up by XPath, which needs the same hierarchy dump as a read.
const LOOKUP_TIMEOUT_MS = 10_000;

// A positive own-profile marker is required. Search results alone do not prove login.
export async function verifyLoginAndSearchEntry(ui, {signal, skipFeedItem = null, feedSettleMs = FEED_SETTLE_MS,
  slowReadMs = SLOW_FEED_READ_MS, now = () => performance.now()} = {}) {
  const options = {signal};
  const lookup = {signal, timeoutMs: LOOKUP_TIMEOUT_MS};
  let unreadableBacks = 0, feedSkips = 0;
  const read = async () => {
    while (true) {
      try { return await ui.read(options); }
      catch (error) {
        if (error?.code !== 'invalid_ui_source') throw error;
        if (unreadableBacks >= UNREADABLE_SCREEN_BACKS) { error.backPresses = unreadableBacks; throw error; }
        unreadableBacks++;
        await ui.back(options);
      }
    }
  };
  const startedAt = now();
  const readStartingScreen = async () => {
    while (true) {
      const readStartedAt = now();
      let tree = null, timedOut = null;
      try { tree = await read(); }
      catch (error) { if (error?.code !== 'device_timeout') throw error; timedOut = error; }
      const slow = timedOut !== null || now() - readStartedAt >= slowReadMs;
      let moved = false;
      if (slow && skipFeedItem && feedSkips < UNREADABLE_FEED_SKIPS && now() - startedAt < FEED_SKIP_BUDGET_MS) {
        // A failed skip must not hide the timeout that led to it.
        try { moved = await skipFeedItem(options) === true; } catch { moved = false; }
      }
      if (!moved) {
        if (!timedOut) return tree;
        if (feedSkips) timedOut.feedSkips = feedSkips;
        throw timedOut;
      }
      feedSkips++;
      await pause(feedSettleMs, signal);
    }
  };
  let tree = await readStartingScreen();
  const ownProfile = tree => byId(tree,'504').some(node => /^抖音号[：:]\s*\S+/u.test(node.attributes.text || ''))
    && byId(tree,'whh').some(node => node.attributes.text === '编辑主页');
  const profileTab = tree => byId(tree,'0p3').some(node => node.attributes['content-desc'] === '我，按钮');
  for (let step=0; step<6 && !ownProfile(tree) && !profileTab(tree); step++) {
    assertDouyinScreen(tree);
    await ui.back(options); tree = await read();
  }
  if (!ownProfile(tree)) {
    if (!profileTab(tree)) throw new DeviceError('login_state_unverified', 'Own profile is not reachable');
    await ui.clickXPath(`//*[@resource-id='${resource('0p3')}' and @content-desc='我，按钮']`,lookup);
    tree = await ui.waitFor(ownProfile,options);
  }
  if (!ownProfile(tree)) throw new DeviceError('login_required','Own profile was not confirmed');
  await ui.clickXPath(`//*[@resource-id='${resource('0p3')}' and @content-desc='首页，按钮']`,lookup);
  await ui.waitFor(tree => searchEntryNodes(tree).length === 1 || byId(tree,'et_search_kw').length === 1,options);
  return {loggedIn:true, challenge:false, ...(feedSkips ? {feedSkips} : {})};
}
