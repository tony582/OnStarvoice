import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeRecordPatches, mergePatchMaps, reconcileQueryRecords } from '../web/admin/src/lib/triage-edit-context.js';

const queue = readFileSync(new URL('../web/admin/src/pages/workbench/TriageQueue.tsx', import.meta.url), 'utf8');
function action(name, next, context) {
  const snippet = queue.slice(queue.indexOf(`  const ${name} =`), queue.indexOf(`  const ${next} =`));
  // These callbacks contain erasable annotations only. Keep the server-only Node 18 CI
  // independent of frontend build dependencies while executing the real callback bodies.
  const js = `${snippet}\nreturn ${name}`
    .replace(/recordId: string, fields: ManualRecordFields/g, 'recordId, fields')
    .replace(/: Promise<boolean>/g, '')
    .replace(/: TriageMode/g, '')
    .replace(/let data: ManualFieldsMutationResponse/g, 'let data')
    .replace(/api\.(get|patch|request)<[^>]+>/g, 'api.$1')
    .replace(/ as Error & \{ cause\?: unknown \}/g, '')
    .replace(/options\?: \{ silent\?: boolean \}/g, 'options');
  return new Function(...Object.keys(context), js)(...Object.values(context));
}
const rows = () => [{id:'a',sentiment:'negative',triage_status:'unhandled'}, {id:'b',sentiment:'negative',triage_status:'unhandled'}];
test('saved edits keep membership/order and accumulate actual values without mutating original records', () => {
  const original = rows();
  const patches = mergePatchMaps({a:{sentiment:'neutral'}}, {A:{triage_status:'reviewed',progress_latest_body:'跟进备注'}});
  const next = mergeRecordPatches(original, patches);
  assert.deepEqual(next.map(r=>r.id), ['a','b']);
  assert.equal(next[0].sentiment,'neutral');
  assert.equal(next[0].progress_latest_body,'跟进备注');
  assert.equal(original[0].sentiment,'negative');
  assert.equal(next[1], original[1]);
});
test('fresh query drops old retained rows, but never loses saves completed during that query', () => {
  assert.deepEqual(reconcileQueryRecords([rows()[1]], rows(), {}), [rows()[1]]);
  const next = reconcileQueryRecords([rows()[1]],rows(),{a:{sentiment:'neutral'}});
  assert.equal(next.find(r=>r.id==='a').sentiment,'neutral');
  assert.deepEqual(reconcileQueryRecords(rows(),rows(),{a:{_removedFromContext:true}}).map(r=>r.id),['b']);
});
test('unselected manual edit stays visible and keeps the drawer on the saved record', async () => {
  let visible=rows(), drawer=visible[0];
  const edit = action('updateManualFields','updateCustomTags', {
    archiveView:'active', api:{patch:async()=>({record:{sentiment:'neutral'}})},
    isApiNetworkError:()=>false, responseRecord:data=>data.record,
    localManualFieldsPatch:(fields,record)=>({...fields,...record}),
    applySavedEdits:patches=>{visible=mergeRecordPatches(visible,patches);drawer=mergeRecordPatches([drawer],patches)[0]},
    refreshBadges:()=>{},
  });
  assert.equal(await edit('a',{sentiment:'neutral'}),true);
  assert.deepEqual(visible.map(r=>r.id),['a','b']);
  assert.equal(drawer.id,'a');
  assert.equal(drawer.sentiment,'neutral');
});
test('failed save leaves record values and context intact', async () => {
  let patched=false;
  const edit=action('updateManualFields','updateCustomTags',{
    archiveView:'active',api:{patch:async()=>{throw new Error('保存失败')}},isApiNetworkError:()=>false,
    applySavedEdits:()=>{patched=true},
  });
  await assert.rejects(edit('a',{sentiment:'neutral'}),/保存失败/);
  assert.equal(patched,false);
});
for (const ids of [['a'],['a','b']]) test(`batch status preserves ${ids.length} selections and patches only acknowledged successes`,async()=>{
  let visible=rows(); const selected=new Set(ids);
  const batch=action('runBatch','syncArchiveLocally',{
    archiveView:'active',sel:{count:selected.size,selected,clear:()=>assert.fail('must keep selection')},
    CONTENT_TRIAGE_MODES:[{value:'reviewed',label:'已复核'}],askStatusChange:async()=>({note:'已核对'}),
    setBatchFeedback:()=>{},setBatchBusy:()=>{},api:{patch:async()=>({updatedIds:['a']})},
    changedBatchModeIds:result=>result.updatedIds,
    syncModeLocally:(changed,status)=>{visible=mergeRecordPatches(visible,Object.fromEntries(changed.map(id=>[id,{triage_status:status}])));},
    showBatchFeedback:()=>{},refreshBadges:()=>{},
  });
  await batch('reviewed');
  assert.deepEqual([...selected],ids);
  assert.equal(visible[0].triage_status,'reviewed');
  assert.equal(visible[1].triage_status,'unhandled');
  assert.equal(visible.length,2);
});
test('ordinary mutations never reload/filter the list or clear selection',()=>{
  for (const [start,end] of [['updateManualFields','updateCustomTags'],['updateCustomTags','closeBatchTagDialog'],['applyBatchCustomTags','deleteCustomTag'],['saveFeishuTableNo','syncModeLocally'],['changeTriageMode','changeRecordMode'],['runBatch','syncArchiveLocally'],['syncWatchedLocally','setRecordsWatched'],['toggleWatch','createPatrolFromSelection']]) {
    const block=queue.slice(queue.indexOf(`  const ${start} =`),queue.indexOf(`  const ${end} =`));
    assert.doesNotMatch(block,/\bload\(|sel\.clear\(|setDrawerRecord\(null\)|modeVisibleInCurrentList|leavesCurrentSentiment/,start);
  }
});
function queryHarness(get) {
  const state={records:rows(),pagination:null,saved:{},clears:0};
  const context={
    useCallback:fn=>fn,listRequestSeq:{current:0},editsRevision:{current:0},editJournal:{current:[]},
    setLoading:()=>{},filterParams:()=>new URLSearchParams({sentiment:'negative'}),pageSize:30,
    api:{get,request:get},mergePatchMaps,reconcileQueryRecords,
    view:'list',selectionSession:{current:false},listAbort:{current:null},listShown:{current:true},
    setListError:()=>{},triageLoadError:String,showBatchFeedback:()=>{},
    withTriageReadDeadline:(read,controller)=>read(controller.signal),readWithBusyRetry:read=>read(),
    setRecords:fn=>{state.records=fn(state.records)},setSavedEdits:value=>{state.saved=value},
    clearSelectionRef:{current:()=>{state.clears++}},setPagination:value=>{state.pagination=value},
  };
  return {state,context,load:action('load','cancelSelection',context)};
}
test('explicit refresh recovers an invalid last page after edited records leave the filter',async()=>{
  const pages=[];
  const h=queryHarness(async url=>{const page=Number(new URL(url,'https://local').searchParams.get('page'));pages.push(page);return {records:page===1?[rows()[1]]:[],pagination:{page,total:1,totalPages:1}}});
  await h.load(2);
  assert.deepEqual(pages,[2,1]);
  assert.equal(h.state.pagination.page,1);
  assert.deepEqual(h.state.records.map(r=>r.id),['b']);
  assert.equal(h.state.clears,1);
});
test('late older query response cannot replace a newer query or discard a concurrent save',async()=>{
  const pending=[];
  const h=queryHarness(()=>new Promise(resolve=>pending.push(resolve)));
  const older=h.load(); await Promise.resolve();
  const newer=h.load(); await Promise.resolve();
  h.context.editsRevision.current=1;
  h.context.editJournal.current.push({revision:1,patches:{a:{sentiment:'neutral'}}});
  pending[1]({records:[rows()[1]],pagination:{page:1,total:1,totalPages:1}});
  await newer;
  pending[0]({records:rows(),pagination:{page:1,total:2,totalPages:1}});
  await older;
  assert.equal(h.state.records.find(r=>r.id==='a').sentiment,'neutral');
  assert.equal(h.state.pagination.total,1);
  assert.equal(h.state.clears,1);
});
