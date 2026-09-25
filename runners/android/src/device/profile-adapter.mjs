import {randomUUID} from 'node:crypto';
import {DeviceError, throwIfAborted} from './bounded.mjs';
import {createAppiumClient} from './appium.mjs';
import {bounded} from './bounded.mjs';
import {selectDevice} from './adb.mjs';
import {assertProfileDevice, DOUYIN_P0_PROFILE} from './douyin-profile.mjs';
import {createProfileSession} from './profile-session.mjs';
import {createForegroundGuard} from './douyin-foreground.mjs';
import {createDouyinCalibrationFlow} from '../calibration/douyin-flow.mjs';

// Model, API level and Douyin version change rarely; every other readiness fact is re-read per probe.
const STATIC_PROBE_MS = 30_000;

// Public filter names from the plan snapshot mapped to the calibrated Chinese panel labels.
const SORT_LABELS = Object.freeze({comprehensive:'综合排序', latest:'最新发布', likes:'最多点赞', comments:'最多评论', collects:'最多收藏'});
const PUBLISH_TIME_LABELS = Object.freeze({all:'不限', day:'一天内', week:'一周内', halfyear:'半年内'});
const CONTENT_TYPE_LABELS = Object.freeze({all:'不限', image:'图文', video:'视频'});
/**
 * Accepts the new {sort, publishTime, contentType} and the legacy {sort, range:'day'}; every unsupported value
 * (for instance publishTime='month', which the panel cannot express) is rejected before any UI action begins.
 */
export function mapSearchFilters(filters) {
  const reject = () => { throw new DeviceError('unsupported_search_filters', 'This calibrated profile does not support the requested search filters'); };
  if (!filters || typeof filters !== 'object') reject();
  const sort = SORT_LABELS[filters.sort];
  if (!sort) reject();
  if (filters.range !== undefined) {
    if (filters.range !== 'day' || filters.publishTime !== undefined || filters.contentType !== undefined) reject();
    return {sort, time: '一天内', content: '不限'};
  }
  const time = PUBLISH_TIME_LABELS[filters.publishTime];
  const content = CONTENT_TYPE_LABELS[filters.contentType];
  if (!time || !content) reject();
  return {sort, time, content};
}

export function createProfileAdapter({serial,adb,profileId,appiumUrl,client=createAppiumClient({appiumUrl}),onState,
  foreground=createForegroundGuard({adb,serial}),now=Date.now}) {
  if (profileId !== DOUYIN_P0_PROFILE.id) throw new DeviceError('profile_required','Unknown device profile');
  const session = createProfileSession({serial,profileId,adb,client,onState});
  let flow = null, context = null, staticCheckedAt = -Infinity;
  const requireContext = id => {
    if (!context || id !== context.contextId) throw new DeviceError('search_context_changed','Search context is stale');
    return context;
  };
  const checkProfile = async options => {
    assertProfileDevice({...await adb.inspect(serial,options),...await adb.inspectApp(serial,options)});
    staticCheckedAt = now();
  };
  // After a new automation session the Appium helper app can hold focus for a moment: wait (read-only) for
  // Douyin, and relaunch it once through the reviewed launcher only if it did not come back by itself.
  const regainFocus = async signal => {
    if ((await foreground.waitFor({signal, waitMs: 8000})).douyin) return;
    await foreground.ensure({signal, launch: true});
  };
  // When the automation service dies mid-run, keep its log lines (crash or low-memory kill) for a local diagnostic.
  const automationLog = async () => {
    try { return await bounded(signal => adb.automationLog(serial, {signal}), {timeoutMs: 6000}); } catch { return null; }
  };
  const pending = new Set();
  const adapter = {
    profileId,
    /**
     * Pre-claim readiness from the current phone state: connected, calibrated profile, Appium ready,
     * screen awake, not locked and Douyin focused (relaunched through the reviewed component when needed).
     * Login and the search entry are verified by inspect before any search; a probe never touches the UI.
     */
    async probe({signal} = {}) {
      const options = {signal};
      try {
        selectDevice(await adb.listDevices(options),serial);
        if (now() - staticCheckedAt >= STATIC_PROBE_MS) await checkProfile(options);
        const status = await client.status(options);
        if (status?.ready !== true) throw new DeviceError('appium_not_ready','The Appium server does not report ready');
        const state = await foreground.ensure({signal});
        return {readyForSearch:true,reason:null,foreground:{package:state.package,activity:state.activity,launched:state.launched}};
      } catch(error) {
        staticCheckedAt = -Infinity;
        return {readyForSearch:false,reason:error.code ?? 'device_unavailable',...(error.focus !== undefined ? {focus:error.focus} : {})};
      }
    },
    async inspect(options = {}) {
      // The claimed task re-verifies the foreground before a session is created (no relaunch there). After a new
      // session it may relaunch Douyin once, through the reviewed launcher, if the helper app kept focus.
      await foreground.ensure({signal:options.signal,launch:false});
      const state = await session.inspect({...options, afterCreate: () => regainFocus(options.signal)});
      flow = createDouyinCalibrationFlow({ui:session.ui}); context=null; return state;
    },
    async search({keyword, filters, signal}) {
      throwIfAborted(signal);
      if (!flow) throw new DeviceError('session_required','Inspect the selected phone first');
      const mapped = mapSearchFilters(filters); // Rejects unsupported filters before touching the UI.
      context = null;
      await flow.search({keyword, filters: mapped, signal});
      context = {verified:true,contextId:randomUUID(),keyword,filters:{...filters}};
      return {...context};
    },
    async readCards({contextId,signal}) {
      requireContext(contextId);
      const page=await flow.readCards({signal});
      return {contextId,contextVerified:page.verified,cards:page.cards,end:false};
    },
    async openCard({card,contextId,signal,actionBudgetMs}) {requireContext(contextId); return flow.openCard({card,signal,actionBudgetMs});},
    async copyLink({detail,marker,signal}) {
      const observation=await flow.copyLink({detail,marker,signal});
      return {...observation,detailId:detail.detailId,verification:'ui_bound',
        uiBinding:{profileId,cardId:detail.cardId,kind:observation.kind}};
    },
    async returnToResults({contextId,signal}) {requireContext(contextId); await flow.returnToResults({signal}); return {...context};},
    // Proves the verified results page, keyword and filters again after a failed open, without opening anything.
    async recoverResults({contextId,signal}) {requireContext(contextId); await flow.recoverResults({signal}); return {...context};},
    async scroll({contextId,signal}) {requireContext(contextId); const page=await flow.scroll({signal}); return {contextId,contextVerified:page.verified};},
    readSource: options => session.ui.read(options),
    async close() {await bounded(()=>Promise.allSettled([...pending]),{timeoutMs:15000}); const result=await session.close(); if(result.closed) {flow=null;context=null;} return result;},
  };
  for (const name of ['inspect','search','readCards','openCard','copyLink','returnToResults','recoverResults','scroll','readSource']) {
    const method = adapter[name];
    adapter[name] = params => {
      const operation = Promise.resolve().then(()=>method(params)).catch(async error => {
        if (error?.code === 'appium_http_error' && error.diagnostic === undefined) {
          const log = await automationLog();
          try { error.diagnostic = {stage: 'automation', operation: name, w3cError: error.w3cError ?? null, log}; } catch { /* frozen */ }
        }
        throw error;
      }).finally(()=>pending.delete(operation));
      pending.add(operation);
      return operation;
    };
  }
  return adapter;
}
