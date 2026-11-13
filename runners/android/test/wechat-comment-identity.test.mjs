import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {textsAgree,mergeCommentScreens,parseCommentScreen} from '../src/device/wechat-comments-parse.mjs';
const c=(content,reply=false,extras={})=>({author:'同一位车主',content,reply,likeCount:null,...extras});
const fixture = JSON.parse(readFileSync(new URL('./fixtures/wechat/comments-retest-20261113.json', import.meta.url)));
const topLevel = screens => screens.map(rows => {
  const parsed = parseCommentScreen(rows);
  return {...parsed, comments: parsed.comments.filter(item => !item.reply)};
});

test('real Dou-dou replay classifies the merged byline by its indented body and leaves nine distinct top-level comments', () => {
  const parsed = parseCommentScreen(fixture['dou-dou'][1]);
  assert.equal(parsed.comments.find(item => item.author === '悟3~')?.reply, true);
  const comments = mergeCommentScreens(topLevel(fixture['dou-dou']));
  assert.deepEqual(comments.map(item => item.author), [
    '垄断悠闲', '养鱼新手2480', 'Rookie V', '發0713發', '魏来可期-8880', '晨曦', '八九区我的', '符号Ing', '温柔的梦里久',
  ]);
  assert.equal(comments.find(item => item.author === '符号Ing').content, '壁纸怎么弄的？');
  assert.ok(comments.every(item => item.reply === false && item.parentIndex === null));
});

test('real Gao replay preserves both different comments from 唯', () => {
  const items = mergeCommentScreens(topLevel(fixture.gao));
  assert.deepEqual(items.map(item => [item.author, item.content]),
    [['唯', '前提我需要一个 优盘里面的内容'], ['唯', '来一个']]);
});

test('one-character differences merge only on adjacent screens with the same author, place and time', () => {
  const context = {location: '江苏', timeLabel: '2小时前'};
  const one = c('壁纸怎么弄的？', false, context);
  const two = c('壁纸怎么弄？', false, context);
  const panel = (...comments) => ({comments});
  for (const readings of [[one, two], [two, one]]) {
    // OCR variants and two genuine near-identical comments with the same visible byline are indistinguishable.
    assert.deepEqual(mergeCommentScreens(readings.map(item => panel(item))).map(item => item.content), [one.content]);
  }
  assert.equal(mergeCommentScreens([panel(one, two)]).length, 2);
  assert.equal(mergeCommentScreens([panel(one), panel(), panel(two)]).length, 2);
  for (const change of [{author: '另一位车主'}, {location: '山东'}, {timeLabel: '1小时前'}, {location: ''}]) {
    assert.equal(mergeCommentScreens([panel(one), panel({...two, ...change})]).length, 2);
  }
  assert.equal(mergeCommentScreens([panel(one), panel(c('来一个', false, context))]).length, 2);
});
test('emoji/punctuation comments need a nonempty exact comparable identity',()=>{
  for(const [a,b]of [['👍👍','😡😡'],['？？？','！！！'],['',''],['   ','']])assert.equal(textsAgree(a,b),false);
  assert.equal(textsAgree('👍👍','👍👍'),true);assert.equal(textsAgree('？？？','???'),true);
  assert.equal(mergeCommentScreens([{comments:[c('👍👍'),c('😡😡'),c('？？？'),c('！！！')]}]).length,4);
});
test('prefix merge requires the shorter reading to be explicitly cut, in either order',()=>{
  const short='今天车子的颜色非常好看',long=short+'但是内饰我不喜欢';
  assert.equal(textsAgree(short,long),false);assert.equal(textsAgree(long,short),false);
  assert.equal(textsAgree(short,long,{bCut:true}),false);assert.equal(textsAgree(short,long,{aCut:true}),true);
  assert.equal(textsAgree(long,short,{bCut:true}),true);
  assert.equal(mergeCommentScreens([{comments:[c(short)]},{comments:[c(long)]}]).length,2);
  const merged=mergeCommentScreens([{comments:[c(short,false,{cut:true})]},{comments:[c(long)]}]);
  assert.equal(merged.length,1);assert.equal(merged[0].content,long);
});
test('same author and text stay separate for main comments and replies under different parents',()=>{
  const screen={comments:[c('确实'),c('确实',true),c('另一个楼层的内容'),c('确实',true),c('[图片]',true)]};
  const second={comments:[c('另一个楼层的内容'),c('确实',true),c('[图片]',true)]};
  const merged=mergeCommentScreens([screen,second]);assert.equal(merged.length,5);
  assert.deepEqual(merged.map(r=>r.parentIndex),[null,0,null,2,2]);
});
test('clean suffix noise before filtering and quota, and do not attach overflow replies to the last retained parent',()=>{
  const merged=mergeCommentScreens([{comments:[c('首评'),c('展开3条回复'),c('真实内容'),c('第二条真实内容')]}],{limit:2});
  assert.deepEqual(merged.map(r=>r.content),['真实内容','第二条真实内容']);
  const floor=mergeCommentScreens([{comments:[c('主楼一'),c('确实',true),c('满额后主楼二'),c('确实更长',true)]}],{limit:2});
  assert.equal(floor[1].content,'确实');
  const rows=[{text:'评论 2',x:130,y:650,w:120,h:32},{text:'车主 广东 1天前',x:150,y:740,w:300,h:32},{text:'（',x:150,y:800,w:40,h:32},
    {text:'车主乙 广东 1天前',x:150,y:900,w:300,h:32},{text:'第二条真实内容',x:150,y:960,w:300,h:32}];
  assert.deepEqual(parseCommentScreen(rows).comments.map(r=>r.content),['第二条真实内容']);
});
