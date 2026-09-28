import test from 'node:test';
import assert from 'node:assert/strict';
import {contentTopicInitializationInput, parseContentTopicInitialization} from '../server/services/content-topic-initialization.js';

test('topic initialization maps every result by index and rejects missing, duplicate or out-of-range classifications', () => {
  const records = [{id:'a'}, {id:'b'}];
  assert.deepEqual(parseContentTopicInitialization({results:[{index:1,scope:'saic_gm',topic:'wallpaper'}, {index:0,scope:'other_or_unknown',topic:'gm_other'}]}, records).map(row=>[row.recordId,row.topic]), [['a','gm_other'],['b','wallpaper']]);
  for (const results of [[], [{index:0,topic:'onstar'}], [{index:0,topic:'onstar'},{index:0,topic:'wallpaper'}], [{index:0,topic:null},{index:1,topic:'wallpaper'}], [{index:0,topic:'onstar'},{index:2,topic:'wallpaper'}]]) {
    assert.throws(() => parseContentTopicInitialization({results}, records));
  }
});

test('initialization rejects a specific theme without confirming the discussed brand scope', () => {
  const records = [{id:'other-brand'}];
  for (const scope of [undefined, 'unknown', 'other_or_unknown']) {
    assert.throws(() => parseContentTopicInitialization({results:[{index:0,scope,topic:'sentry'}]},records));
  }
  assert.equal(parseContentTopicInitialization({results:[{index:0,scope:'other_or_unknown',topic:'gm_other'}]},records)[0].topic,'gm_other');
});

test('initialization sends post evidence but excludes customer notes, status and unrelated transcripts', () => {
  const input = JSON.parse(contentTopicInitializationInput([{id:'a',title:'别克OTA壁纸丢了',content:'如何恢复壁纸',note:'客户私有备注',status:'negative_comment',transcript_status:'done',transcript:'不属于当前视频',transcript_source_url:'https://example.com/old',video_url:'https://example.com/new'}]));
  assert.equal(input.records[0].transcript,'');
  assert.equal(input.records[0].content,'如何恢复壁纸');
  assert.ok(!JSON.stringify(input).includes('客户私有备注'));
  assert.ok(!JSON.stringify(input).includes('negative_comment'));
});
