import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdbClient} from '../src/device/adb.mjs';
import {createAdbProbeRecovery,ADB_RESTART_COOLDOWN_MS} from '../src/device/adb-recovery.mjs';
import {createProfileAdapter} from '../src/device/profile-adapter.mjs';
import {DOUYIN_P0_PROFILE} from '../src/device/douyin-profile.mjs';
import {createWechatDeviceAdapter} from '../src/device/wechat-adapter.mjs';
import {UNICODE_IME} from '../src/device/adb-screen.mjs';
const failure=(extra={})=>Object.assign(new Error('Device command failed'),{code:'command_failed',...extra});
const actionOf=args=>args.at(-1)==='start-server'?'start-server':args[4];
function checkedAction(args){
  if(actionOf(args)==='start-server'){
    // adb 37.0.1 rejects starting a server when -H explicitly names even a loopback host.
    if(args.includes('-H'))throw failure({exitCode:255,adbFailureCategory:'remote_host_refused'});
    assert.deepEqual(args,['-P','5037','start-server']);
    return 'start-server';
  }
  assert.deepEqual(args.slice(0,4),['-H','127.0.0.1','-P','5037']);
  return actionOf(args);
}
function fixture({hint=false,available=false,startFails=false}={}){
  let healthy=false,time=1000;const calls=[],notes=[];
  const command=async(file,args)=>{
    calls.push(args);const action=checkedAction(args);
    if(action==='start-server'){if(startFails)throw failure();healthy=true;return{stdout:'',stderr:''};}
    if(!healthy)throw failure({adbDaemonUnavailable:hint});
    return{stdout:action==='devices'?'List of devices attached\nphone-1 device model:Test\n':'Test',stderr:''};
  };
  const adb=createAdbClient({command,onDiagnostic:n=>notes.push(n),now:()=>time,daemonAvailable:async()=>available});
  return{adb,calls,notes,break:()=>{healthy=false;},advance:()=>{time+=ADB_RESTART_COOLDOWN_MS;}};
}
test('two failed inspections start the local adb server and immediately reinspect the same device',async()=>{
  for(const hint of [true,false]){
    const f=fixture({hint});await assert.rejects(f.adb.inspect('phone-1'),{code:'command_failed'});
    assert.deepEqual(f.calls.map(actionOf),['devices'],'one failed inspection counts once, without nested list recovery');
    assert.equal((await f.adb.inspect('phone-1')).connected,true);assert.equal(f.calls.filter(a=>actionOf(a)==='start-server').length,1);
    assert.equal(f.notes[0].event,'adb_server_restarted');assert.ok(f.calls.every(a=>!a.includes('kill-server')));
  }
});
test('the first device-list read is protected, but ordinary device commands never restart adb',async()=>{
  const f=fixture();
  await assert.rejects(f.adb.listDevices(),{code:'command_failed'});
  assert.equal((await f.adb.listDevices())[0].serial,'phone-1');
  assert.deepEqual(f.calls.map(actionOf),['devices','devices','start-server','devices']);
  const plain=fixture({hint:true});
  for(let i=0;i<4;i++)await assert.rejects(plain.adb.powerState('phone-1'),{code:'command_failed'});
  assert.equal(plain.calls.filter(args=>actionOf(args)==='start-server').length,0);
});

test('starting the local server omits host selection while device commands retain host, port and serial',async()=>{
  const f=fixture();assert.deepEqual(await f.adb.startServer(),{started:true});
  assert.equal((await f.adb.inspect('phone-1')).connected,true);
  assert.deepEqual(f.calls[0],['-P','5037','start-server']);
  assert.ok(f.calls.slice(1).every(args=>args.slice(0,4).join(' ')==='-H 127.0.0.1 -P 5037'));
  assert.ok(f.calls.filter(args=>args[4]==='-s').every(args=>args[5]==='phone-1'));
});

