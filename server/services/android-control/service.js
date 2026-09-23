import {createAndroidControlRepository} from './repository.js';
import {registerMobile} from './registration.js';
import {createRun,controlRun} from './tasks.js';
import {poll,renew} from './leases.js';
import {complete,closeDevice} from './completion.js';
import {listNodes,listRuns,runView} from './views.js';
import {id} from './validation.js';
export function configuredAndroidTenants() {
  return new Set(String(process.env.ANDROID_DISCOVERY_INGEST_TENANTS || '').split(',').map(t=>t.trim()).filter(Boolean));
}
export function createAndroidControlService({repository=createAndroidControlRepository(),enabledTenants=configuredAndroidTenants}={}) {
  const tx=operation=>repository.transaction(operation);
  return {
    register:input=>tx(db=>registerMobile(db,input,enabledTenants())),
    nodes:tenant=>tx(db=>listNodes(db,id(tenant))),runs:tenant=>tx(db=>listRuns(db,id(tenant))),
    detail:(tenant,runId)=>tx(db=>runView(db,id(tenant),id(runId))),
    create:(tenant,body)=>tx(async db=>runView(db,id(tenant),await createRun(db,tenant,body))),
    stop:(tenant,runId,body)=>tx(async db=>runView(db,id(tenant),await controlRun(db,tenant,id(runId),'stop',body))),
    resume:(tenant,runId)=>tx(async db=>runView(db,id(tenant),await controlRun(db,tenant,id(runId),'resume'))),
    poll:(principal,body)=>tx(async db=>({...await poll(db,principal,body),pollAfterMs:5000,renewAfterMs:30000})),
    renew:(principal,body)=>tx(db=>renew(db,principal,body)),
    complete:(principal,body)=>tx(db=>complete(db,principal,body)),
    close:(principal,body)=>tx(db=>closeDevice(db,principal,body)),
  };
}
