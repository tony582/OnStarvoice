import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {normalizeBatch} from '../server/services/capture-discovery/validation.js';
import {resolveEventIdentity} from '../server/services/capture-discovery/identity.js';
import {matchesUiBoundRecord,assertUiBoundIngestion} from '../server/services/capture-discovery/ui-binding.js';
const taskId=randomUUID(), agentId=randomUUID();
const event={eventId:randomUUID(),taskId,discoveryRunId:taskId,itemId:randomUUID(),attemptId:randomUUID(),agentId,
  requestHash:'a'.repeat(64),assignmentRevision:1,discoveredAt:new Date().toISOString(),keyword:'别克壁纸',
  verification:'ui_bound',titleHint:'秋天的新壁纸 @上海安吉星信息服务有限公司',authorHint:'girl👧🏻',
  rawShareUrl:'https://v.douyin.com/example/',uiBinding:{profileId:'douyin-30.6.0-de106-api27-p0',cardId:'b'.repeat(64),kind:'note'}};
const url='https://www.douyin.com/note/7654321098765432109';
const record={url,title:event.titleHint,author_name:event.authorHint};
const normalize=value=>normalizeBatch({uploadBatchId:randomUUID(),events:[value]},{agentId}).events[0];
test('UI binding carries pending evidence without asserting independently verified work ID',async()=>{
  const value=normalize(event); assert.equal(value.verification,'ui_bound'); assert.equal(value.verifiedExternalId,'');
  assert.deepEqual(value.uiBinding,event.uiBinding);
  assert.equal((await resolveEventIdentity(value,async()=>url)).status,'resolved');
  assert.equal((await resolveEventIdentity(value,async()=>url.replace('/note/','/video/'))).reason,'work_kind_mismatch');
  for(const changed of [{titleHint:''},{authorHint:''},{verifiedExternalId:'7654321098765432109'},{uiBinding:null}]) {
    assert.throws(()=>normalize({...event,...changed}));
  }
});
// Since 2026-10-02 the copied link is the work's identity and the caption is not compared (the phone no
// longer expands collapsed captions to prove it). The author and the media kind are still checked.
test('independent detail must agree with actual author including emoji and media kind; the caption is not compared',async()=>{
  assert.equal(matchesUiBoundRecord(event,record),true);
  assert.equal(matchesUiBoundRecord(event,{...record,title:'秋天的新壁纸...'}),true);
  assert.equal(matchesUiBoundRecord(event,{...record,title:'',content:''}),true);
  await assertUiBoundIngestion({queryAll:async()=>[{payload:event}]},
    {tenantId:randomUUID(),candidateId:randomUUID(),record:{...record,title:'完全不同的正文'}});
  for(const changed of [{author_name:'上海安吉星信息服务有限公司'},
    {author_name:'girl'},{url:url.replace('/note/','/video/')},{url:'https://www.douyin.com/search/x?modal_id=7654321098765432109'}]) {
    assert.equal(matchesUiBoundRecord(event,{...record,...changed}),false);
    await assert.rejects(assertUiBoundIngestion({queryAll:async()=>[{payload:event}]},
      {tenantId:randomUUID(),candidateId:randomUUID(),record:{...record,...changed}}),{code:'DISCOVERY_DETAIL_IDENTITY_MISMATCH'});
  }
  assert.equal(matchesUiBoundRecord({...event,verification:'verified'},{}),true);
});

test('mobile leading author marker matches the existing PC collector without weakening other identity checks',async()=>{
  const observed={...event,titleHint:'#别克世家 的秋天的壁纸来了 期待车机优化和新的功能。#车主生活记录',
    authorHint:'@开世家的宝妈小闫',uiBinding:{...event.uiBinding,profileId:'douyin-40.6.0-de106-api27-p0'}};
  const captured={url,title:'#别克世家 的秋天的壁纸来了期待车机优化和新的功能。#车主生活记录',author_name:'开世家的宝妈小闫'};
  assert.equal(matchesUiBoundRecord(observed,captured),true);
  await assertUiBoundIngestion({queryAll:async()=>[{payload:observed}]},
    {tenantId:randomUUID(),candidateId:randomUUID(),record:captured});
  for(const changed of [{author_name:'上海安吉星信息服务有限公司'}, {author_name:'开世家的宝妈小阎'},
    {url:url.replace('/note/','/video/')}]) {
    assert.equal(matchesUiBoundRecord(observed,{...captured,...changed}),false);
  }
  assert.equal(matchesUiBoundRecord(observed,{...captured,title:'#别克世家 的秋天的壁纸来了...'}),true);
  assert.equal(matchesUiBoundRecord({...observed,authorHint:'用户@官方'}, {...captured,author_name:'用户官方'}),false);
  assert.equal(matchesUiBoundRecord({...observed,authorHint:'@@用户'}, {...captured,author_name:'用户'}),false);
  assert.equal(matchesUiBoundRecord({...observed,authorHint:'@'}, {...captured,author_name:'@'}),false);
  assert.equal(observed.authorHint,'@开世家的宝妈小闫','raw mobile evidence stays intact');
});

test('a captured caption that differs from the card (a missing emoji) no longer refuses a work whose author and kind match',()=>{
  const observed={...event,titleHint:'换上新壁纸，感觉整个人的磁场都变强了🚩。#汽车里的爱国情怀 #人民万岁',authorHint:'青椒炒红椒'};
  const captured={url,title:observed.titleHint,author_name:observed.authorHint};
  assert.equal(matchesUiBoundRecord(observed,{...captured,title:captured.title.replace('🚩','')}),true);
  assert.equal(matchesUiBoundRecord(observed,captured),true);
});
test('a long card caption is kept whole for display and does not affect matching',()=>{
  // 2026-10-01: a 2807-character caption was refused with its whole batch. The hint is hashed with the event,
  // so it is kept exactly as sent: events already stored by runner 0.2.8 must replay unchanged.
  const caption='十五万人走到漠北，找不到敌人。'.repeat(190);
  const observed=normalize({...event,titleHint:caption});
  assert.equal(observed.titleHint.length,caption.length);
  assert.equal(observed.payloadHash,normalize({...event,titleHint:caption}).payloadHash);
  const captured={url,title:caption.slice(0,40),content:caption.slice(0,500),author_name:event.authorHint};
  assert.equal(matchesUiBoundRecord(observed,captured),true);
  assert.equal(matchesUiBoundRecord({...observed,titleHint:caption.slice(0,2000)},captured),true);
});