function adapterFixture(platform,hint){
  let healthy=false;const calls=[];
  const command=async(file,args)=>{
    calls.push(args);const action=checkedAction(args);
    if(action==='start-server'){healthy=true;return{stdout:'',stderr:''};}
    if(!healthy)throw failure({adbDaemonUnavailable:hint});
    let stdout;
    if(action==='devices')stdout='List of devices attached\nphone-1 device model:DE106\n';
    else{
      assert.deepEqual(args.slice(4,7),['-s','phone-1','shell']);
      if(args[7]==='getprop')stdout=({'ro.product.model':'DE106','ro.build.version.release':'8.1.0','ro.build.version.sdk':'27'})[args[8]];
      else if(args.slice(7).join(' ')==='dumpsys package com.ss.android.ugc.aweme')stdout=`versionName=${DOUYIN_P0_PROFILE.version}`;
      else if(args[7]==='dumpsys power | grep -E "mWakefulness=" || true')stdout='mWakefulness=Awake';
      else if(args[7]==='dumpsys window policy')stdout='mKeyguardShowing=false';
      assert.equal(typeof stdout,'string',`unexpected command ${args.join(' ')}`);
    }
    return{stdout,stderr:''};
  };
  const adb=createAdbClient({command,daemonAvailable:async()=>false,now:()=>1000});
  const adapter=platform==='douyin'
    ? createProfileAdapter({serial:'phone-1',adb,profileId:DOUYIN_P0_PROFILE.id,client:{status:async()=>({ready:true})},
      foreground:{ensure:async()=>({package:DOUYIN_P0_PROFILE.packageName,activity:'fixture',launched:false})}})
    : createWechatDeviceAdapter({serial:'phone-1',adb,ocrBinary:process.execPath,screen:{
      packageVersion:async name=>name==='com.tencent.mm'?'8.0.80':'1.0',listImes:async()=>[UNICODE_IME],defaultIme:async()=>'owner/keyboard',
    }},{flowFactory:()=>({}),flowMethods:[]});
  return{adapter,calls};
}
for(const platform of ['douyin','wechat_channels'])test(`${platform} real adapter probe recovers its earliest device-list failure with fake commands`,async()=>{
  for(const hint of [false,true]){
    const f=adapterFixture(platform,hint);
    assert.deepEqual(await f.adapter.probe(),{readyForSearch:false,reason:'command_failed'});
    assert.deepEqual(f.calls.map(actionOf),['devices']);
    assert.equal((await f.adapter.probe()).readyForSearch,true);
    assert.equal((await f.adapter.probe()).readyForSearch,true);
    assert.equal(f.calls.filter(args=>actionOf(args)==='start-server').length,1);
    assert.ok(f.calls.every(args=>!args.includes('kill-server')));
  }
});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
test('a late concurrent 5037 check cannot restart again after another recovery already finished',async()=>{
  let healthy=false,starts=0,reads=0;const waiting=[],bothChecking=deferred();
  const recover=createAdbProbeRecovery({now:()=>1000,startServer:async()=>{starts++;healthy=true;},
    daemonAvailable:()=>{const gate=deferred();waiting.push(gate);if(waiting.length===2)bothChecking.resolve();return gate.promise;}});
  const read=async()=>{reads++;if(!healthy)throw failure();return'healthy';};
  await assert.rejects(recover(read));
  const first=recover(read),second=recover(read);
  await bothChecking.promise;
  waiting[0].resolve(false);assert.equal(await first,'healthy');
  waiting[1].resolve(false);assert.equal(await second,'healthy');
  assert.equal(starts,1);assert.equal(reads,5);
});
test('parallel failures share an in-flight restart and immediately recheck after it settles',async()=>{
  let healthy=false,starts=0,reads=0;const started=deferred(),release=deferred(),joined=deferred();
  const recover=createAdbProbeRecovery({now:()=>1000,startServer:async()=>{starts++;started.resolve();await release.promise;healthy=true;}});
  const read=async()=>{reads++;if(reads===3)joined.resolve();if(!healthy)throw failure({adbDaemonUnavailable:true});return'healthy';};
  await assert.rejects(recover(read));
  const first=recover(read);await started.promise;
  const second=recover(read);await joined.promise;release.resolve();
  assert.deepEqual(await Promise.all([first,second]),['healthy','healthy']);
  assert.equal(starts,1);assert.equal(reads,5);
});
test('abort during a pending port check prevents restart and immediate recheck',async()=>{
  let starts=0,reads=0;const checking=deferred(),answer=deferred(),controller=new AbortController();
  const recover=createAdbProbeRecovery({startServer:async()=>{starts++;},daemonAvailable:()=>{checking.resolve();return answer.promise;}});
  const read=async()=>{reads++;throw failure();};
  await assert.rejects(recover(read));
  const pending=recover(read,{signal:controller.signal});const rejected=assert.rejects(pending,{code:'command_failed'});
  await checking.promise;controller.abort();answer.resolve(false);await rejected;
  assert.equal(starts,0);assert.equal(reads,2);
});
test('an aborted concurrent waiter does not recheck after the shared restart',async()=>{
  let healthy=false,starts=0,reads=0;const started=deferred(),release=deferred(),joined=deferred(),controller=new AbortController();
  const recover=createAdbProbeRecovery({now:()=>1000,startServer:async()=>{starts++;started.resolve();await release.promise;healthy=true;}});
  const read=async()=>{reads++;if(reads===3)joined.resolve();if(!healthy)throw failure({adbDaemonUnavailable:true});return'healthy';};
  await assert.rejects(recover(read));
  const first=recover(read);await started.promise;
  const second=recover(read,{signal:controller.signal});const rejected=assert.rejects(second,{code:'command_failed'});
  await joined.promise;controller.abort();release.resolve();
  assert.equal(await first,'healthy');await rejected;
  assert.equal(starts,1);assert.equal(reads,4);
});
test('a late concurrent port check shares a failed restart without trying again',async()=>{
  let starts=0,reads=0;const waiting=[],bothChecking=deferred();
  const recover=createAdbProbeRecovery({now:()=>1000,startServer:async()=>{starts++;throw failure();},
    daemonAvailable:()=>{if(waiting.length===2)return false;const gate=deferred();waiting.push(gate);if(waiting.length===2)bothChecking.resolve();return gate.promise;}});
  const read=async()=>{reads++;throw failure();};
  await assert.rejects(recover(read));
  const first=assert.rejects(recover(read),{code:'command_failed'}),second=assert.rejects(recover(read),{code:'command_failed'});
  await bothChecking.promise;
  waiting[0].resolve(false);await first;
  waiting[1].resolve(false);await second;
  assert.equal(starts,1);assert.equal(reads,3);
});
test('a running daemon with unrelated command errors is never restarted',async()=>{
  const f=fixture({available:true});for(let i=0;i<4;i++)await assert.rejects(f.adb.inspect('phone-1'),{code:'command_failed'});
  assert.equal(f.calls.filter(a=>actionOf(a)==='start-server').length,0);
});
test('restart cooldown survives successes and failed restart attempts',async()=>{
  for(const startFails of [true,false]){
    const f=fixture({hint:true,startFails});await assert.rejects(f.adb.inspect('phone-1'));
    if(startFails)await assert.rejects(f.adb.inspect('phone-1'));else await f.adb.inspect('phone-1');
    f.break();for(let i=0;i<3;i++)await assert.rejects(f.adb.inspect('phone-1'));
    assert.equal(f.calls.filter(a=>actionOf(a)==='start-server').length,1);f.advance();
    if(startFails)await assert.rejects(f.adb.inspect('phone-1'));else await f.adb.inspect('phone-1');
    assert.equal(f.calls.filter(a=>actionOf(a)==='start-server').length,2);
  }
});
test('success, non-command failure and abort break the consecutive-failure sequence',async()=>{
  let starts=0;const probe=createAdbProbeRecovery({startServer:async()=>{starts++;},daemonAvailable:async()=>false});
  await assert.rejects(probe(async()=>{throw failure();}));await probe(async()=>({ok:true}));
  await assert.rejects(probe(async()=>{throw failure();}));await assert.rejects(probe(async()=>{throw Object.assign(new Error(),{code:'device_missing'});}));
  await assert.rejects(probe(async()=>{throw failure();}));const controller=new AbortController();controller.abort();
  await assert.rejects(probe(async()=>{throw failure();},{signal:controller.signal}));assert.equal(starts,0);
});

