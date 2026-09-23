import test from 'node:test';
import assert from 'node:assert/strict';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {runDiscoveryTask} from '../src/core/discovery-runner.mjs';
import {verifyLink} from '../src/core/discovery-evidence.mjs';
import {fixtureTask,fixtureClock,fixturePermit,fixtureDevice} from './core-fixtures.mjs';
const cardId='a'.repeat(64);
const binding={profileId:'douyin-30.6.0-de106-api27-p0',cardId,kind:'note'};
const detail={identityVerified:true,cardId,detailId:cardId};
const link={verification:'ui_bound',identityVerified:false,detailId:cardId,fresh:true,markerReplaced:true,
  cardDetailMatched:true,detailStillMatched:true,title:'新壁纸 @官方',author:'真实车主',
  shareUrl:'https://v.douyin.com/abc/',uiBinding:binding};
test('pending share links are durable candidates, counted across restart without claiming verified identity',async()=>{
  const task=fixtureTask({budgets:{maxLinks:1}}),clock=fixtureClock(),store=new RunnerStore(':memory:');
  const {device,calls}=fixtureDevice(task,{
    readCards:async()=>({contextVerified:true,contextId:'context-1',cards:[{cardId,title:link.title,author:link.author}],end:true}),
    openCard:async()=>detail, copyLink:async()=>link,
  });
  try {
    const result=await runDiscoveryTask({task,store,clock,device,permit:fixturePermit(task,clock)});
    assert.equal(result.status,'completed'); assert.ok(calls.includes('returnToResults'));
    const payload=store.getEvent(result.lastEventId).payload;
    assert.equal(payload.verification,'ui_bound'); assert.equal(payload.verifiedExternalId,null);
    assert.equal(payload.authorHint,'真实车主'); assert.deepEqual(store.discoveredWorkIds(task.identity),['ui:'+cardId]);
    assert.equal(result.stats.links,1);
  } finally {store.close();}
});
test('UI binding never exempts freshness, unchanged detail, known profile or URL checks',()=>{
  assert.doesNotThrow(()=>verifyLink(link,detail));
  for(const change of [{fresh:false},{markerReplaced:false},{detailStillMatched:false},{cardDetailMatched:false},
    {uiBinding:{...binding,profileId:'unknown'}},{shareUrl:'https://evil.test/a'}, {identityVerified:true}]) {
    assert.throws(()=>verifyLink({...link,...change},detail));
  }
});
