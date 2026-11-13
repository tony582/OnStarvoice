import {DeviceError} from './bounded.mjs';

// WeChat 8.0.80 on the Smartisan DE106 (Android 8.1, 1080x2242), measured 2026-11-05. WeChat hides its UI tree from
// automation, so every target below is a fixed screen point or a text located by local OCR, and each step is
// confirmed by the focused activity (dumpsys window) before the next tap.
export const WECHAT_PROFILE = Object.freeze({
  id: 'wechat-8.0.80-de106-api27-p0', platform: 'wechat_channels', packageName: 'com.tencent.mm', version: '8.0.80',
  model: 'DE106', apiLevel: '27', screen: {width: 1080, height: 2242}, productionAccepted: false,
});
export const WECHAT_MAIN = 'com.tencent.mm/.ui.LauncherUI';
// WeChat's own entry for weixin:// links. A share link opened in the phone browser ends here with this feed link
// (logcat, 2026-11-06); started directly for user 0 it opens the post without the browser or the app-twin chooser.
export const WECHAT_SCHEME_ENTRY = 'com.tencent.mm/.plugin.base.stub.WXCustomSchemeEntryActivity';
// The preview page's sceneInfo.dynamicExportId: a new value on every read, each one opens the same post.
export const EXPORT_ID = /^export\/[A-Za-z0-9_-]{8,200}$/u;
export function feedLink(exportId) {
  if (!EXPORT_ID.test(String(exportId ?? ''))) throw new DeviceError('invalid_export_id', 'The post export id is not usable');
  return `weixin://biz/finder/openFinderFeed/exportId=${exportId}&actionType=0&commentScene=39&entryScene=64&entryCardType=48&requestScene=0`;
}
export const ACTIVITY = Object.freeze({
  main: 'com.tencent.mm.ui.LauncherUI',
  channelsHome: 'com.tencent.mm.plugin.finder.ui.FinderHomeAffinityUI',
  search: 'com.tencent.mm.plugin.webview.ui.tools.fts.MMFTSSearchTabWebViewUI',
  detail: 'com.tencent.mm.plugin.finder.ui.FinderShareFeedRelUI',
  // Choosing a chat to send the post to: never act here, go back at once.
  chooseChat: 'com.tencent.mm.ui.transmit.SelectConversationUI',
  // 转发给朋友 in 8.0.80 (2026-11-09): the 选择聊天 picker, then the 「发送给：…」 confirmation sheet. Only 「发到微信」 acts
  // here; everywhere else the picker is left at once like chooseChat.
  chooseContact: 'com.tencent.mm.ui.mvvm.MvvmContactListUI',
  sendConfirm: 'com.tencent.mm.ui.halfscreen.HalfScreenTransparentActivity',
});
export const POINT = Object.freeze({
  // Channels home: the magnifier left of the "me" icon (the icon at x 990 opens one's own Channels page).
  channelsSearch: {x: 880, y: 145},
  searchBox: {x: 330, y: 165},
  sort: {all: {x: 115, y: 437}, latest: {x: 258, y: 437}, hot: {x: 395, y: 437}},
  // Work page bottom bar (label row y 2124–2163): 喜欢, 转发, 推荐, 评论.
  share: {x: 763, y: 2085}, comments: {x: 1003, y: 2085},
});
// The same bar sits 180 px higher when WeChat adds its 「↑更多视频」 strip below it (seen opening a post by link).
export const MORE_VIDEOS_SHIFT = 180;
// The 视频 tab's 时长 and 范围 buttons (right of the sort row) open bottom sheets; picking an option closes the sheet and
// the button then shows that option. A new search starts at 不限 again (measured 2026-11-09). Keys are the server's.
export const SEARCH_FILTERS = Object.freeze({
  duration: {button: '时长', options: Object.freeze({under_5m: '5分钟以下', '5_20m': '5-20分钟', over_20m: '20分钟以上'})},
  scope: {button: '范围', options: Object.freeze({followed: '已关注', viewed: '最近看过'})},
});
export const SWIPE = Object.freeze({
  results: [540, 1900, 540, 820, 450],
  comments: [540, 1950, 540, 1150, 600, 200],
  commentsBack: [540, 1150, 540, 1550, 600, 200],
  shareRow2: [900, 1880, 150, 1880, 400],
});
export const REGION = Object.freeze({
  shareSheet: [0, 1500, 1080, 742],
  workBar: [0, 1650, 1080, 592],
  // The sort / 时长 / 范围 row under the result tabs, and the filter bottom sheet (title y≈1747, options y≈1880 and 2000).
  filterRow: [0, 370, 1080, 120],
  filterSheet: [0, 1650, 1080, 592],
  bottomTabs: [0, 2120, 1080, 122],
});
// Texts that mean the owner must act on the phone (login wall, security check, rate warning).
export const OWNER_ACTION_TEXTS = ['安全验证', '请完成验证', '登录微信', '账号已在其他设备登录', '操作过于频繁', '访问过于频繁', '账号存在风险'];
// The single-character 我 tab is not recognized reliably in the tab-bar crop; three labels are enough.
export const MAIN_TABS = ['微信', '通讯录', '发现'];

export function assertWechatDevice({model, apiLevel, wechatVersion}) {
  if (model !== WECHAT_PROFILE.model || String(apiLevel) !== WECHAT_PROFILE.apiLevel || wechatVersion !== WECHAT_PROFILE.version) {
    throw new DeviceError('profile_version_mismatch', 'Device and WeChat versions do not match this calibration profile');
  }
}
