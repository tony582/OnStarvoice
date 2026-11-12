import assert from 'node:assert/strict';
import test from 'node:test';
import {completionStats} from '../server/services/android-control/completion-stats.js';
import {receiptStats,recoveryView,resumeError} from '../server/services/android-control/recovery.js';

const now=Date.parse('2026-11-12T04:00:00Z');
const task={task_type:'capture',status:'needs_action',metadata:{deadlineAt:new Date(now+60000).toISOString()}};
const item={item_type:'keyword',status:'needs_action',metadata:{deviceHeld:false}};
const agent={status:'active',last_liveness_at:new Date(now).toISOString(),capabilities:{agentKind:'android_mobile',readyForSearch:true}};

test('forward recovery is forbidden by either task type or item type in both preview and action policy',()=>{
  for(const [run,items] of [
    [{...task,task_type:'wechat_forward'},[item]],
    [task,[{...item,item_type:'wechat_forward'}]],
  ]) {
    assert.equal(resumeError(run,items,now),'WECHAT_FORWARD_NOT_RESUMABLE');
    const preview=recoveryView(run,items,agent,now);
    assert.equal(preview.canResume,false);
    assert.equal(preview.resumeError,'WECHAT_FORWARD_NOT_RESUMABLE');
  }
  assert.equal(resumeError(task,[item],now),null);
});

test('a held forward still requires closure and never becomes resumable',()=>{
  const items=[{...item,item_type:'wechat_forward',metadata:{deviceHeld:true}}];
  assert.equal(resumeError(task,items,now),'STOP_OR_DEVICE_CLOSURE_REQUIRED');
  assert.equal(recoveryView(task,items,agent,now).canResume,false);
});

test('receipt projection shares completion counters for Channels and articles, including malformed input handling',()=>{
  const stats={posts:2,previewFailed:1,previewUnavailable:3,comments:4,partialBodies:5,unavailableBodies:6,
    timeUnverified:7,pageFailures:8,cardsSeen:9,opened:10,outsideWindow:11,stopReason:2,screens:12,
    links:-1,cards:Infinity,privateTitle:'not a statistic'};
  assert.deepEqual(receiptStats({runner:{stats}}),{
    posts:2,previewFailed:1,previewUnavailable:3,outsideWindow:11,comments:4,partialBodies:5,
    unavailableBodies:6,timeUnverified:7,pageFailures:8,cardsSeen:9,opened:10,stopReason:2,screens:12,
  });
  for(const source of [stats,{},null,undefined,[],42,'invalid',{stopReason:1.5,screens:0}]) {
    assert.deepEqual(receiptStats({runner:{stats:source}}),completionStats(source));
  }
});
