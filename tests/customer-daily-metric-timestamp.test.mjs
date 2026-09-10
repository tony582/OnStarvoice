import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeRecord} from '../server/routes/sync.js';
import {
  buildCustomerDailyMetricEvidence,
  observationPayloadWithDailyEvidence,
  parseCustomerDailyCaptureTimestamp,
  recoverCustomerDailyObservationTime,
} from '../server/services/customer-daily-metric-evidence.js';

const capture = 1788935784995;
const observedAt = '2026-09-09T06:36:24.995Z';
const ingestedAt = '2026-09-09T06:36:27.645Z';
const metrics = {likes:2000,comments_count:10,collects:4,shares:2};
const oldStamp = () => ({version:1,allMeasured:true,observedAt:null,timeSource:'ingested_at',
  metrics:Object.fromEntries(Object.entries(metrics).map(([key,value]) => [key,{value,measured:true,reason:'observed'}]))});
const observation = (payload = {captureTimestamp:capture}) => ({...metrics,captured_at:ingestedAt,
  payload:{...payload,customerDailyMetricEvidence:oldStamp()}});

test('capture milliseconds from real client payloads and explicit timezone ISO resolve to the same instant', () => {
  for (const value of [capture,String(capture),observedAt,'2026-09-09T14:36:24.995+08:00','2026-09-09T14:36:24.995+0800']) {
    assert.equal(parseCustomerDailyCaptureTimestamp(value,ingestedAt),observedAt);
  }
  assert.equal(parseCustomerDailyCaptureTimestamp(1788879227215,ingestedAt),'2026-09-08T14:53:47.215Z');
  assert.equal(parseCustomerDailyCaptureTimestamp('2024-02-29T23:00:00+08:00',ingestedAt),'2024-02-29T15:00:00.000Z');
});

test('timestamp parsing rejects seconds, unsafe or malformed values, impossible dates and future measurements', () => {
  for (const value of [null,undefined,true,{},NaN,Infinity,Number.MAX_SAFE_INTEGER + 1,capture + 0.5,
    1788935784,'1788935784','1.788935784995e12',' 1788935784995','01788935784995',
    '2026-09-09T14:36:24.995','2026-09-09 14:36:24+08:00','2026-02-30T00:00:00Z',
    '2026-09-09T24:00:00Z','1999-12-31T23:59:59Z','2026-09-09T06:36:28Z',Date.parse(ingestedAt) + 1]) {
    assert.equal(parseCustomerDailyCaptureTimestamp(value,ingestedAt),null,String(value));
  }
  for (const upperBound of [null,'',NaN,'invalid']) assert.equal(parseCustomerDailyCaptureTimestamp(capture,upperBound),null);
});

test('new service evidence handles the normalized numeric string while preserving metric completeness and provenance', () => {
  const full = buildCustomerDailyMetricEvidence({...metrics,capture_timestamp:String(capture)}, {preserved:false}, new Date(ingestedAt));
  assert.equal(full.observedAt,observedAt);
  assert.equal(full.timeSource,'capture_timestamp');
  assert.equal(full.allMeasured,true);
  const partial = buildCustomerDailyMetricEvidence({...metrics,shares:null,capture_timestamp:capture}, {preserved:true,reason:'preserved'}, new Date(ingestedAt));
  assert.equal(partial.allMeasured,false);
  assert.equal(partial.metrics.shares.measured,false);
  assert.equal(partial.metrics.comments_count.measured,false);
  const forged = {...oldStamp(),observedAt,timeSource:'capture_timestamp'};
  const invalid = buildCustomerDailyMetricEvidence({...metrics,capture_timestamp:'unproven',customerDailyMetricEvidence:forged}, {}, new Date(ingestedAt));
  const payload = JSON.parse(observationPayloadWithDailyEvidence({captureTimestamp:'unproven',customerDailyMetricEvidence:forged},invalid));
  assert.equal(payload.customerDailyMetricEvidence.observedAt,null);
  assert.equal(recoverCustomerDailyObservationTime({...metrics,captured_at:ingestedAt,payload}),null);
});

