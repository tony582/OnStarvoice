import test from 'node:test';
import assert from 'node:assert/strict';
import {matchFollowedCreator,normalizeCreatorNickname} from '../server/services/followed-creator-identity.js';
import {nextCreatorPatrolTime} from '../server/services/followed-creator-schedule.js';
import {creatorAlertEligible,creatorAlertFailure,creatorAlertPost} from '../server/services/followed-creator-alerts.js';
import {createFeishuDailyClient} from '../server/services/feishu-daily-report.js';
import {startSchedulerCronJobs,startAiCronJobs} from '../server/cron.js';
import {parseCreatorRoster,normalizeCreatorAccount} from '../server/services/followed-creator-roster.js';

test('creator matching is exact, platform scoped and safe for malformed UTF-16',()=>{
  const account={id:'one',platform:'douyin',keyword:'Sec_uid',account_no:'123',status:'active'};
  const base={platform:'douyin',record_type:'keyword_notes'};
  assert.equal(matchFollowedCreator({...base,author_id:'Sec_uid'},[account]),'one');
  assert.equal(matchFollowedCreator({...base,blogger_profile_url:'https://www.douyin.com/user/Sec_uid?from_tab_name=main'},[account]),'one');
  assert.equal(matchFollowedCreator({...base,author_account_no:'123'},[account]),'one');
  for (const fields of [{author_id:'sec_uid'},{author_id:'Sec_uid-long'},{author_name:'Sec_uid'},{author_account_no:'1234'},
    {blogger_profile_url:'https://douyin.com.example.com/user/Sec_uid'},{record_type:'official_content',author_id:'Sec_uid'}]) {
    assert.equal(matchFollowedCreator({...base,...fields},[account]),null);
  }
  assert.equal(matchFollowedCreator({...base,author_id:'Sec_uid'},[{...account,status:'paused'}]),null);
  const channel={id:'two',status:'active',platform:'wechat_channels',keyword:'sph-id',match_nicknames:['fm老常三一五']};
  assert.equal(matchFollowedCreator({platform:'wechat_channels',author_name:'ＦＭ 老常三一五🚗\uD83D'},[channel]),'two');
  assert.equal(matchFollowedCreator({platform:'wechat_channels',author_name:'FM老常三一五直播'},[channel]),null);
  assert.equal(matchFollowedCreator({platform:'wechat_channels',author_name:'sph-id'},[channel]),null);
  assert.equal(normalizeCreatorNickname('ＦＭ 老常三一五🚗\uD83D'),'fm老常三一五');
});

test('eligibility independently gates relevance, admission, age and switches',()=>{
  const now=Date.parse('2026-11-14T04:00:00Z');
  const record={followed_creator_subscription_id:'one',subscription_status:'active', alert_enabled:true,enabled:'true',
    business_visibility:'eligible',sentiment:'neutral',ai_result:{relevance:'uncertain'},created_at:'2026-11-14T02:00:00Z'};
  assert.equal(creatorAlertEligible(record,now),true);
  for (const change of [{ai_result:{relevance:'irrelevant'}},{keyword:'别克哨兵'},{publish_time:'2026-11-01T04:00:00Z'},
    {enabled:'false'},{alert_enabled:false},{business_visibility:'filtered_out'}]) {
    assert.equal(creatorAlertEligible({...record,...change},now),false,JSON.stringify(change));
  }
  assert.match(creatorAlertPost({creator:'测试',platform:'douyin',sentiment:'negative'}).zh_cn.title,/^负面 /u);
});

test('unknown webhook delivery is terminal and app transport carries the same UUID',async()=>{
  const uuid='7a27c810-3a11-4124-b997-458ba129c3b1';
  const base={documentBaseUrl:'https://test.feishu.cn'};
  const post={zh_cn:{title:'测试',content:[[{tag:'text',text:'测试'}]]}};
  let sends=0;
  const hook=createFeishuDailyClient({...base,channel:'webhook',
    webhookUrl:'https://open.feishu.cn/open-apis/bot/v2/hook/TestOnlyFake123',webhookSecret:'not-a-secret'},
  {timeoutMs:15,fetchImpl:async()=>{sends++;return new Promise(()=>{});}});
  await assert.rejects(hook.sendPost({post,uuid}),error=>creatorAlertFailure('webhook',1,error)==='ambiguous');
  assert.equal(sends,1);
  const keys=[];
  const app=createFeishuDailyClient({...base,channel:'app',appId:'cli_test',appSecret:'fake',chatId:'oc_test'},
    {fetchImpl:async(url,request)=>{
      if (url.includes('tenant_access_token')) return Response.json({code:0,tenant_access_token:'fake',expire:7200});
      keys.push(JSON.parse(request.body).uuid);
      return keys.length===1 ? new Response('',{status:502}) : Response.json({code:0,data:{message_id:'om_test'}});
    }});
  await assert.rejects(app.sendPost({post,uuid}),error=>creatorAlertFailure('app',1,error)==='pending');
  await app.sendPost({post,uuid});
  assert.deepEqual(keys,[uuid,uuid]);
});

test('the alert loop belongs to the scheduler and fixed times use Beijing time',()=>{
  const names=starter=>{
    const jobs=[];
    const runtime=starter({announce:false,cronModule:{schedule(_expr,_run,options){jobs.push(options.name);return {destroy(){}};}}});
    runtime.destroy();
    return jobs;
  };
  assert.ok(names(startSchedulerCronJobs).includes('onstarvoice:followed-creator-alerts'));
  assert.ok(!names(startAiCronJobs).includes('onstarvoice:followed-creator-alerts'));
  assert.equal(nextCreatorPatrolTime('10:00,16:00',new Date('2026-11-14T02:33:00Z')).toISOString(),'2026-11-14T08:00:00.000Z');
  assert.equal(nextCreatorPatrolTime('10:00',new Date('2026-11-14T02:01:00Z')).toISOString(),'2026-11-15T02:00:00.000Z');
});

test('Excel roster imports suspect identities with alerts disabled and auto patrol off',()=>{
  const text='博主 / 账号\t抖音名称\t抖音主页链接\t视频号名称\t视频号 ID\n880车世界\tFM880\thttps://www.douyin.com/user/first\t880车世界\tsph1\n\t880山西交通广播（疑似）\thttps://www.douyin.com/user/suspect\t880山西交通广播（疑似）\tsph2';
  const parsed=parseCreatorRoster(text).map(row=>normalizeCreatorAccount(row.input));
  assert.equal(parsed.length,4);
  assert.ok(parsed.every(r=>!r.autoPatrol && r.status==='active'));
  assert.ok(parsed.slice(0,2).every(r=>r.alertEnabled));
  assert.ok(parsed.slice(2).every(r=>!r.alertEnabled && r.label.includes('疑似')));
  assert.equal(parsed.at(-1).keyword,'sph2');
});