test('command failures preserve only the daemon classification and redact subprocess details',async()=>{
  const {runDeviceCommand}=await import('../src/device/command.mjs');
  await assert.rejects(runDeviceCommand(process.execPath,['-e',"process.stderr.write('cannot connect to daemon: private-account-detail');process.exit(1)"]),error=>{
    assert.equal(error.code,'command_failed');assert.equal(error.adbDaemonUnavailable,true);
    assert.ok(!JSON.stringify(error).includes('private-account-detail'));assert.ok(!error.message.includes('private-account-detail'));return true;
  });
});

test('only adb startup classifies remote-host refusal without retaining subprocess output',async()=>{
  const {runDeviceCommand}=await import('../src/device/command.mjs');
  const script="process.stderr.write('* cannot start server on remote host: private-account-detail');process.exit(255)";
  for(const adbOperation of ['start-server',undefined]){
    await assert.rejects(runDeviceCommand(process.execPath,['-e',script],{adbOperation}),error=>{
      assert.equal(error.code,'command_failed');
      assert.equal(error.adbFailureCategory,adbOperation==='start-server'?'remote_host_refused':undefined);
      assert.ok(!JSON.stringify(error).includes('private-account-detail'));
      assert.ok(!error.message.includes('private-account-detail'));return true;
    });
  }
});

