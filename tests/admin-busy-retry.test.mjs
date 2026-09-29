import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {
  OVERVIEW_POLL_INTERVAL_MS,
  busyRetryDelayMs,
  isServerBusyError,
  overviewErrorMessage,
  overviewNextPollDelayMs,
  overviewNotRefreshedNotice,
  overviewReadOutcome,
  readWithBusyRetry,
} from '../web/admin/src/lib/busy-retry.mjs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const busy = (retryAfterMs = null) => Object.assign(new Error('任务看板查询繁忙，请稍后重试'), {
  status: 503, code: 'server_busy', retryAfterMs,
});

const serverError = message => Object.assign(new Error(message), {status: 500, code: 'server_error', retryAfterMs: null});

test('a busy server is a 503, server_busy, or a 500 that carries a transient database message', () => {
  assert.equal(isServerBusyError(busy()), true);
  assert.equal(isServerBusyError({status: 503}), true);
  assert.equal(isServerBusyError({status: 500, code: 'server_busy'}), true);
  // Session and tenant lookups run before the route and answer 500 with the database's own words.
  for (const message of [
    'Database general capacity is temporarily unavailable.',
    'Database reporting capacity is temporarily unavailable.',
    'Database critical capacity is temporarily unavailable.',
    'canceling statement due to statement timeout',
    'canceling statement due to lock timeout',
  ]) assert.equal(isServerBusyError(serverError(message)), true, message);
  for (const error of [
    null, undefined, 'server_busy', new Error('请求失败'),
    {status: 500, code: 'server_error'}, {status: 401}, {status: 409, code: 'task_not_clearable'},
    serverError('relation "capture_tasks" does not exist'),
    serverError('canceling statement due to user request'),
    serverError('deadlock detected'),
    Object.assign(new Error('Database general capacity is temporarily unavailable.'), {status: 403}),
    Object.assign(new Error('网络连接中断，请检查网络后重试'), {code: 'network_error'}),
  ]) assert.equal(isServerBusyError(error), false);
});

test('retry delays follow the server hint, double per attempt and stay bounded', () => {
  assert.equal(busyRetryDelayMs(busy(), 0), 1_000);
  assert.equal(busyRetryDelayMs(busy(), 1), 2_000);
  assert.equal(busyRetryDelayMs(busy(), 2), 4_000);
  assert.equal(busyRetryDelayMs(busy(), 5), 8_000);
  assert.equal(busyRetryDelayMs(busy(3_000), 0), 3_000);
  assert.equal(busyRetryDelayMs(busy(3_000), 1), 6_000);
  assert.equal(busyRetryDelayMs(busy(10), 0), 250);
  assert.equal(busyRetryDelayMs(busy(), -3), 1_000);
  assert.equal(busyRetryDelayMs(busy(), 0, {baseMs: 500, maxMs: 600}), 500);
  assert.equal(busyRetryDelayMs(busy(), 1, {baseMs: 500, maxMs: 600}), 600);
});

test('a busy read is retried, anything else and a cancelled read are not', async () => {
  const waits = [];
  const sleep = async delayMs => { waits.push(delayMs); };

  let attempts = 0;
  assert.equal(await readWithBusyRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw busy(1_500);
    return 'loaded';
  }, {retries: 2, sleep}), 'loaded');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1_500, 3_000]);

  attempts = 0;
  waits.length = 0;
  const lastBusy = busy();
  await assert.rejects(readWithBusyRetry(async () => { attempts += 1; throw lastBusy; }, {retries: 2, sleep}), error => error === lastBusy);
  assert.equal(attempts, 3, 'the first read plus two retries');
  assert.deepEqual(waits, [1_000, 2_000]);

  attempts = 0;
  waits.length = 0;
  const denied = Object.assign(new Error('无权访问'), {status: 403, code: 'forbidden'});
  await assert.rejects(readWithBusyRetry(async () => { attempts += 1; throw denied; }, {retries: 2, sleep}), error => error === denied);
  assert.equal(attempts, 1);
  assert.deepEqual(waits, []);

  attempts = 0;
  await assert.rejects(readWithBusyRetry(async () => { attempts += 1; throw busy(); }, {retries: 0, sleep}), /繁忙/u);
  assert.equal(attempts, 1, 'retries: 0 reads once');

  attempts = 0;
  const controller = new AbortController();
  await assert.rejects(readWithBusyRetry(async () => {
    attempts += 1;
    throw busy();
  }, {retries: 2, signal: controller.signal, sleep: async () => { controller.abort(); }}), /繁忙/u);
  assert.equal(attempts, 1, 'a read cancelled while waiting is not sent again');

  attempts = 0;
  controller.abort();
  await assert.rejects(readWithBusyRetry(async () => { attempts += 1; throw busy(); }, {retries: 2, signal: controller.signal, sleep}), /繁忙/u);
  assert.equal(attempts, 1);
});

