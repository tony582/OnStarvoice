import {createConnection} from 'node:net';

export const ADB_RESTART_COOLDOWN_MS = 60_000;
export function adbDaemonAvailable({signal,timeoutMs=300}={}) {
  if(signal?.aborted)return Promise.resolve(false);
  return new Promise(resolve=>{
    const socket=createConnection({host:'127.0.0.1',port:5037});let finished=false;
    const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.destroy();resolve(value);};
    const abort=()=>finish(false),timer=setTimeout(()=>finish(false),timeoutMs);
    socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));signal?.addEventListener('abort',abort,{once:true});
  });
}

/** Only device listing/inspection invokes recovery; individual shell commands never restart adb. */
export function createAdbProbeRecovery({startServer,daemonAvailable=adbDaemonAvailable,now=Date.now,onDiagnostic=()=>{}}) {
  let failures=0,lastRestart=-Infinity,restarting=null,restartVersion=0,lastRecovery=null;
  const note=entry=>{try{onDiagnostic({at:new Date(now()).toISOString(),...entry});}catch{/* diagnostics cannot block recovery */}};
  return async function probeWithRecovery(probe,{signal}={}) {
    try {const result=await probe();failures=0;return result;}
    catch(error){
      if(signal?.aborted || error?.code!=='command_failed'){failures=0;throw error;}
      failures++;
      const recheckAfter = async current => {
        try {await current;}finally{if(restarting===current)restarting=null;}
        if(signal?.aborted)throw error;
        // One immediate recheck; no recursive recovery and no kill-server.
        const result=await probe();failures=0;return result;
      };
      // Concurrent probes share an already-authorized restart, including its failure.
      if(restarting)return recheckAfter(restarting);
      if(failures<2 || now()-lastRestart<ADB_RESTART_COOLDOWN_MS)throw error;
      const observedVersion=restartVersion;
      let unavailable=error.adbDaemonUnavailable===true;
      if(!unavailable)unavailable=!await daemonAvailable({signal});
      if(signal?.aborted)throw error;
      if(restarting)return recheckAfter(restarting);
      // A slow port check can return after another restart has already finished. Use that result instead
      // of claiming a second restart with the stale evidence, and recheck cooldown after every await.
      if(restartVersion!==observedVersion)return recheckAfter(lastRecovery);
      if(!unavailable || failures<2 || now()-lastRestart<ADB_RESTART_COOLDOWN_MS)throw error;
      lastRestart=now();failures=0;restartVersion++;
      restarting=(async()=>{
        try {await startServer({signal});note({event:'adb_server_restarted'});}
        catch(failure){
          const failureCategory=failure?.code==='device_timeout'?'timeout'
            :failure?.adbFailureCategory==='remote_host_refused'?'remote_host_refused':'other';
          note({event:'adb_server_restart_failed',code:failure?.code || 'command_failed',failureCategory});throw failure;
        }
      })();
      lastRecovery=restarting;
      return recheckAfter(restarting);
    }
  };
}
