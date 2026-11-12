import {join} from 'node:path';
import {createAndroidDeviceAdapter} from '../device/adapter.mjs';
import {createAdbClient} from '../device/adb.mjs';
import {createOcrPool} from '../device/ocr-pool.mjs';
import {createOcrReadiness} from '../device/ocr-readiness.mjs';
import {createWechatAdapter} from '../device/wechat-adapter.mjs';
import {createWechatArticleAdapter} from '../device/wechat-article-adapter.mjs';
import {WECHAT_PROFILE} from '../device/wechat-profile.mjs';
import {createSharePreview} from '../preview/share-preview.mjs';
import {setCheckpoint, stateValue} from './state.mjs';
import {recordDiagnostic} from '../core/diagnostics.mjs';

export const PLATFORMS = Object.freeze({douyin: 'douyin', wechat: 'wechat_channels', articles: 'wechat_articles'});

/**
 * One phone, one or two apps. connection.json keeps `deviceProfile` (Douyin, unchanged) and gains an optional
 * `wechat: {profile, ocrHelper, chromePath?}` block (cli `enable-wechat`). Each platform has its own adapter;
 * the daemon runs one task at a time, so at most one of them touches the phone at any moment.
 */
export function createRunnerDevice({config, store, stateDir, onState}) {
  const wechatConfig = config.wechat && config.wechat.profile === WECHAT_PROFILE.id ? config.wechat : null;
  const adb = createAdbClient({adbPath: config.adbPath, onDiagnostic: entry => recordDiagnostic(store, entry)});
  const douyin = config.deviceProfile
    ? createAndroidDeviceAdapter({serial: config.deviceId, profileId: config.deviceProfile, appiumUrl: config.appiumUrl, adb, onState,
      sharedWithWechat: !!wechatConfig})
    : null;
  if (!wechatConfig) return douyin;
  const ocr = createOcrPool({binaryPath: wechatConfig.ocrHelper, tmpDir: join(stateDir, 'ocr-scratch')});
  const ime = {load: () => stateValue(store, 'wechat:owner-ime'), save: value => setCheckpoint(store, 'wechat:owner-ime', value)};
  const wechat = createWechatAdapter({serial: config.deviceId, adb, adbPath: config.adbPath || 'adb', ocr,
    ocrBinary: wechatConfig.ocrHelper, ime});
  const articles = createWechatArticleAdapter({serial: config.deviceId, adb, adbPath: config.adbPath || 'adb', ocr,
    ocrBinary: wechatConfig.ocrHelper, ime});
  const preview = createSharePreview({chromePath: wechatConfig.chromePath || undefined, profileDir: join(stateDir, 'chrome-preview')});
  return combineRunnerDevices({douyin, wechat, articles, preview, ocr, store});
}

/** The same OCR readiness barrier protects both WeChat adapters; Douyin remains independent. */
export function combineRunnerDevices({douyin, wechat, articles, preview, ocr, store, now = Date.now}) {
  const readiness = createOcrReadiness({ocr, now, onDiagnostic: entry =>
    recordDiagnostic(store, {at: new Date(now()).toISOString(), ...entry})});
  readiness.start();
  const adapters = {[PLATFORMS.douyin]: douyin, [PLATFORMS.wechat]: wechat, [PLATFORMS.articles]: articles};
  return {
    multiPlatform: true,
    preview,
    forPlatform: platform => adapters[platform ?? PLATFORMS.douyin] ?? null,
    setTaskActive: value => readiness.setTaskActive(value),
    async prepareTask({platform, signal}) {
      if ([PLATFORMS.wechat, PLATFORMS.articles].includes(platform)) await readiness.ensureReady({signal});
    },
    /** Readiness per app; the phone is ready when at least one app is. The Douyin reading keeps its fields. */
    async probe({signal} = {}) {
      readiness.maintain();
      const results = {};
      if (douyin) results[PLATFORMS.douyin] = await douyin.probe({signal});
      const ocrState = readiness.status();
      for (const platform of [PLATFORMS.wechat, PLATFORMS.articles]) {
        results[platform] = !ocrState.readyForSearch ? ocrState : !preview.available()
          ? {readyForSearch: false, reason: 'preview_unavailable'} : await adapters[platform].probe({signal});
      }
      const platforms = Object.keys(results).filter(key => results[key].readyForSearch === true);
      const first = results[PLATFORMS.douyin] ?? results[PLATFORMS.wechat];
      return {...first, readyForSearch: platforms.length > 0, reason: platforms.length ? null : first.reason, platforms, ocr: ocrState,
        platformReasons: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.reason ?? null]))};
    },
    async close() {
      const result = douyin ? await douyin.close() : {closed: true, verifiedAt: new Date().toISOString()};
      return result;
    },
    shutdown() { readiness.close(); try { ocr.close(); } catch { /* closed */ } try { preview.close(); } catch { /* closed */ } },
  };
}
