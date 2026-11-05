import {DeviceError} from './bounded.mjs';

// WeChat 8.0.80 on the Smartisan DE106 (Android 8.1, 1080x2242), measured 2026-11-05. WeChat hides its UI tree from
// automation, so every target below is a fixed screen point or a text located by local OCR, and each step is
// confirmed by the focused activity (dumpsys window) before the next tap.
export const WECHAT_PROFILE = Object.freeze({
  id: 'wechat-8.0.80-de106-api27-p0', platform: 'wechat_channels', packageName: 'com.tencent.mm', version: '8.0.80',
  model: 'DE106', apiLevel: '27', screen: {width: 1080, height: 2242}, productionAccepted: false,
});
export const WECHAT_MAIN = 'com.tencent.mm/.ui.LauncherUI';
export const ACTIVITY = Object.freeze({
  main: 'com.tencent.mm.ui.LauncherUI',
  channelsHome: 'com.tencent.mm.plugin.finder.ui.FinderHomeAffinityUI',
  search: 'com.tencent.mm.plugin.webview.ui.tools.fts.MMFTSSearchTabWebViewUI',
  detail: 'com.tencent.mm.plugin.finder.ui.FinderShareFeedRelUI',
  // Choosing a chat to send the post to: never act here, go back at once.
  chooseChat: 'com.tencent.mm.ui.transmit.SelectConversationUI',
});
export const POINT = Object.freeze({
  // Channels home: the magnifier left of the "me" icon (the icon at x 990 opens one's own Channels page).
  channelsSearch: {x: 880, y: 145},
  searchBox: {x: 330, y: 165},
  sort: {all: {x: 115, y: 437}, latest: {x: 258, y: 437}, hot: {x: 395, y: 437}},
  // Work page bottom bar (label row y 2124–2163): 喜欢, 转发, 推荐, 评论.
  share: {x: 763, y: 2085}, comments: {x: 1003, y: 2085},
});
export const SWIPE = Object.freeze({
  results: [540, 1900, 540, 820, 450],
  comments: [540, 1950, 540, 1050, 450],
  shareRow2: [900, 1880, 150, 1880, 400],
});
export const REGION = Object.freeze({
  shareSheet: [0, 1500, 1080, 742],
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
