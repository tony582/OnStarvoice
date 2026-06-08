import { DOUYIN_DOM_PROFILE } from "./douyin.js";
import { XIAOHONGSHU_DOM_PROFILE } from "./xiaohongshu.js";

const DOM_PROFILES = Object.freeze({
  douyin: DOUYIN_DOM_PROFILE,
  xiaohongshu: XIAOHONGSHU_DOM_PROFILE,
});

export function getDomProfile(platform) {
  return DOM_PROFILES[platform] || null;
}

export { DOUYIN_DOM_PROFILE, XIAOHONGSHU_DOM_PROFILE };
