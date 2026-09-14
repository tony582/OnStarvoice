import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {renderCustomerDailySummaryPng,renderCustomerDailySummarySvg} from '../server/services/customer-daily-report-image.js';
import {collectionHandlingSnapshot} from './fixtures/customer-daily-v5.mjs';

const counts={monitor:100,sdb:80,positive:30,neutral:35,negative:15,cold:6,inProgress:null,processed:null};
const snapshot=(day={},mtd={})=>({reportDate:'2026-09-07',summary:{day:{...counts,...day},mtd:{...counts,monitor:500,...mtd}}});

test('summary renders a decodable PNG with the supplied font and fixed table dimensions',()=>{
  const png=renderCustomerDailySummaryPng(snapshot());
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.length>1000 && png.length<10*1024*1024);
  assert.deepEqual(png.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  assert.equal(png.toString('ascii',12,16),'IHDR');
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  assert.equal(width,1282);
  assert.equal(height,230);
  assert.equal(png[24],8);
  assert.equal(png[25],6); // Eight-bit RGBA, decoded below rather than merely inspecting the extension.
  const idat=[];
  let ended=false;
  for(let position=8;position<png.length;){
    const length=png.readUInt32BE(position),type=png.toString('ascii',position+4,position+8);
    assert.ok(position+length+12<=png.length);
    if(type==='IDAT')idat.push(png.subarray(position+8,position+8+length));
    if(type==='IEND')ended=true;
    position+=length+12;
  }
  assert.equal(ended,true);
  assert.ok(idat.length>0);
  assert.equal(inflateSync(Buffer.concat(idat)).length,height*(width*4+1));
});

test('manually saved handling values including zero affect both SVG text and PNG bytes',()=>{
  const blank=snapshot();
  const entered=snapshot({inProgress:0,processed:18},{inProgress:47,processed:219});
  const svg=renderCustomerDailySummarySvg(entered);
  for(const value of [0,18,47,219])assert.match(svg,new RegExp(`>${value}</text>`));
  assert.notDeepEqual(renderCustomerDailySummaryPng(blank),renderCustomerDailySummaryPng(entered));
  assert.deepEqual(renderCustomerDailySummaryPng(entered),renderCustomerDailySummaryPng(entered));
  assert.doesNotMatch(renderCustomerDailySummarySvg(blank),/>null<|>undefined<|>NaN</);
});

test('invalid core summary values cannot generate a seemingly valid numeric image',()=>{
  assert.throws(()=>renderCustomerDailySummaryPng(snapshot({monitor:-1})),/数值无效/);
  assert.throws(()=>renderCustomerDailySummaryPng(snapshot({monitor:Infinity})),/数值无效/);
  assert.throws(()=>renderCustomerDailySummaryPng(snapshot({monitor:1.5})),/数值无效/);
  assert.throws(()=>renderCustomerDailySummaryPng({reportDate:'invalid'}),/尚未就绪/);
});

test('v3 PNG contains two distinct tables, grouped handling headers and no empty holiday rows', () => {
  const value = {monitor: 2, sdb: 2, positive: 1, neutral: 0, negative: 1, cold: 1, comment: 0, negativeProcess: 0, negativeOther: 0};
  const source = {reportDate: '2026-09-07', summary: {format: 'daily_handling_v3', day: value, mtd: value, rows: [
    {date: '2026-09-05', isWorkingDay: false, counts: {monitor: 0}}, {date: '2026-09-06', isWorkingDay: false, counts: value},
  ]}, collectionSummary: {format: 'daily_disposition_v2', day: value, mtd: {...value, monitor: 15}, rows: [
    {date: '2026-09-05', isWorkingDay: false, counts: {monitor: 0}}, {date: '2026-09-07', isWorkingDay: true, counts: value},
  ]}};
  const svg = renderCustomerDailySummarySvg(source);
  for (const label of ['每日舆情处理量', '实际采集量', '走负面处理流程', '本月处理累计', '本月采集去重累计', '2026/9/6', '采集量']) assert.ok(svg.includes(label));
  assert.doesNotMatch(svg, /2026\/9\/5|休假|>休<|NaN|undefined/);
  assert.equal((svg.match(/>MTD</g) || []).length, 2);
  const png = renderCustomerDailySummaryPng(source);
  assert.equal(png.readUInt32BE(16), 1407);
  assert.equal(png.readUInt32BE(20), 606);
  source.collectionSummary.mtd.monitor = -1;
  assert.throws(() => renderCustomerDailySummaryPng(source), /数值无效/);
});

test('v4 PNG preserves the grouped nine-column layout for a single collection table and one frozen MTD', () => {
  const value = {monitor: 2, sdb: 2, positive: 1, neutral: 0, negative: 1, cold: 1, comment: 0, negativeProcess: 0, negativeOther: 0};
  const source = {schemaVersion: 4, reportDate: '2026-09-07', summary: {format: 'daily_collection_v4', day: value, mtd: {...value, monitor: 15}, rows: [
    {date: '2026-09-05', isWorkingDay: false, counts: {monitor: 0}}, {date: '2026-09-06', isWorkingDay: false, counts: value},
  ]}};
  const svg = renderCustomerDailySummarySvg(source);
  for (const label of ['每日舆情处理量', '首次入库采集统计', '平台监控量', '走负面处理流程', '本月去重累计', '2026/9/6']) assert.ok(svg.includes(label));
  assert.doesNotMatch(svg, /实际采集量|本月处理累计|本月采集去重累计|2026\/9\/5|休假|>休<|NaN|undefined/);
  assert.equal((svg.match(/>MTD</g) || []).length, 1);
  assert.match(svg, />15<\/text>/);
  const png = renderCustomerDailySummaryPng(source);
  assert.equal(png.readUInt32BE(16), 1407);
  assert.equal(png.readUInt32BE(20), 354);
});

test('v5 image retains holiday handling events and independent frozen MTD in a single grouped table', () => {
  const source = collectionHandlingSnapshot(), original = structuredClone(source);
  const svg = renderCustomerDailySummarySvg(source);
  for (const label of ['采集列按采集日期统计', '四项负面按实际处理日期计次数（含旧帖）', 'MTD 按帖去重', '本月去重累计', '2026/9/12', '2026/9/14']) assert.ok(svg.includes(label));
  assert.doesNotMatch(svg, /2026\/9\/13|首次入库采集统计|实际采集量|>休<|NaN|undefined/);
  assert.equal((svg.match(/>MTD</g) || []).length, 1);
  for (const value of [280, 1243, 932]) assert.ok(svg.includes(`>${value}</text>`));
  const png = renderCustomerDailySummaryPng(source);
  assert.equal(png.readUInt32BE(16), 1407);
  assert.equal(png.readUInt32BE(20), 404);
  const changed = structuredClone(source); changed.summary.mtd.comment = 5;
  assert.notDeepEqual(png, renderCustomerDailySummaryPng(changed), 'image uses frozen MTD comment=2 rather than recomputing daily 3+2');
  assert.deepEqual(source, original);
});
