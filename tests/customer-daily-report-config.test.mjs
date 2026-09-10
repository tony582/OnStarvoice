import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeDailyConfig,publicDailyConfig,resolvedDailyConfig,sealDailySecret,openDailySecret,nextDailySendAt,dailyTargetKey,validateDailyConfig} from '../server/services/customer-daily-report-config.js';
import {buildCustomerDailyMetricEvidence,observationPayloadWithDailyEvidence} from '../server/services/customer-daily-metric-evidence.js';
const env = {CUSTOMER_DAILY_REPORT_ENCRYPTION_KEY:'a1'.repeat(32)};

test('calendar waiting state is safe read-only metadata and does not fabricate a next working date', () => {
  const configured=mergeDailyConfig({}, {appId:'cli_test',appSecret:'secret',folderToken:'folder',documentBaseUrl:'https://example.feishu.cn',editorType:'openchat',editorId:'oc_editor',chatId:'oc_chat'},'tenant',env);
  const enabled=mergeDailyConfig(configured,{customerEditVerified:true,autoEnabled:true},'tenant',env);
  const waiting={...enabled,calendarPending:{year:2027,untrustedExtra:'do-not-expose'}};
  const visible=publicDailyConfig(waiting);
  assert.equal(visible.calendarPendingYear,2027);
  assert.match(visible.calendarError,/2027.*日历待更新/);
  assert.equal(visible.calendarPending,undefined);
  assert.equal(JSON.stringify(visible).includes('do-not-expose'),false);
  const patched=mergeDailyConfig(waiting,{calendarPending:null,calendarPendingYear:null,calendarError:null},'tenant',env);
  assert.equal(publicDailyConfig(patched).calendarPendingYear,2027);
  assert.equal(publicDailyConfig({...waiting,autoEnabled:false}).calendarPendingYear,null);
  assert.equal(publicDailyConfig({...waiting,autoEnabled:false}).calendarError,null);
  assert.throws(()=>nextDailySendAt('09:00',new Date('2026-12-31T01:00:00Z')),{code:'CHINA_WORK_CALENDAR_UNAVAILABLE',year:2027});
});

test('daily secrets are authenticated, tenant-bound, omitted from reads and retained on blank form submission', () => {
  const sealed = sealDailySecret('private-secret','tenant-a','appSecret',env);
  assert.ok(!sealed.includes('private-secret'));
  assert.equal(openDailySecret(sealed,'tenant-a','appSecret',env),'private-secret');
  assert.throws(() => openDailySecret(sealed,'tenant-b','appSecret',env));
  assert.throws(() => openDailySecret(sealed,'tenant-a','webhookSecret',env));
  assert.throws(() => sealDailySecret('x','a','appSecret',{}));
  const config = mergeDailyConfig({}, {appId:'cli_test',appSecret:'private-secret'},'tenant-a',env);
  const next = mergeDailyConfig(config,{appSecret:''},'tenant-a',env);
  assert.equal(config.appSecretEncrypted,next.appSecretEncrypted);
  assert.equal(JSON.stringify(publicDailyConfig(next)).includes('private-secret'),false);
  assert.equal('appSecretEncrypted' in publicDailyConfig(next),false);
  assert.equal(resolvedDailyConfig(next,'tenant-a',env).appSecret,'private-secret');
});

test('external collaboration settings do not silently inherit acceptance across target or owner changes', () => {
  const input = {appId:'cli_test',appSecret:'secret',folderToken:'folder',documentBaseUrl:'https://example.feishu.cn',editorType:'email',editorId:'editor@example.com',customerEditVerified:true,chatId:'oc_chat'};
  const first=mergeDailyConfig({},input,'tenant',env);
  assert.equal(first.customerEditVerified,false);
  const verified=mergeDailyConfig(first,{customerEditVerified:true,autoEnabled:true},'tenant',env);
  assert.equal(verified.autoEnabled,true);
  assert.throws(()=>mergeDailyConfig(verified,{editorId:'different@example.com'},'tenant',env));
  const changed=mergeDailyConfig(verified,{editorId:'different@example.com',autoEnabled:false},'tenant',env);
  assert.equal(changed.customerEditVerified,false);
  assert.throws(()=>mergeDailyConfig(first,{autoEnabled:'true'},'tenant',env));
  assert.throws(()=>mergeDailyConfig(first,{sendTime:'25:00'},'tenant',env));
});

