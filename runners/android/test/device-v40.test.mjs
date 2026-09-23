import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUiTree} from '../src/device/ui-tree.mjs';
import {searchEntryNodes,resource,readFilters,filtersMatch} from '../src/device/douyin-profile.mjs';
import {createAppiumClient} from '../src/device/appium.mjs';
import {copyBoundShare} from '../src/device/douyin-share.mjs';
import {FILTER_GROUPS,semanticFilterSelector} from '../src/device/douyin-semantic-filters.mjs';
const node=(attrs,body='')=>`<node package="com.ss.android.ugc.aweme" displayed="true" enabled="true" bounds="[0,0][100,100]" ${attrs}>${body}</node>`;
const tree=body=>parseUiTree(`<hierarchy>${body}</hierarchy>`);
const label=text=>node(`class="android.widget.TextView" text="${text}"`);
const choice=text=>node('class="android.view.View" clickable="true"',
  node(`class="android.view.View" content-desc="已选中，${text}，按钮"`,label(text)));
const panel=(change={})=>node('class="android.widget.ScrollView"',FILTER_GROUPS.map(group=>label(group)+choice(change[group]??(
  group==='排序依据'?'最新发布':group==='发布时间'?'一天内':'不限'))).join(''));

test('40.6 reuses the same resource for menu and search: only the accessible search name is accepted',()=>{
  const body=node(`resource-id="${resource('hmy')}"`)+node(`resource-id="${resource('hmy')}" content-desc="搜索"`);
  assert.equal(searchEntryNodes(tree(body)).length,1);
  assert.equal(searchEntryNodes(tree(body+node(`resource-id="${resource('hmy')}" content-desc="搜索"`))).length,2);
});
test('semantic filters read all six groups including location and reject ambiguous selections',()=>{
  const values=readFilters(tree(panel()));
  assert.equal(Object.keys(values).length,6);assert.equal(filtersMatch(values,{sort:'最新发布',time:'一天内'}),true);
  assert.equal(filtersMatch(readFilters(tree(panel({'位置距离':'同城'}))),{sort:'最新发布',time:'一天内'}),false);
  assert.throws(()=>readFilters(tree(panel()+panel())),{code:'filter_ambiguous'});
});
test('session closure requires invalid-session response; an unsupported route or network error is not closure',async()=>{
  const make=error=>createAppiumClient({fetchImpl:async()=>new Response(JSON.stringify({value:{error}}),{status:404})});
  assert.equal(await make('invalid session id').isSessionActive('owned'),false);
  await assert.rejects(make('unknown command').isSessionActive('owned'),{code:'appium_http_error'});
});

test('filter selection binds repeated unlimited choices to their observed group and rejects missing targets',()=>{
  const target=(value,bounds)=>`<node class="android.view.View" package="com.ss.android.ugc.aweme" displayed="true" clickable="true" bounds="${bounds}">${label(value)}</node>`;
  const body=node('class="android.widget.ScrollView"',label('排序依据')+target('综合排序','[0,0][100,100]')
    +label('发布时间')+target('不限','[0,100][100,200]')+label('视频时长')+target('不限','[0,200][100,300]'));
  const selector=semanticFilterSelector('视频时长','不限',tree(body));
  assert.ok(selector.includes("@bounds='[0,200][100,300]'"));
  assert.throws(()=>semanticFilterSelector('发布时间','一天内',tree(body)),{code:'filter_ambiguous'});
  assert.throws(()=>semanticFilterSelector('未知组','不限',tree(body)),{code:'filter_unverified'});
});

test('copy confirmation is closed before detail identity recheck and original clipboard is restored',async()=>{
  const card={title:'新壁纸',author:'车主'},marker='starvoice-discovery:00000000-0000-4000-8000-000000000001';
  const byId=(id,text='')=>node(`resource-id="${resource(id)}" text="${text}"`);
  const detail=tree(byId('tv_desc',card.title)+byId('w67',card.author)+byId('n00'));
  const sheet=tree(node('content-desc="分享链接"'));
  const confirmation=tree(byId('zz4','链接已复制成功，去粘贴分享：')+byId('zzz'));
  let current=detail,clipboard='original',closed=0;
  const ui={getClipboard:async()=>clipboard,setClipboard:async text=>{clipboard=text;},read:async()=>current,
    clickId:async id=>{if(id==='n00')current=sheet;else {assert.equal(id,'zzz');closed++;current=detail;}},
    clickXPath:async()=>{clipboard='看看【车主的图文作品】新壁纸 https://v.douyin.com/validLink/';current=confirmation;},
    waitFor:async predicate=>{assert.equal(predicate(current),true);return current;}};
  const result=await copyBoundShare({ui,card,before:{...card,kind:'note',share:'n00'},marker});
  assert.equal(closed,1);assert.equal(clipboard,'original');assert.equal(result.identityVerified,false);
});