test('the default wait ends early when the read is cancelled', async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  let attempts = 0;
  const pending = readWithBusyRetry(async () => { attempts += 1; throw busy(5_000); }, {retries: 1, signal: controller.signal});
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, /繁忙/u);
  assert.equal(attempts, 1);
  assert.ok(Date.now() - startedAt < 2_000, 'cancelling does not wait out the five seconds');
});

test('the board asks again soon after a busy answer and backs off after other failures', () => {
  assert.equal(OVERVIEW_POLL_INTERVAL_MS, 15_000);
  assert.equal(overviewNextPollDelayMs(), 15_000);
  assert.equal(overviewNextPollDelayMs({failureCount: 0, busy: true}), 15_000);
  assert.deepEqual(
    [1, 2, 3, 4].map(failureCount => overviewNextPollDelayMs({failureCount, busy: true})),
    [3_000, 6_000, 12_000, 15_000],
  );
  assert.deepEqual(
    [1, 2, 3, 4].map(failureCount => overviewNextPollDelayMs({failureCount, busy: false})),
    [30_000, 60_000, 120_000, 120_000],
    'unchanged for network and permission failures',
  );
  assert.equal(overviewNextPollDelayMs({failureCount: 'x', busy: true}), 15_000);
});

test('the notice says how old the shown board is, or that the page kept its own data', () => {
  assert.equal(overviewNotRefreshedNotice(12_400), '服务繁忙，任务看板暂时没有刷新：当前显示的是约 12 秒前的数据，系统会自动重试。');
  assert.equal(overviewNotRefreshedNotice(200), '服务繁忙，任务看板暂时没有刷新：当前显示的是约 1 秒前的数据，系统会自动重试。');
  for (const missing of [null, undefined, Number.NaN, -1]) {
    assert.equal(overviewNotRefreshedNotice(missing), '服务繁忙，任务看板暂时没有刷新：页面保留上一次的数据，系统会自动重试。');
  }
});

test('the board stays while the server is busy and says so; anything else is an error', () => {
  const board = {agents: [], tasks: [], summary: {}};
  const never = {loaded: false, failureCount: 0};
  const shown = {loaded: true, failureCount: 0};
  const notRefreshed = '服务繁忙，任务看板暂时没有刷新：页面保留上一次的数据，系统会自动重试。';

  // First read.
  assert.deepEqual(overviewReadOutcome(never, {data: board}),
    {loaded: true, busy: false, failureCount: 0, notice: '', error: ''});
  assert.deepEqual(overviewReadOutcome(never, {error: busy()}),
    {loaded: false, busy: true, failureCount: 1, notice: '', error: '任务看板查询繁忙，请稍后重试'},
    'nothing to keep: the page says the board is unavailable, and asks again soon');
  assert.deepEqual(overviewReadOutcome(never, {error: serverError('Database general capacity is temporarily unavailable.')}),
    {loaded: false, busy: true, failureCount: 1, notice: '', error: '任务看板查询繁忙，请稍后重试'},
    'the database\'s own words are not shown to operators');
  assert.deepEqual(overviewReadOutcome(never, {error: Object.assign(new Error('无权访问该租户'), {status: 403})}),
    {loaded: false, busy: false, failureCount: 1, notice: '', error: '无权访问该租户'});
  assert.deepEqual(overviewReadOutcome(never, {error: 'not an error object'}),
    {loaded: false, busy: false, failureCount: 1, notice: '', error: '读取云端任务中心失败'});

  // Board on screen.
  assert.deepEqual(overviewReadOutcome(shown, {error: busy()}),
    {loaded: true, busy: true, failureCount: 1, notice: notRefreshed, error: ''});
  assert.deepEqual(overviewReadOutcome({loaded: true, failureCount: 1}, {error: busy()}),
    {loaded: true, busy: true, failureCount: 2, notice: notRefreshed, error: ''});
  assert.deepEqual(overviewReadOutcome(shown, {error: new Error('网络连接中断，请检查网络后重试')}),
    {loaded: true, busy: false, failureCount: 1, notice: '', error: '网络连接中断，请检查网络后重试'},
    'a failure that is not a busy server keeps the red banner and the long backoff');

  // The server answered with its last complete projection.
  assert.deepEqual(overviewReadOutcome(shown, {data: {...board, stale: true, staleAgeMs: 12_400}}),
    {loaded: true, busy: true, failureCount: 1, error: '',
      notice: '服务繁忙，任务看板暂时没有刷新：当前显示的是约 12 秒前的数据，系统会自动重试。'});
  assert.deepEqual(overviewReadOutcome(never, {data: {...board, stale: true, staleAgeMs: 3_000}}).loaded, true,
    'a stale answer is still a board to show');

  // Recovery clears everything; failures never count past four.
  assert.deepEqual(overviewReadOutcome({loaded: true, failureCount: 3}, {data: board}),
    {loaded: true, busy: false, failureCount: 0, notice: '', error: ''});
  assert.equal(overviewReadOutcome({loaded: true, failureCount: 4}, {error: busy()}).failureCount, 4);
  assert.equal(overviewReadOutcome({loaded: true, failureCount: 9}, {data: {...board, stale: true}}).failureCount, 4);

  for (const outcome of [
    overviewReadOutcome(never, {error: busy()}), overviewReadOutcome(shown, {error: busy()}),
    overviewReadOutcome(shown, {data: {...board, stale: true}}), overviewReadOutcome(shown, {error: new Error('x')}),
  ]) assert.equal(Boolean(outcome.notice) && Boolean(outcome.error), false, 'never both');

  assert.equal(overviewErrorMessage(busy()), '任务看板查询繁忙，请稍后重试');
  assert.equal(overviewErrorMessage(new Error('请先登录')), '请先登录');
  assert.equal(overviewErrorMessage(null), '读取云端任务中心失败');
});

