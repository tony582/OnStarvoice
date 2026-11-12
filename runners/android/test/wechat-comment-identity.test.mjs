import test from 'node:test';
import assert from 'node:assert/strict';
import {textsAgree,mergeCommentScreens,parseCommentScreen} from '../src/device/wechat-comments-parse.mjs';
const c=(content,reply=false,extras={})=>({author:'同一位车主',content,reply,likeCount:null,...extras});
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