test('restart diagnostics retain only bounded failure categories',async()=>{
  for(const [error,expected] of [
    [failure({adbFailureCategory:'remote_host_refused'}),'remote_host_refused'],
    [Object.assign(new Error('private-timeout-detail'),{code:'device_timeout'}),'timeout'],
    [failure(),'other'],
    [failure({adbFailureCategory:'private-account-detail'}),'other'],
  ]){
    const notes=[];
    const recover=createAdbProbeRecovery({startServer:async()=>{throw error;},
      daemonAvailable:async()=>false,now:()=>1000,onDiagnostic:entry=>notes.push(entry)});
    const read=async()=>{throw failure();};
    await assert.rejects(recover(read));await assert.rejects(recover(read));
    assert.equal(notes.length,1);assert.equal(notes[0].event,'adb_server_restart_failed');
    assert.equal(notes[0].failureCategory,expected);
    assert.ok(!JSON.stringify(notes).includes('private-'));
  }
});

test('the startup command alone enables adb startup classification',async()=>{
  const calls=[];
  const adb=createAdbClient({command:async(file,args,options)=>{
    calls.push({args,options});return{stdout:'List of devices attached\nphone-1 device model:Test\n',stderr:''};
  }});
  await adb.startServer();await adb.listDevices();
  assert.equal(calls[0].options.adbOperation,'start-server');
  assert.equal(calls[1].options.adbOperation,undefined);
});

test('local server startup retains a separate 30-second bound and cancellation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const calls=[];
  const adb=createAdbClient({timeoutMs:15,command:async(file,args,options)=>{
    calls.push({args,options});
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  }});
  const pending=adb.startServer(),failed=assert.rejects(pending,{code:'device_timeout'});
  await flush();t.mock.timers.tick(30_000);await failed;
  assert.equal(calls.length,1);assert.equal(calls[0].options.timeoutMs,30_000);
  assert.equal(calls[0].options.signal.aborted,true);
  const controller=new AbortController();controller.abort();
  await assert.rejects(adb.startServer({signal:controller.signal}),{code:'aborted'});
  assert.equal(calls.length,1,'an already canceled startup must not issue a command');
});

