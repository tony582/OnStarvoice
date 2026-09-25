import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceAvailability,holdState,recoveryView,receiptStats,resumeError} from '../server/services/android-control/recovery.js';

const now=Date.parse('2026-09-23T08:00:00.000Z');
const task={status:'needs_action',metadata:{deadlineAt:new Date(now+60000).toISOString()}};
const ready={status:'active',last_liveness_at:new Date(now-5000).toISOString(),capabilities:{agentKind:'android_mobile',readyForSearch:true}};
const closed={status:'needs_action',metadata:{deviceHeld:false,reason:'usb_disconnected',deviceClosedAt:new Date(now-1000).toISOString()}};
const working={status:'running',metadata:{deviceHeld:true,leaseUntil:new Date(now+30000).toISOString()}};

test('running occupancy differs from uncertain closure and pending stop',()=>{
  assert.equal(holdState(working,task.metadata,now),'working');
  assert.equal(holdState(working,{...task.metadata,stopRequested:true},now),'stopping');
  assert.equal(holdState({...working,status:'needs_action'},task.metadata,now),'closure_required');
  assert.equal(holdState({...working,metadata:{...working.metadata,completion:{}}},task.metadata,now),'closure_required');
  assert.equal(holdState(working,task.metadata,now+31000),'closure_required');
  assert.equal(holdState({...working,metadata:{deviceHeld:true}},task.metadata,now),'closure_required');
  assert.equal(holdState(closed,task.metadata,now),'free');
});
test('USB return and fresh heartbeat do not unlock a held device',()=>{
  const state=recoveryView(task,[{...working,status:'needs_action'}],ready,now);
  assert.equal(state.deviceReady,true);assert.equal(state.closureRequired,true);
  assert.equal(state.state,'closure_required');assert.equal(state.canResume,false);
  assert.equal(state.resumeError,'STOP_OR_DEVICE_CLOSURE_REQUIRED');
});
test('safe recovery may queue while device is offline without resetting the budget',()=>{
  const offline={...ready,last_liveness_at:new Date(now-120001).toISOString()};
  const state=recoveryView(task,[closed],offline,now);
  assert.equal(state.state,'waiting_device');assert.equal(state.canResume,true);
  assert.equal(state.remainingMs,60000);assert.equal(state.deviceOnline,false);assert.equal(state.deviceReady,false);
  assert.equal(state.lastClosedAt,closed.metadata.deviceClosedAt);
  assert.deepEqual(deviceAvailability(ready,now),{online:true,readyForSearch:true});
  assert.equal(deviceAvailability({...ready,status:'disabled'},now).readyForSearch,false);
});
test('deadline is checked again at mutation time and invalid values fail closed',()=>{
  assert.equal(recoveryView(task,[closed],ready,now).canResume,true);
  assert.equal(resumeError(task,[closed],now+60000),'RUN_DEADLINE_EXPIRED');
  for(const deadlineAt of [null,'not-a-date','']) {
    assert.equal(resumeError({...task,metadata:{deadlineAt}},[closed],now),'RUN_DEADLINE_EXPIRED');
  }
  assert.equal(recoveryView(task,[closed],ready,now+60000).state,'deadline_expired');
});
test('stop takes precedence over resume and a completed batch is never resumable',()=>{
  const stopped={...task,metadata:{...task.metadata,stopRequested:true}};
  assert.equal(recoveryView(stopped,[closed],ready,now).state,'stopped');
  assert.equal(resumeError(stopped,[closed],now),'STOP_OR_DEVICE_CLOSURE_REQUIRED');
  assert.equal(resumeError({...task,status:'completed'},[closed],now),'RUN_NOT_RESUMABLE');
  assert.equal(recoveryView({...task,status:'completed'},[closed],ready,now).state,'not_needed');
});
test('receipt exposes only nonnegative numeric counters, not arbitrary checkpoint data',()=>{
  assert.equal(receiptStats({}),null);
  assert.deepEqual(receiptStats({runner:{stats:{links:3,cards:7,swipes:-1,keywordElapsedMs:601823,batchElapsedMs:'unsafe',other:'private'}}}),
    {links:3,cards:7,keywordElapsedMs:601823});
});

test('disabled or missing nodes cannot advertise a resumable task',()=>{
  for(const agent of [null,{...ready,status:'disabled'},{...ready,capabilities:{agentKind:'browser'}}]) {
    const state=recoveryView(task,[closed],agent,now);
    assert.equal(state.canResume,false);assert.equal(state.state,'node_unavailable');
    assert.equal(state.resumeError,'MOBILE_AGENT_NOT_FOUND');
  }
});

test('receipt stats carry the runner skipped-card count so the task detail can show it', () => {
  assert.deepEqual(receiptStats({runner: {stats: {links: 13, cards: 14, skippedCards: 1, keywordElapsedMs: 560000}}}),
    {links: 13, cards: 14, skippedCards: 1, keywordElapsedMs: 560000});
  assert.deepEqual(receiptStats({runner: {stats: {links: 2, skippedCards: -3}}}), {links: 2});
});
