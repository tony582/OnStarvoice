import {randomUUID} from 'node:crypto';
import {DeviceError, throwIfAborted} from './bounded.mjs';
import {createAppiumClient} from './appium.mjs';
import {bounded} from './bounded.mjs';
import {assertProfileDevice, DOUYIN_P0_PROFILE} from './douyin-profile.mjs';
import {createProfileSession} from './profile-session.mjs';
import {createDouyinCalibrationFlow} from '../calibration/douyin-flow.mjs';

export function createProfileAdapter({serial,adb,profileId,appiumUrl,client=createAppiumClient({appiumUrl}),onState}) {
  if (profileId !== DOUYIN_P0_PROFILE.id) throw new DeviceError('profile_required','Unknown device profile');
  const session = createProfileSession({serial,profileId,adb,client,onState});
  let flow = null, context = null;
  const requireContext = id => {
    if (!context || id !== context.contextId) throw new DeviceError('search_context_changed','Search context is stale');
    return context;
  };
  const pending = new Set();
  const adapter = {
    profileId,
    async probe({signal} = {}) {
      try {
        const device = await adb.inspect(serial,{signal});
        assertProfileDevice({...device,...await adb.inspectApp(serial,{signal})});
        await client.status({signal});
        return {readyForSearch:true,reason:null};
      } catch(error) {return {readyForSearch:false,reason:error.code ?? 'device_unavailable'};}
    },
    async inspect(options) { const state = await session.inspect(options); flow = createDouyinCalibrationFlow({ui:session.ui}); context=null; return state; },
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
    async openCard({card,contextId,signal}) {requireContext(contextId); return flow.openCard({card,signal});},
    async copyLink({detail,marker,signal}) {
      const observation=await flow.copyLink({detail,marker,signal});
      return {...observation,detailId:detail.detailId,verification:'ui_bound',
        uiBinding:{profileId,cardId:detail.cardId,kind:observation.kind}};
    },
    async returnToResults({contextId,signal}) {requireContext(contextId); await flow.returnToResults({signal}); return {...context};},
    async scroll({contextId,signal}) {requireContext(contextId); const page=await flow.scroll({signal}); return {contextId,contextVerified:page.verified};},
    readSource: options => session.ui.read(options),
    async close() {await bounded(()=>Promise.allSettled([...pending]),{timeoutMs:15000}); const result=await session.close(); if(result.closed) {flow=null;context=null;} return result;},
  };
  for (const name of ['inspect','search','readCards','openCard','copyLink','returnToResults','scroll','readSource']) {
    const method = adapter[name];
    adapter[name] = params => {
      const operation = Promise.resolve().then(()=>method(params)).finally(()=>pending.delete(operation));
      pending.add(operation);
      return operation;
    };
  }
  return adapter;
}