test('failed responses keep their status, code and retry hint for the pages', () => {
  const api = source('web/admin/src/lib/api.ts');
  assert.match(api, /export class ApiResponseError extends Error/u);
  assert.match(api, /throw new ApiResponseError\(responseMessage\(data, '请求失败'\), resp\.status, data\)/u);
  assert.match(api, /this\.code = typeof body\.error === 'string' \? body\.error : ''/u);
  assert.match(api, /this\.retryAfterMs = Number\.isFinite\(retryAfterMs\) && retryAfterMs > 0 \? retryAfterMs : null/u);
});

test('the dispatch page keeps its board through a busy server', () => {
  const page = source('web/admin/src/pages/dispatch/DispatchPage.tsx');
  // What the page does with a read is decided by overviewReadOutcome (tested above); this pins the wiring.
  assert.match(page, /const previous = \{ loaded: overviewLoaded\.current, failureCount: overviewLoadFailureCount\.current \}/u);
  // No data yet: retry before showing an empty board. Data shown: one read per poll.
  assert.match(page, /readWithBusyRetry\(\s*\(\) => api\.get<[^\n]+>\('\/capture-cloud\/overview'\),\s*\{ retries: previous\.loaded \? 0 : 3 \},\s*\)/u);
  assert.match(page, /setOverview\(\{[^\n]+\}\)\s*outcome = overviewReadOutcome\(previous, \{ data \}\)\s*\} catch \(err\) \{\s*outcome = overviewReadOutcome\(previous, \{ error: err \}\)\s*\} finally \{\s*setLoading\(false\)\s*setRefreshing\(false\)\s*\}/u);
  assert.match(page, /overviewLoaded\.current = outcome\.loaded\s*overviewLoadBusy\.current = outcome\.busy\s*overviewLoadFailureCount\.current = outcome\.failureCount\s*setRefreshNotice\(outcome\.notice\)\s*setError\(outcome\.error\)/u);
  assert.match(page, /schedule\(overviewNextPollDelayMs\(\{\s*failureCount: overviewLoadFailureCount\.current,\s*busy: overviewLoadBusy\.current,\s*\}\)\)/u);
  assert.match(page, /\{!error && refreshNotice && <div role="status" aria-live="polite"/u);
  assert.doesNotMatch(page, /15_000 \* retryMultiplier/u);
});

test('sidebar counts ask for a recount only after the caller changed data', () => {
  const badges = source('web/admin/src/lib/badges.tsx');
  assert.match(badges, /fresh \? '\/workspace\/badges\?fresh=1' : '\/workspace\/badges'/u);
  assert.match(badges, /const refresh = useCallback\(\(\) => read\(true\), \[read\]\)/u);
  assert.match(badges, /read\(false\)\s+const timer = window\.setInterval\(\(\) => read\(false\), POLL_MS\)/u);
  assert.match(badges, /if \(document\.visibilityState === 'visible'\) read\(false\)/u);
  assert.match(badges, /<BadgesContext\.Provider value=\{\{ badges, features, refresh \}\}>/u);
});
