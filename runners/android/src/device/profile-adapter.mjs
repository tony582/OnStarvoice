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
      // The claimed task re-verifies the foreground before a session is created; it never relaunches here.
      await foreground.ensure({signal:options.signal,launch:false});
      const state = await session.inspect(options); flow = createDouyinCalibrationFlow({ui:session.ui}); context=null; return state;
    },
    async search({keyword, filters, signal}) {
      throwIfAborted(signal);
      if (!flow) throw new DeviceError('session_required','Inspect the selected phone first');
      if (!['comprehensive','latest'].includes(filters?.sort) || filters?.range !== 'day' || Object.keys(filters).length !== 2) {
        throw new DeviceError('unsupported_search_filters','This calibrated profile supports comprehensive or latest within one day');
      }
      context = null;
      await flow.search({keyword,filters:{sort:filters.sort === 'comprehensive' ? '综合排序' : '最新发布',time:'一天内'},signal});
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
      const operation = Promise.resolve().then(()=>method(params)).finally(()=>pending.delete(operation));
      pending.add(operation);
      return operation;
    };
  }
  return adapter;
}