test('read-only recovery repairs the exact old numeric timestamp failure without changing persisted evidence', () => {
  const row = observation();
  const before = JSON.stringify(row);
  assert.deepEqual(recoverCustomerDailyObservationTime(row), {observedAt,timeSource:'capture_timestamp',recovered:true,sourcePath:'payload.captureTimestamp'});
  assert.equal(JSON.stringify(row),before);
  assert.equal(recoverCustomerDailyObservationTime({...row,payload:JSON.stringify(row.payload)}).observedAt,observedAt);
  assert.equal(recoverCustomerDailyObservationTime(observation({capture_timestamp:String(capture)})),null);
  assert.equal(recoverCustomerDailyObservationTime(observation({captureTimestamp:observedAt})),null);
});

test('recovery refuses legacy, incomplete, preserved, mismatched and already timestamped observations', () => {
  const invalidRows = [
    {...observation(),payload:{captureTimestamp:capture,...metrics}},
    {...observation(),likes:1999},
    {...observation(),captured_at:'invalid'},
    {...observation(),captured_at:undefined},
    {...observation(),captured_at:null},
    {...observation(),captured_at:''},
    observation({captureTimestamp:'2026-09-09T14:36:24'}),
    observation({captureTimestamp:Date.parse(ingestedAt) + 1}),
  ];
  for (const patch of [{version:0},{allMeasured:false},{observedAt},{timeSource:'capture_timestamp'}]) {
    const row = observation(); Object.assign(row.payload.customerDailyMetricEvidence,patch); invalidRows.push(row);
  }
  for (const patch of [{measured:false},{reason:'preserved'},{value:null},{value:'2000'}]) {
    const row = observation(); Object.assign(row.payload.customerDailyMetricEvidence.metrics.likes,patch); invalidRows.push(row);
  }
  const missing = observation(); delete missing.payload.customerDailyMetricEvidence.metrics.shares; invalidRows.push(missing);
  for (const row of invalidRows) assert.equal(recoverCustomerDailyObservationTime(row),null);
});

test('historical recovery selects exactly the timestamp normalizeRecord used, including empty details and falsey values', () => {
  const earlier = capture - 86400000;
  const cases = [
    [{captureTimestamp:earlier,detailPayload:{captureTimestamp:capture}},capture],
    [{captureTimestamp:earlier,items:[{captureTimestamp:capture}]},capture],
    [{captureTimestamp:earlier,items:[{captureTimestamp:earlier,detailPayload:{captureTimestamp:capture}}]},capture],
    [{captureTimestamp:earlier,detailPayload:{},items:[{captureTimestamp:earlier,detailPayload:{captureTimestamp:capture}}]},earlier],
    [{captureTimestamp:earlier,detailPayload:null,items:[null,{detailPayload:{captureTimestamp:capture}}]},capture],
    [{captureTimestamp:earlier,detailPayload:{captureTimestamp:0},items:[{captureTimestamp:capture}]},earlier],
    [{captureTimestamp:earlier,detailPayload:{captureTimestamp:false}},earlier],
    [{captureTimestamp:earlier,detailPayload:'truthy',items:[{captureTimestamp:earlier,detailPayload:{captureTimestamp:capture}}]},earlier],
    [{captureTimestamp:earlier,detailPayload:{capture_timestamp:capture}},earlier],
    [{captureTimestamp:earlier,detailPayload:{captureTimestamp:'invalid'}},null],
    [{capture_timestamp:capture},null],
    [{captureTimestamp:observedAt},null],
  ];
  for (const [payload,expected] of cases) {
    const normalized = normalizeRecord({payload})[0].capture_timestamp;
    const expectedTime = expected === null ? null : parseCustomerDailyCaptureTimestamp(expected,ingestedAt);
    assert.equal(expected === null ? null : parseCustomerDailyCaptureTimestamp(normalized,ingestedAt),expectedTime);
    assert.equal(recoverCustomerDailyObservationTime(observation(payload))?.observedAt || null,expectedTime,JSON.stringify(payload));
  }
  const firstObject = observation({items:[null,{captureTimestamp:capture}]});
  assert.equal(recoverCustomerDailyObservationTime(firstObject).sourcePath,'payload.items[1].captureTimestamp');
});
