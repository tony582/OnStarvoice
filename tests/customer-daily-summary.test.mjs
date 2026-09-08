import assert from 'node:assert/strict';
import test from 'node:test';
import {mergeCustomerDailySummary} from '../server/services/customer-daily-reports.js';

function summary() {
  return {day:{monitor:100,sdb:80,positive:30,neutral:20,negative:0,cold:0,unclassified:30,nonMonitor:20,inProgress:null,processed:null},
    mtd:{monitor:300,sdb:240,positive:90,neutral:60,negative:0,cold:0,unclassified:90,nonMonitor:60,inProgress:null,processed:null}};
}

test('manual handling counts fill unknown cells without overwriting system classification or source summary', () => {
  const original = summary();
  const before = structuredClone(original);
  const edited = mergeCustomerDailySummary(original,{day:{inProgress:5,processed:3},mtd:{inProgress:10,processed:null}});
  assert.equal(edited.day.inProgress,5);
  assert.equal(edited.day.processed,3);
  assert.equal(edited.mtd.processed,null);
  assert.equal(edited.day.negative,0,'AI classification remains the original measured result, not a handling total');
  assert.equal(edited.day.unclassified,30);
  assert.deepEqual(original,before);
});

test('all seven editable quantities accept a coherent correction while retaining unclassified room', () => {
  const edited = mergeCustomerDailySummary(summary(),{day:{monitor:110,sdb:90,positive:31,neutral:21,cold:2,inProgress:3,processed:4},
    mtd:{monitor:310,sdb:250,positive:91,neutral:61,cold:5,inProgress:9,processed:12}});
  assert.equal(edited.day.monitor,110);
  assert.equal(edited.mtd.processed,12);
  assert.ok(edited.day.positive+edited.day.neutral+edited.day.cold+edited.day.inProgress+edited.day.processed<edited.day.sdb);
});

test('summary edits reject invalid quantities, hidden classification fields and impossible totals', () => {
  const patches = [null,[],{}, {day:{}}, {date:'2026-09-08'}, {day:{negative:5}}, {day:{monitor:null}},
    {day:{inProgress:-1}}, {day:{processed:1.5}}, {day:{processed:'2'}}, {day:{processed:Number.MAX_SAFE_INTEGER+1}},
    {day:{sdb:101}}, {day:{positive:81}}, {day:{inProgress:31}},
    {day:{inProgress:5},mtd:{inProgress:4}}];
  for (const patch of patches) assert.throws(() => mergeCustomerDailySummary(summary(),patch), error => error.code==='daily_summary_invalid');
});

test('clearing a known handling value returns an empty cell without changing the remaining row', () => {
  const current = summary();current.day.processed=3;current.mtd.processed=8;
  const next = mergeCustomerDailySummary(current,{day:{processed:null},mtd:{processed:null}});
  assert.equal(next.day.processed,null);assert.equal(next.mtd.processed,null);
  assert.equal(next.day.monitor,current.day.monitor);
});
