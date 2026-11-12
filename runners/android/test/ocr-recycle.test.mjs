import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createOcrPool} from '../src/device/ocr-pool.mjs';
import {createOcrReadiness,OCR_WARMUP_RETRY_MS} from '../src/device/ocr-readiness.mjs';

const png=Buffer.from('89504e470d0a1a0a','hex');
async function flush(){for(let i=0;i<30;i++)await Promise.resolve();}
function fixture(t){
  t.mock.timers.enable({apis:['setTimeout']});
  let clock=1000;
  const directory=mkdtempSync(join(tmpdir(),'starvoice-ocr-recycle-')),workers=[],diagnostics=[];
  const pool=createOcrPool({binaryPath:process.execPath,tmpDir:directory,now:()=>clock,spawnImpl:()=>{
    const proc=new EventEmitter();
    Object.assign(proc,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),requests:[],signals:[]});
    proc.stdin.on('data',data=>proc.requests.push(JSON.parse(String(data))));
    proc.kill=signal=>{proc.signals.push(signal);proc.emit('close',0,signal);return true;};
    proc.reply=(body,index=proc.requests.length-1)=>proc.stdout.write(JSON.stringify({id:proc.requests[index].id,...body})+'\n');
    workers.push(proc);return proc;
  }});
  const readiness=createOcrReadiness({ocr:pool,now:()=>clock,loadImage:()=>png,onDiagnostic:event=>diagnostics.push(event)});
  t.after(()=>{readiness.close();pool.close();rmSync(directory,{recursive:true,force:true});});
  return {pool,readiness,workers,diagnostics,directory,
    async advance(ms){clock+=ms;t.mock.timers.tick(ms);await flush();},
    async fail(){clock+=20;workers.at(-1).reply({ok:false,error:'recognition_failed'});await flush();},
    async succeed(){workers.at(-1).reply({ok:true,rows:[{text:'Warmup'}]});await flush();}};
}

test('three fast warmup failures replace a fake helper and share a 120-second warmup through a slow cold success',async t=>{
  const f=fixture(t);f.readiness.start();await flush();
  await f.fail();await f.advance(OCR_WARMUP_RETRY_MS);
  await f.fail();await f.advance(OCR_WARMUP_RETRY_MS);
  let prepared=false;
  const preparing=f.readiness.ensureReady().then(()=>{prepared=true;});
  await f.fail();
  assert.equal(f.workers.length,2);assert.deepEqual(f.workers[0].signals,['SIGTERM']);
  assert.equal(f.workers[1].requests.length,1);assert.equal(f.pool.pending,1);
  assert.equal(f.readiness.status().reason,'ocr_warming');assert.equal(prepared,false);
  assert.equal(f.diagnostics.filter(event=>event.event==='ocr_helper_recycled').length,1);
  await assert.rejects(f.pool.recognize(png),error=>error.code==='ocr_unavailable' && error.details.error==='ocr_warming');
  const joined=f.readiness.ensureReady();
  await f.advance(40_000);
  assert.equal(f.pool.pending,1,'ordinary 15-second timeout cannot retire the 120-second replacement warmup');
  assert.equal(f.workers.length,2);assert.equal(f.workers[1].requests.length,1);
  assert.equal(f.readiness.status().readyForSearch,false);
  await f.succeed();await Promise.all([preparing,joined]);
  assert.equal(prepared,true);assert.equal(f.readiness.status().readyForSearch,true);
  assert.equal(f.readiness.status().lastWarmupMs,40_000);assert.deepEqual(readdirSync(f.directory),[]);
});

test('fast failures from real task recognition also recycle and warm while idle maintenance is paused',async t=>{
  const f=fixture(t);f.readiness.start();await flush();await f.succeed();
  f.readiness.setTaskActive(true);
  for(let i=0;i<3;i++){
    const recognition=f.pool.recognize(png);
    const failed=assert.rejects(recognition,{code:'ocr_failed'});
    await f.fail();await failed;
  }
  assert.equal(f.workers.length,2);assert.equal(f.workers[1].requests.length,1);
  assert.equal(f.readiness.status().readyForSearch,false);
  const preparing=f.readiness.ensureReady();
  await f.advance(108_000);
  assert.equal(f.pool.pending,1);assert.equal(f.workers.length,2);
  await f.succeed();await preparing;
  assert.equal(f.readiness.status().lastWarmupMs,108_000);
  assert.equal(f.readiness.status().readyForSearch,true);
});

test('cancellation during replacement warmup stops it and does not advertise readiness or restart immediately',async t=>{
  const f=fixture(t);f.readiness.start();await flush();
  await f.fail();await f.advance(OCR_WARMUP_RETRY_MS);
  await f.fail();await f.advance(OCR_WARMUP_RETRY_MS);
  const controller=new AbortController();
  const preparing=f.readiness.ensureReady({signal:controller.signal});
  await f.fail();assert.equal(f.workers.length,2);assert.equal(f.pool.pending,1);
  const reason=new Error('task stopped');controller.abort(reason);
  await assert.rejects(preparing,error=>error===reason);await flush();
  assert.equal(f.pool.pending,0);assert.equal(f.readiness.status().readyForSearch,false);
  assert.deepEqual(f.workers[1].signals,['SIGTERM']);
  await f.advance(OCR_WARMUP_RETRY_MS-1);assert.equal(f.workers.length,2);
  f.readiness.close();await f.advance(120_000);assert.equal(f.workers.length,2);
});

test('replacement warmup remains bounded at 120 seconds and cannot report false readiness on timeout',async t=>{
  const f=fixture(t);f.readiness.start();await flush();
  await f.fail();await f.advance(OCR_WARMUP_RETRY_MS);
  await f.fail();await f.advance(OCR_WARMUP_RETRY_MS);
  const preparing=f.readiness.ensureReady(),failed=assert.rejects(preparing,{code:'ocr_unavailable'});
  await f.fail();await f.advance(119_999);
  assert.equal(f.pool.pending,1);await f.advance(1);await failed;
  assert.equal(f.pool.pending,0);assert.equal(f.readiness.status().readyForSearch,false);
  assert.equal(f.readiness.status().reason,'ocr_unavailable');
  assert.equal(f.diagnostics.at(-1).code,'ocr_timeout');
});
