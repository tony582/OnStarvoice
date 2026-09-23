import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createAndroidControlRouter} from '../../../server/routes/android-control.js';
import {createCaptureDiscoveriesRouter} from '../../../server/routes/capture-discoveries.js';
import {hashSessionToken} from '../../../server/services/auth-service.js';

// A real HTTP/auth/PostgreSQL fixture. Secrets stay in memory and test requests;
// no production tenant, code, task or session is read or reused.
export async function startAndroidControlHarness(t) {
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,
    databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  const {runMigrations}=await import('../../../server/db/migrate.js');
  const {getPool,closePool}=await import('../../../server/db/pool.js');
  await runMigrations();const pool=getPool();
  const query=async(sql,values=[])=>(await pool.query(sql,values)).rows;
  const [{id:tenantId}]=await query('INSERT INTO tenants(name) VALUES($1) RETURNING id',[`android-http-${randomUUID()}`]);
  const code=randomUUID(),sessionToken=randomUUID();
  await query('INSERT INTO auth_codes(tenant_id,code,max_bindings) VALUES($1,$2,4)',[tenantId,code]);
  const [{id:userId}]=await query(`INSERT INTO users(email,name,password_hash) VALUES($1,'Android integration','not-a-login-password') RETURNING id`,[`${randomUUID()}@example.invalid`]);
  await query(`INSERT INTO user_memberships(user_id,tenant_id,role) VALUES($1,$2,'tenant_admin')`,[userId,tenantId]);
  await query(`INSERT INTO user_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[userId,hashSessionToken(sessionToken)]);
  const require=createRequire(new URL('../../../server/package.json',import.meta.url));
  const express=require('express'),app=express(),enabledTenants=()=>new Set([tenantId]);
  app.use(express.json({limit:'256kb'}));
  app.use('/api/capture-cloud/android',createAndroidControlRouter({enabledTenants}));
  app.use('/api/capture-cloud',createCaptureDiscoveriesRouter({enabledTenants}));
  app.use((error,_req,res,_next)=>res.status(500).json({ok:false,error:error.code || 'test_server_error'}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    for(const table of ['capture_discovery_run_candidates','capture_discovery_events','capture_discovery_candidates'])
      await query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenantId]);
    await query('DELETE FROM tenants WHERE id=$1',[tenantId]);
    await query('DELETE FROM users WHERE id=$1',[userId]);
    await closePool();
  });
  async function operator(path,{method='GET',body}={}) {
    const response=await fetch(`${origin}/api/capture-cloud/android${path}`,{method,
      headers:{authorization:`Bearer ${sessionToken}`,'x-tenant-id':tenantId,'content-type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)});
    const payload=await response.json();
    if(!response.ok)throw new Error(`Operator ${method} ${path}: ${payload.error || response.status}`);
    return payload;
  }
  return {origin,tenantId,code,operator,query};
}
