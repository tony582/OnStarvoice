import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfileSession} from '../src/device/profile-session.mjs';
import {profileCapabilities} from '../src/device/session-profile.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {settleDevice} from '../src/daemon/settle-device.mjs';
import {DeviceClosureJournal,readDeviceClosure} from '../src/core/device-closure.mjs';
import {fixtureTask} from './core-fixtures.mjs';
const profileId='douyin-40.6.0-de106-api27-p0',serial='phone-1';
function fixture(changes={}) {
  let stopped=0,created=0,deleted=0;
  const adb={inspect:async()=>({model:'DE106',apiLevel:27}),inspectApp:async()=>({appVersion:'40.6.0'}),
    listDevices:async()=>[{serial,state:'device'}],helperPids:async()=>[],stopHelper:async()=>{stopped++;},...changes.adb};
  const client={isSessionActive:async()=>false,createProfileSession:async()=>{created++;return {sessionId:'owned'};},
    deleteSession:async()=>{deleted++;},isLocked:async()=>true,...changes.client};
  return {session:createProfileSession({serial,profileId,adb,client}),counts:()=>({stopped,created,deleted})};
}
test('physical profile pins serial and preserves phone data, lock state and screen-power behavior',()=>{
  const cap=profileCapabilities(profileId,serial);
  assert.equal(cap['appium:udid'],serial);assert.equal(cap['appium:noReset'],true);
  assert.equal(cap['appium:fullReset'],false);assert.equal(cap['appium:autoLaunch'],false);
  assert.equal(cap['appium:settings'].wakeLockTimeout,0);
  assert.throws(()=>profileCapabilities('unknown',serial),{code:'profile_required'});
});
test('different device version or existing foreign session prevents creating or killing helpers',async()=>{
  for (const changes of [{adb:{inspectApp:async()=>({appVersion:'31.0.0'})}},
    {adb:{helperPids:async()=>['foreign-pid']}}]) {
    const f=fixture(changes);await assert.rejects(f.session.inspect());
    assert.equal((await f.session.close()).closed,true);
    assert.deepEqual(f.counts(),{stopped:0,created:0,deleted:0});
  }
});
test('known session can close after login failure; unknown creation outcome retains device ownership',async()=>{
  const f=fixture();await assert.rejects(f.session.inspect(),{code:'device_locked'});
  assert.equal((await f.session.close()).closed,true);assert.equal(f.counts().deleted,1);
  const lost=fixture({client:{createProfileSession:async()=>{throw new Error('lost response');}}});
  await assert.rejects(lost.session.inspect());assert.equal((await lost.session.close()).closed,false);
  assert.equal(lost.counts().deleted,0);
});
test('an unconfirmed delete or disconnected device does not release physical closure',async()=>{
  const f=fixture({adb:{listDevices:async()=>[]}});
  await assert.rejects(f.session.inspect(),{code:'device_locked'});
  await assert.rejects(f.session.close(),{code:'device_missing'});
});
test('task completion is fenced until independently confirmed closure, with evidence in SQLite',async()=>{
  const store=new RunnerStore(':memory:'),task=fixtureTask(),clock={wallNow:Date.now};
  const journal=new DeviceClosureJournal({store,task,clock});journal.begin('copyLink');
  try {
    const pending=await settleDevice({store,task,clock,result:{status:'canceled',reason:'remote_stop'},
      device:{close:async()=>({closed:false})}});
    assert.equal(pending.deviceIdle,false);assert.equal(readDeviceClosure(store,serial).required,true);
    const settled=await settleDevice({store,task,clock,result:pending,device:{close:async()=>({closed:true,
      verifiedAt:new Date().toISOString(),evidenceId:'independent-fixture-proof'})}});
    assert.equal(settled.deviceIdle,true);assert.equal(settled.reason,'remote_stop');
    assert.equal(readDeviceClosure(store,serial).required,false);
  } finally {store.close();}
});
