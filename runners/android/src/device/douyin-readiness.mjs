import {DeviceError} from './bounded.mjs';
import {byId, resource, appNodes, searchEntryNodes} from './douyin-profile.mjs';

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

// A positive own-profile marker is required. Search results alone do not prove login.
export async function verifyLoginAndSearchEntry(ui, {signal} = {}) {
  const options = {signal};
  let unreadableBacks = 0;
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
  return {loggedIn:true, challenge:false};
}
