import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const ts = createRequire(new URL('../web/admin/package.json', import.meta.url))('typescript');
const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const compiled = ts.transpileModule(source('web/admin/src/lib/triage-load.ts'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { withTriageReadDeadline, triageLoadError, TRIAGE_READ_TIMEOUT_MS } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('a stalled triage response exits loading and aborts its underlying read at the deadline', async () => {
  const controller = new AbortController();
  let requestSignal;
  await assert.rejects(withTriageReadDeadline(signal => {
    requestSignal = signal;
    return new Promise(() => {});
  }, controller, 10), /内容加载超时/);
  assert.equal(requestSignal.aborted, true);
  assert.equal(TRIAGE_READ_TIMEOUT_MS, 25000);
});

test('successful and failed reads preserve their actual result and clear the timeout', async () => {
  const controller = new AbortController();
  const data = { records: [{ id: 'a' }] };
  assert.equal(await withTriageReadDeadline(async () => data, controller, 10), data);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(controller.signal.aborted, false);
  const error = new Error('Database general capacity is temporarily unavailable');
  await assert.rejects(withTriageReadDeadline(async () => { throw error; }, controller, 10), value => value === error);
});

test('capacity failure, timeouts and invalid responses have explicit actionable error copy', () => {
  assert.equal(triageLoadError(new Error('Database general capacity is temporarily unavailable')), '当前服务暂时繁忙，内容加载失败，请稍后重试。');
  assert.equal(triageLoadError(new Error('request timed out')), '内容加载超时，请稍后重试。');
  assert.equal(triageLoadError(new Error('网络连接中断，请检查网络后重试')), '网络连接中断，请检查网络后重试');
  assert.equal(triageLoadError(new Error('internal postgres query exception')), '内容暂时加载失败，请稍后重试。');
});

test('list and board cancel superseded reads, load unrestricted selections and expose retries instead of false empty results', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const board = source('web/admin/src/pages/workbench/TriageBoard.tsx');
  assert.doesNotMatch(queue, /if \(intents\.length === 0\)/);
  assert.match(queue, /listAbort\.current\?\.abort\(\)/);
  // 列表读取仍在 25 秒时限和取消信号之内；服务繁忙的自动重试包在时限里面。
  assert.match(queue, /withTriageReadDeadline\(signal => readWithBusyRetry\(\s*\(\) => api\.request<TriageListResponse>\('\/triage\/records\?' \+ params, \{ signal \}\),\s*\{ retries: 2, signal \},\s*\), controller\)/);
  // 静默重读只在列表正显示当前筛选的结果时才静默：失败保留列表、给一条提示。
  // 列表区是错误面板或旧筛选的结果时按用户发起的读取处理，失败换成错误面板。
  assert.match(queue, /const silent = Boolean\(options\?\.silent\) && listShown\.current\s+if \(!silent\) \{\s+listShown\.current = false\s+setListError\(''\)\s+\}/);
  assert.match(queue, /if \(!silent\) setLoading\(true\)/);
  assert.match(queue, /setPagination\(data\.pagination \|\| null\)\s+listShown\.current = true/);
  assert.match(queue, /if \(silent\) showBatchFeedback\(`\$\{triageLoadError\(err\)\}列表保留刷新前的内容。`, 'error'\)\s+else setListError\(triageLoadError\(err\)\)/);
  // 筛选变化立即读取（进入加载状态），旧列表不会在新筛选下继续可点。
  assert.match(queue, /useEffect\(\(\) => \{\s+void load\(\)\s+return \(\) => \{ listRequestSeq\.current \+= 1; listAbort\.current\?\.abort\(\) \}\s+\}, \[load\]\)/);
  assert.match(queue, /listError \? \([\s\S]{0,100}role="alert"/);
  assert.match(queue, /setListError\(triageLoadError\(err\)\)/);
  assert.match(queue, /重试加载/);
  assert.doesNotMatch(board, /getAll\('intent'\)\.includes\('none'\)|未勾选意图/);
  assert.match(board, /start \+= 2/);
  assert.match(board, /requestAbort\.current\?\.abort\(\)/);
  assert.match(board, /if \(loadError\) return <div role="alert"/);
  assert.doesNotMatch(board, /\.catch\(\(\) => \[column\.key, \[\]\]/);
});