async function flush(){for(let i=0;i<30;i++)await Promise.resolve();}
test('an eight-second cold startup survives the old five-second limit and immediately rechecks',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let clock=1000,healthy=false,settled=false;const calls=[],notes=[];
  const adb=createAdbClient({now:()=>clock,daemonAvailable:async()=>false,onDiagnostic:entry=>notes.push(entry),
    command:async(file,args,options)=>{
      const action=checkedAction(args);calls.push({action,timeoutMs:options.timeoutMs});
      if(action==='start-server'){
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(resolve,8000);
          options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason);},{once:true});
        });healthy=true;return{stdout:'',stderr:''};
      }
      if(!healthy)throw failure({adbDaemonUnavailable:true});
      return{stdout:'List of devices attached\nphone-1 device model:Test\n',stderr:''};
    }});
  await assert.rejects(adb.listDevices(),{code:'command_failed'});
  const pending=adb.listDevices().then(value=>{settled=true;return{value};},error=>{settled=true;return{error};});
  await flush();clock+=5000;t.mock.timers.tick(5000);await flush();
  assert.equal(settled,false,'the startup client must remain alive while USB initialization is slow');
  clock+=3000;t.mock.timers.tick(3000);await flush();
  const result=await pending;assert.equal(result.error,undefined);assert.equal(result.value[0].serial,'phone-1');
  assert.deepEqual(calls.map(call=>call.action),['devices','devices','start-server','devices']);
  assert.equal(calls.find(call=>call.action==='start-server').timeoutMs,30_000);
  assert.ok(calls.filter(call=>call.action==='devices').every(call=>call.timeoutMs===5000));
  assert.deepEqual(notes,[{at:new Date(clock).toISOString(),event:'adb_server_restarted',elapsedMs:8000}]);
});

test('ordinary device commands still expire at five seconds',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let optionsSeen,settled=false;
  const adb=createAdbClient({command:async(file,args,options)=>{
    assert.equal(checkedAction(args),'-s');optionsSeen=options;
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  }});
  const pending=adb.powerState('phone-1').then(()=>{settled=true;},error=>{settled=true;throw error;});
  const failed=assert.rejects(pending,{code:'device_timeout'});await flush();
  t.mock.timers.tick(4999);await flush();assert.equal(settled,false);
  t.mock.timers.tick(1);await failed;assert.equal(optionsSeen.timeoutMs,5000);assert.equal(optionsSeen.signal.aborted,true);
});

for(const code of ['device_timeout','command_failed'])test(`a ${code} startup with a listening daemon succeeds and reinspects`,async()=>{
  let clock=1000,healthy=false,checks=0,reads=0;const notes=[];
  const recover=createAdbProbeRecovery({now:()=>clock,onDiagnostic:entry=>notes.push(entry),
    startServer:async()=>{clock+=30_000;healthy=true;throw Object.assign(new Error('private-startup-detail'),{code});},
    daemonAvailable:async()=>{checks++;clock+=250;return true;}});
  const read=async()=>{reads++;if(!healthy)throw failure({adbDaemonUnavailable:true});return'healthy';};
  await assert.rejects(recover(read));assert.equal(await recover(read),'healthy');assert.equal(reads,3);assert.equal(checks,1);
  assert.deepEqual(notes,[{at:new Date(clock).toISOString(),event:'adb_server_restarted',startTimedOut:true,elapsedMs:30_000}]);
  assert.ok(!JSON.stringify(notes).includes('private-'));
});

test('timed-out startup with no listener records command duration and keeps cooldown',async()=>{
  let clock=1000,starts=0,checks=0;const notes=[];
  const recover=createAdbProbeRecovery({now:()=>clock,onDiagnostic:entry=>notes.push(entry),
    startServer:async()=>{starts++;clock+=30_000;throw Object.assign(new Error('startup timeout'),{code:'device_timeout'});},
    daemonAvailable:async()=>{checks++;clock+=250;return false;}});
  const read=async()=>{throw failure({adbDaemonUnavailable:true});};
  await assert.rejects(recover(read));await assert.rejects(recover(read),{code:'device_timeout'});
  assert.equal(checks,1);assert.equal(notes[0].event,'adb_server_restart_failed');assert.equal(notes[0].failureCategory,'timeout');
  assert.equal(notes[0].elapsedMs,30_000,'port-check time is not startup-command time');
  clock=60_999;await assert.rejects(recover(read));assert.equal(starts,1);
  clock=61_000;await assert.rejects(recover(read));assert.equal(starts,2);
});

