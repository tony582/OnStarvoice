import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {renderCustomerDailySummaryPng,renderCustomerDailySummarySvg} from '../server/services/customer-daily-report-image.js';

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
