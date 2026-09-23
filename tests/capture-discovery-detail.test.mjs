import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createShareResolver,isPublicAddress} from '../server/services/capture-discovery/share-resolver.js';
import {canCaptureDiscoveredPost} from '../server/services/capture-discovery/detail-dispatch.js';
const canonical='https://www.douyin.com/video/7654321098765432109';

test('share resolver pins public DNS and accepts only bounded first-party redirects',async()=>{
  const seen=[];
  const resolve=createShareResolver({dnsLookup:async()=>[{address:'8.8.8.8',family:4}],
    request:async(url,options)=>{seen.push({url:url.href,...options}); return {status:302,location:canonical};}});
  assert.equal(await resolve('https://v.douyin.com/abc/'),canonical);
  assert.equal(seen[0].address,'8.8.8.8');
  for (const address of ['127.0.0.1','192.168.1.5','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1']) {
    assert.equal(isPublicAddress(address),false,address);
    let fetched=false;
    const reject=createShareResolver({dnsLookup:async()=>[{address,family:address.includes(':')?6:4}],
      request:async()=>{fetched=true;}});
    await assert.rejects(reject('https://v.douyin.com/abc/'),/UNSAFE_SHARE_ADDRESS/);
    assert.equal(fetched,false);
  }
});
test('resolver rejects malicious hosts, credentials, loops, and mixed DNS answers',async()=>{
  for (const location of ['https://evil.example/a','http://www.douyin.com/video/7654321098765432109',
    'https://name:secret@www.douyin.com/video/7654321098765432109','https://www.douyin.com:444/']) {
    const resolve=createShareResolver({dnsLookup:async()=>[{address:'8.8.8.8',family:4}],request:async()=>({status:302,location})});
    await assert.rejects(resolve('https://v.douyin.com/abc/'),/UNSAFE_SHARE_REDIRECT/);
  }
  let calls=0;
  const loop=createShareResolver({dnsLookup:async()=>[{address:'8.8.8.8',family:4}],
    request:async()=>{calls++;return {status:302,location:'https://v.douyin.com/abc/'};}});
  await assert.rejects(loop('https://v.douyin.com/abc/'),/SHARE_REDIRECT_LIMIT/);
  assert.equal(calls,4);
  await assert.rejects(createShareResolver({dnsLookup:async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]})('https://v.douyin.com/a/'),/UNSAFE_SHARE_ADDRESS/);
});
test('upgraded browser only: Android and old capability snapshots cannot claim detail',()=>{
  const capabilities={discoveredPostCaptureV1:true,remoteTargetedPostCaptureV1:true,remoteTaskCreate:true,
    remoteStop:true,supportedPlatforms:['douyin']};
  const agent={status:'active',allowed_platforms:['douyin'],capabilities};
  assert.equal(canCaptureDiscoveredPost(agent),true);
  assert.equal(canCaptureDiscoveredPost(agent,{...capabilities,agentKind:'android_mobile'}),false);
  assert.equal(canCaptureDiscoveredPost(agent,{...capabilities,discoveredPostCaptureV1:false}),false);
});
test('Extension accepts candidate workflow without fake records and requires real attempt identity',async()=>{
  const context=vm.createContext({URL,Date,Set});
  vm.runInContext(await readFile(new URL('../utils/cloud-targeted-post.js',import.meta.url),'utf8'),context);
  const api=context.OnStarvoiceCloudTargetedPost;
  const target={candidateId:randomUUID(),itemId:randomUUID(),externalId:'7654321098765432109',url:canonical,
    captureTaskItemAttemptId:randomUUID(),captureTaskItemRequestHash:'a'.repeat(64),
    captureTaskItemAttemptNumber:1,captureTaskItemAssignmentRevision:1};
  const payload={workflow:'discovered_post_capture',protocolVersion:1,taskId:randomUUID(),platform:'douyin',targets:[target]};
  const normalized=api.normalizeCommandPayload(payload);
  assert.equal(normalized.targets[0].candidateId,target.candidateId);
  assert.equal(normalized.targets[0].recordId,'');
  assert.equal(normalized.captureSettings.autoSyncAfterDetailCapture,true);
  assert.throws(()=>api.normalizeCommandPayload({...payload,targets:[{...target,recordId:randomUUID()}]}),{code:'DISCOVERY_CANDIDATE_INVALID'});
  assert.throws(()=>api.normalizeCommandPayload({...payload,targets:[{...target,captureTaskItemRequestHash:''}]}),{code:'DISCOVERY_LINEAGE_REQUIRED'});
  assert.throws(()=>api.normalizeCommandPayload({...payload,workflow:'negative_post_patrol'}),{code:'TARGET_RECORD_ID_REQUIRED'});
});
