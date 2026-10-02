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

// The screen a keyword starts on can also be one whose hierarchy read never finishes: the home feed
// resting on an auto-advancing photo post (2026-10-02). Every later keyword then failed its first
// read within seconds. The feed is moved on a bounded number of times before giving up. Only the
// first read does this; every later screen is one this check navigated to itself.
export const UNREADABLE_FEED_SKIPS = 2;
export const FEED_SETTLE_MS = 1200;

// A positive own-profile marker is required. Search results alone do not prove login.
export async function verifyLoginAndSearchEntry(ui, {signal, skipFeedItem = null, feedSettleMs = FEED_SETTLE_MS} = {}) {
  const options = {signal};
  let unreadableBacks = 0, feedSkips = 0, nothingReadYet = true;
  const read = async () => {
    while (true) {
      try { const tree = await ui.read(options); nothingReadYet = false; return tree; }
      catch (error) {
        if (error?.code === 'device_timeout') {
          let moved = false;
          if (nothingReadYet && skipFeedItem && feedSkips < UNREADABLE_FEED_SKIPS) {
            // A failed skip must not hide the timeout that led to it.
            try { moved = await skipFeedItem(options) === true; } catch { moved = false; }
          }
          if (!moved) { if (feedSkips) error.feedSkips = feedSkips; throw error; }
          feedSkips++;
          await pause(feedSettleMs, signal);
          continue;
        }
        if (error?.code !== 'invalid_ui_source') throw error;
        if (unreadableBacks >= UNREADABLE_SCREEN_BACKS) { error.backPresses = unreadableBacks; throw error; }
        unreadableBacks++;
        await ui.back(options);
      }
    }
  };
  let tree = await read();
  const ownProfile = tree => byId(tree,'504').some(node => /^抖音号[：:]\s*\S+/u.test(node.attributes.text || ''))
    && byId(tree,'whh').some(node => node.attributes.text === '编辑主页');
  const profileTab = tree => byId(tree,'0p3').some(node => node.attributes['content-desc'] === '我，按钮');
  for (let step=0; step<6 && !ownProfile(tree) && !profileTab(tree); step++) {
    assertDouyinScreen(tree);
    await ui.back(options); tree = await read();
  }
  if (!ownProfile(tree)) {
    if (!profileTab(tree)) throw new DeviceError('login_state_unverified', 'Own profile is not reachable');
    await ui.clickXPath(`//*[@resource-id='${resource('0p3')}' and @content-desc='我，按钮']`,options);
    tree = await ui.waitFor(ownProfile,options);
  }
  if (!ownProfile(tree)) throw new DeviceError('login_required','Own profile was not confirmed');
  await ui.clickXPath(`//*[@resource-id='${resource('0p3')}' and @content-desc='首页，按钮']`,options);
  await ui.waitFor(tree => searchEntryNodes(tree).length === 1 || byId(tree,'et_search_kw').length === 1,options);
  return {loggedIn:true, challenge:false, ...(feedSkips ? {feedSkips} : {})};
}