test('Feishu targets reject unsafe origins and use stable per-group message identity', () => {
  for(const documentBaseUrl of ['http://test.feishu.cn','https://feishu.cn.attacker.invalid','https://x.feishu.cn@127.0.0.1','https://x.feishu.cn:444','https://x.feishu.cn/path']) assert.throws(()=>mergeDailyConfig({}, {documentBaseUrl},'t',env));
  for(const webhookUrl of ['http://open.feishu.cn/open-apis/bot/v2/hook/abc','https://127.0.0.1/hook','https://open.feishu.cn/open-apis/bot/v2/hook/abc?token=hidden']) assert.throws(()=>mergeDailyConfig({}, {webhookUrl},'t',env));
  assert.equal(dailyTargetKey({channel:'app',appId:'a',chatId:'b'}),dailyTargetKey({channel:'app',appId:'a',chatId:'b'}));
  assert.notEqual(dailyTargetKey({channel:'app',appId:'a',chatId:'b'}),dailyTargetKey({channel:'app',appId:'a',chatId:'c'}));
});

test('manual delivery can verify live permissions before customer acceptance while automatic delivery requires acceptance', () => {
  const config=mergeDailyConfig({}, {appId:'cli_test',appSecret:'secret',folderToken:'folder',documentBaseUrl:'https://example.feishu.cn',editorType:'openchat',editorId:'oc_editor',chatId:'oc_chat'},'tenant',env);
  assert.equal(config.customerEditVerified,false);
  assert.doesNotThrow(()=>validateDailyConfig(config,{send:true}));
  assert.throws(()=>validateDailyConfig(config,{send:true,automatic:true}),{code:'daily_customer_edit_verification_required'});
  assert.throws(()=>mergeDailyConfig(config,{autoEnabled:true},'tenant',env),{code:'daily_customer_edit_verification_required'});
  assert.throws(()=>validateDailyConfig({...config,chatId:''},{send:true}),/群 ID/);
  assert.throws(()=>validateDailyConfig({...config,editorId:''},{send:true}),/编辑者/);
  assert.throws(()=>validateDailyConfig({...config,appSecretEncrypted:''},{send:true}),/密钥/);
});

test('automatic send starts with next Shanghai occurrence and handles month/year edges', () => {
  assert.equal(nextDailySendAt('09:00',new Date('2026-09-08T00:59:59Z')),'2026-09-08T01:00:00.000Z');
  assert.equal(nextDailySendAt('09:00',new Date('2026-09-08T01:00:00Z')),'2026-09-09T01:00:00.000Z');
  assert.throws(()=>nextDailySendAt('00:00',new Date('2026-12-31T16:00:00Z')),{code:'CHINA_WORK_CALENDAR_UNAVAILABLE'});
});

test('daily metric evidence distinguishes measured zero, missing, carried-forward and unproven timestamps', () => {
  const input={likes:200,comments_count:0,collects:0,shares:0,capture_timestamp:'2026-09-07T10:00:00+08:00'};
  const full=buildCustomerDailyMetricEvidence(input,{preserved:false},new Date('2026-09-07T03:00:00Z'));
  assert.equal(full.allMeasured,true);
  assert.equal(full.observedAt,'2026-09-07T02:00:00.000Z');
  const preserved=buildCustomerDailyMetricEvidence(input,{preserved:true,reason:'not_observed'});
  assert.equal(preserved.allMeasured,false);
  assert.equal(preserved.metrics.comments_count.measured,false);
  assert.equal(buildCustomerDailyMetricEvidence({...input,shares:null},{preserved:false}).allMeasured,false);
  assert.equal(buildCustomerDailyMetricEvidence({...input,capture_timestamp:'2026-09-07 10:00:00'},{preserved:false}).observedAt,null);
  assert.equal(buildCustomerDailyMetricEvidence(input,{preserved:false},new Date('2026-09-07T01:00:00Z')).observedAt,null);
  const payload=JSON.parse(observationPayloadWithDailyEvidence({title:'kept',customerDailyMetricEvidence:{forged:true}},full));
  assert.equal(payload.title,'kept');
  assert.deepEqual(payload.customerDailyMetricEvidence,full);
});