test('a listening port after startup failure does not bypass a failed device recheck',async()=>{
  let reads=0;const notes=[];
  const recover=createAdbProbeRecovery({now:()=>1000,onDiagnostic:entry=>notes.push(entry),
    startServer:async()=>{throw Object.assign(new Error('timeout'),{code:'device_timeout'});},daemonAvailable:async()=>true});
  const read=async()=>{reads++;throw failure({adbDaemonUnavailable:true});};
  await assert.rejects(recover(read));await assert.rejects(recover(read),{code:'command_failed'});
  assert.equal(reads,3);assert.equal(notes.length,1);assert.equal(notes[0].startTimedOut,true);
});

test('a failed post-start listener check preserves the original failure and duration',async()=>{
  let clock=1000;const notes=[];
  const original=failure({adbFailureCategory:'remote_host_refused'});
  const recover=createAdbProbeRecovery({now:()=>clock,onDiagnostic:entry=>notes.push(entry),
    startServer:async()=>{clock+=40;throw original;},daemonAvailable:async()=>{throw new Error('private-port-detail');}});
  const read=async()=>{throw failure({adbDaemonUnavailable:true});};
  await assert.rejects(recover(read));await assert.rejects(recover(read),error=>error===original);
  assert.equal(notes[0].elapsedMs,40);assert.equal(notes[0].failureCategory,'remote_host_refused');
  assert.ok(!JSON.stringify(notes).includes('private-'));
});

test('cancellation of startup cannot become success through a listening port',async()=>{
  const controller=new AbortController();let checks=0;const notes=[];
  const recover=createAdbProbeRecovery({now:()=>1000,onDiagnostic:entry=>notes.push(entry),
    startServer:async()=>{controller.abort();throw Object.assign(new Error('canceled'),{code:'aborted'});},
    daemonAvailable:async()=>{checks++;return true;}});
  const read=async()=>{throw failure({adbDaemonUnavailable:true});};
  await assert.rejects(recover(read));await assert.rejects(recover(read,{signal:controller.signal}));
  assert.equal(checks,0);assert.equal(notes.some(n=>n.event==='adb_server_restarted'),false);
});

test('cancellation during the post-start port check prevents false success and device recheck',async()=>{
  const controller=new AbortController(),checking=deferred(),answer=deferred();let reads=0;const notes=[];
  const recover=createAdbProbeRecovery({now:()=>1000,onDiagnostic:entry=>notes.push(entry),
    startServer:async()=>{throw Object.assign(new Error('timeout'),{code:'device_timeout'});},
    daemonAvailable:()=>{checking.resolve();return answer.promise;}});
  const read=async()=>{reads++;throw failure({adbDaemonUnavailable:true});};
  await assert.rejects(recover(read));const pending=recover(read,{signal:controller.signal});const rejected=assert.rejects(pending);
  await checking.promise;controller.abort();answer.resolve(true);await rejected;
  assert.equal(reads,2);assert.equal(notes.some(n=>n.event==='adb_server_restarted'),false);
});

test('a startup that ignores cancellation cannot emit a success event',async()=>{
  const controller=new AbortController();const notes=[];
  const recover=createAdbProbeRecovery({now:()=>1000,onDiagnostic:entry=>notes.push(entry),
    startServer:async()=>{controller.abort();},daemonAvailable:async()=>false});
  const read=async()=>{throw failure({adbDaemonUnavailable:true});};
  await assert.rejects(recover(read));await assert.rejects(recover(read,{signal:controller.signal}));
  assert.equal(notes.some(n=>n.event==='adb_server_restarted'),false);
});

test('only the startup command wrapper permits the thirty-second bound',async()=>{
  const {runDeviceCommand}=await import('../src/device/command.mjs');
  const result=await runDeviceCommand(process.execPath,['-e','process.stdout.write("offline fixture")'],{timeoutMs:30_000,adbOperation:'start-server'});
  assert.equal(result.stdout,'offline fixture');
  await assert.rejects(runDeviceCommand(process.execPath,['-e','process.exit(0)'],{timeoutMs:30_000}),{code:'invalid_timeout'});
});
