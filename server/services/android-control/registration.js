import {makeCaptureAgentToken,hashCaptureAgentToken} from '../capture-cloud.js';
import {fail,text} from './validation.js';
export async function registerMobile(tx,input,enabledTenants) {
  const code = text(input.code,'CODE',256), clientUuid=text(input.clientUuid,'CLIENT_UUID',120);
  const deviceId=text(input.deviceId,'DEVICE_ID',120), clientLabel=text(input.clientLabel || 'Android 手机','CLIENT_LABEL');
  const auth = await tx.queryOne(`SELECT code.*,tenant.status AS tenant_status FROM auth_codes code
    JOIN tenants tenant ON tenant.id=code.tenant_id WHERE code.code=$1 FOR UPDATE OF code`,[code]);
  if (!auth || auth.status !== 'active' || auth.tenant_status !== 'active'
      || (auth.expires_at && new Date(auth.expires_at) < new Date())) fail('INVALID_ACTIVATION_CODE',403);
  if (!enabledTenants.has(auth.tenant_id)) fail('ANDROID_DISCOVERY_NOT_ENABLED',403);
  const stableId=`android:${clientUuid}`;
  const previous = await tx.queryOne('SELECT * FROM capture_agents WHERE tenant_id=$1 AND client_uuid=$2',[auth.tenant_id,stableId]);
  if (previous && (previous.status !== 'active' || previous.capabilities?.deviceId !== deviceId)) fail('MOBILE_BINDING_CONFLICT');
  const phone = await tx.queryOne(`SELECT id FROM capture_agents WHERE tenant_id=$1 AND capabilities->>'agentKind'='android_mobile'
    AND capabilities->>'deviceId'=$2 AND status<>'revoked'`,[auth.tenant_id,deviceId]);
  if (phone && phone.id !== previous?.id) fail('DEVICE_ALREADY_BOUND');
  let binding = await tx.queryOne('SELECT * FROM auth_bindings WHERE code_id=$1 AND fingerprint=$2',[auth.id,stableId]);
  if (!binding) {
    const count=await tx.queryOne('SELECT COUNT(*)::int AS count FROM auth_bindings WHERE code_id=$1',[auth.id]);
    if (count.count >= auth.max_bindings) fail('BINDING_LIMIT_REACHED');
    binding=await tx.queryOne(`INSERT INTO auth_bindings(code_id,fingerprint,user_agent) VALUES($1,$2,$3) RETURNING *`,[auth.id,stableId,clientLabel]);
  }
  const capabilities={agentKind:'android_mobile',deviceId,mobileSearchDiscoveryV1:true,supportedPlatforms:['douyin'],
    remoteTaskCreate:false,remoteTaskKeywordPostLimit:false,singleRelayV1:false,readyForSearch:false};
  const agent=await tx.queryOne(`INSERT INTO capture_agents(tenant_id,auth_code_id,auth_binding_id,client_uuid,
    client_label,display_name,browser_name,operating_system,app_version,allowed_platforms,capabilities)
    VALUES($1,$2,$3,$4,$5,$5,'Android Runner','Android',$6,ARRAY['douyin'],$7)
    ON CONFLICT(tenant_id,client_uuid) DO UPDATE SET auth_code_id=EXCLUDED.auth_code_id,
    auth_binding_id=EXCLUDED.auth_binding_id,app_version=EXCLUDED.app_version,updated_at=now() RETURNING *`,
  [auth.tenant_id,auth.id,binding.id,stableId,clientLabel,String(input.appVersion || '').slice(0,80),capabilities]);
  const token=makeCaptureAgentToken();
  await tx.execute(`UPDATE capture_agent_tokens SET revoked_at=now() WHERE agent_id=$1 AND revoked_at IS NULL`,[agent.id]);
  await tx.execute(`INSERT INTO capture_agent_tokens(agent_id,auth_code_id,auth_binding_id,token_hash) VALUES($1,$2,$3,$4)`,[agent.id,auth.id,binding.id,hashCaptureAgentToken(token)]);
  return {tenantId:auth.tenant_id,agent:{id:agent.id,token,deviceId,capabilities:agent.capabilities}};
}
