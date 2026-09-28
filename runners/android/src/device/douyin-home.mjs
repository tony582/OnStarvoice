import {DeviceError, throwIfAborted} from './bounded.mjs';
import {assertDouyinScreen} from './douyin-readiness.mjs';
import {byId, resource, readDetail, searchEntryNodes} from './douyin-profile.mjs';

export const HOME_PARK_MAX_BACKS = 6;
const homeButtons = tree => byId(tree, '0p3').filter(node => node.attributes['content-desc'] === '首页，按钮');
// Search/profile controls can be shared by other tabs. Positive Home selection is mandatory;
// devices that do not expose this marker remain unverified until calibrated on the physical phone.
export const isDouyinHome = tree => searchEntryNodes(tree).length === 1
  && byId(tree, '0p3').filter(node => node.attributes['content-desc'] === '我，按钮').length === 1
  && byId(tree, 'et_search_kw').length === 0
  && homeButtons(tree).length === 1 && homeButtons(tree)[0].attributes.selected === 'true';
const knownReturnPage = tree => byId(tree, 'et_search_kw').length === 1
  || byId(tree, 'vl3').length === 1 || readDetail(tree) !== null;

/** Uses an existing session only. Unknown screens, challenge walls and unreadable trees are left untouched. */
export async function parkDouyinHome({ui, signal, beforeAction, now = Date.now}) {
  const guard = () => { throwIfAborted(signal); beforeAction(); };
  const read = async () => {
    guard();
    const tree = await ui.read({signal});
    guard();
    assertDouyinScreen(tree);
    return tree;
  };
  let tree = await read();
  let backPresses = 0;
  while (!isDouyinHome(tree)) {
    if (homeButtons(tree).length === 1) {
      guard();
      await ui.clickXPath(`//*[@resource-id='${resource('0p3')}' and @content-desc='首页，按钮']`, {signal});
      tree = await read();
      if (!isDouyinHome(tree)) throw new DeviceError('home_not_verified', 'Home feed markers were not confirmed');
      break;
    }
    if (!knownReturnPage(tree)) throw new DeviceError('home_path_unverified', 'The current screen has no calibrated return path');
    if (backPresses >= HOME_PARK_MAX_BACKS) throw new DeviceError('home_back_limit', 'Home return exceeded its navigation limit');
    guard();
    await ui.back({signal});
    backPresses++;
    tree = await read();
  }
  guard();
  return {parked: true, reason: 'home_verified', verifiedAt: new Date(now()).toISOString(),
    evidence: 'home_selected_search_and_profile', backPresses};
}
