import assert from 'node:assert/strict';
import test from 'node:test';

import { DbCapacityError } from '../server/db/query.js';
import { AiAdmissionError } from '../server/services/ai-admission.js';
import {
  LABEL_FAILURE_BUDGET,
  LABEL_FAILURE_RETRY_DELAYS_SECONDS,
  LABEL_FAILURE_RULES_VERSION,
  LABEL_RETRY_DUE_SQL,
  classifyLabelError,
  isLabelAttemptBlocked,
  planLabelFailure,
  readLabelFailure,
} from '../server/services/ai-label-failure.js';

const withProps = (message, props, name = 'Error') => Object.assign(new Error(message), { name }, props);
const pg = (code, message = 'pg error') => withProps(message, { code, severity: 'ERROR' });
const http = (status, code = 'LLM_HTTP_ERROR') => withProps(`LLM API error ${status}: {}`, { code, status });

test('分类：会在同一条记录上重复出现的失败计入，自己会好或不是这条记录的错不计入', () => {
  const cases = [
    // 计入：数据库拒绝这条记录的写入
    ['PG 22P02（本次事故：jsonb 里的孤立代理项）', pg('22P02', 'invalid input syntax for type json'), true],
    ['PG 22P02（confidence 不是数字）', pg('22P02', 'invalid input syntax for type real: "high"'), true],
    ['PG 22021（字符串里有 NUL）', pg('22021'), true],
    ['PG 22P05（jsonb 里有 NUL）', pg('22P05'), true],
    ['PG 22003（数值越界）', pg('22003'), true],
    ['PG 23514（检查约束）', pg('23514'), true],
    ['PG 23505（并发唯一冲突）', pg('23505'), true],
    ['PG 54000（索引行超长）', pg('54000'), true],
    ['PG 未识别的 SQLSTATE', pg('P0001'), true],
    ['JS TypeError（数据让归一化出错）', new TypeError('x is not iterable'), true],
    ['JS RangeError（嵌套过深）', new RangeError('Maximum call stack size exceeded'), true],
    // 计入：模型回复不可用，或提供商拒绝这条输入
    ['模型 JSON 无法解析', withProps('LLM JSON 解析失败', { code: 'LLM_JSON_PARSE_FAILED', finishReason: 'length' }), true],
    ['模型返回空结果', withProps('模型返回了空结果', { code: 'LABEL_MODEL_EMPTY_RESULT' }), true],
    ['HTTP 400（内容审核或请求有误）', http(400), true],
    ['HTTP 413（提示词太大）', http(413), true],
    ['HTTP 422', http(422), true],
    ['200 响应体不是 JSON', new SyntaxError('Unexpected token < in JSON at position 0'), true],
    ['中转返回结果无效', withProps('invalid', { code: 'LLM_RELAY_RESULT_INVALID', status: 502 }), true],
    ['中转提示词过大', withProps('too large', { code: 'LLM_RELAY_PROMPT_TOO_LARGE', status: 413 }), true],
    ['没人预料到的错误', new Error('something new'), true],
    ['throw 了 undefined', undefined, true],
    // 不计入：数据库忙或连接问题
    ['应用的数据库容量闸口', new DbCapacityError('general', 500), false],
    ['PG 40P01 死锁', pg('40P01'), false],
    ['PG 40001 序列化失败', pg('40001'), false],
    ['PG 55P03 锁等待超时', pg('55P03'), false],
    ['PG 57014 语句超时', pg('57014'), false],
    ['PG 57P01 后端被终止', pg('57P01'), false],
    ['PG 53300 连接数过多', pg('53300'), false],
    ['PG 08006 连接失败', pg('08006'), false],
    ['pg 驱动：连接被终止', new Error('Connection terminated unexpectedly'), false],
    // 不计入：提供商忙、不可达或超时
    ['AI 准入队列超时', new AiAdmissionError('AI_ADMISSION_QUEUE_TIMEOUT', 'queue timeout'), false],
    ['AI 准入队列已满', new AiAdmissionError('AI_ADMISSION_QUEUE_FULL', 'queue full'), false],
    ['HTTP 429', http(429, 'LLM_RATE_LIMITED'), false],
    ['HTTP 503', http(503), false],
    ['HTTP 529', http(529), false],
    ['HTTP 408', http(408), false],
    ['请求超时（DOMException TimeoutError）', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), false],
    ['中转代理离线', withProps('offline', { code: 'LLM_RELAY_AGENT_OFFLINE', status: 503 }), false],
    ['中转忙', withProps('busy', { code: 'LLM_RELAY_BUSY', status: 429 }), false],
    // 不计入：租户配置问题
    ['HTTP 401（密钥无效）', http(401), false],
    ['HTTP 402（余额不足）', http(402), false],
    ['HTTP 403', http(403), false],
    ['HTTP 404（模型或端点不存在）', http(404), false],
    ['中转配置错误', withProps('bad model', { code: 'LLM_RELAY_MODEL_INVALID', status: 400 }), false],
    ['端点 URL 无法解析', Object.assign(new TypeError('Failed to parse URL from x/chat/completions'), { cause: { code: 'ERR_INVALID_URL' } }), false],
    ['TLS 证书错误', Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }), false],
    ['API key 含非 ASCII 字符（请求没发出去）', new TypeError('Cannot convert argument to a ByteString because the character at index 5 has a value of 23494 which is greater than 255.'), false],
    // 不计入：网络
    ['连接被拒', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), false],
    ['连接被重置', Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }), false],
    ['EPIPE（五个大写字母，形状和 SQLSTATE 一样）', withProps('write EPIPE', { code: 'EPIPE' }), false],
    ['ECONNRESET', withProps('read ECONNRESET', { code: 'ECONNRESET' }), false],
    // 不计入：代码或结构问题，与这条记录无关
    ['PG 42P01 表不存在', pg('42P01'), false],
    ['PG 42703 列不存在', pg('42703'), false],
    ['PG 08P01 绑定参数个数不符（代码错误，不是连接问题）', pg('08P01'), false],
    ['PG 28P01 认证失败', pg('28P01'), false],
  ];
  for (const [name, error, counts] of cases) {
    const verdict = classifyLabelError(error);
    assert.equal(verdict.counts, counts, `${name}: counts (${verdict.reason})`);
    assert.match(verdict.reason, /^[a-z0-9_A-Z]+$/, `${name}: reason 是固定词汇，不含消息内容`);
  }
});

test('分类：DOMException 的数字 code 23 不能被当成 SQLSTATE 23（完整性约束）', () => {
  const timeout = new DOMException('timeout', 'TimeoutError');
  assert.equal(timeout.code, 23);
  assert.equal(classifyLabelError(timeout).counts, false);
});

test('分类：真实的 undici 网络错误从 cause.code 判断，不计入', async () => {
  const error = await fetch('http://127.0.0.1:1/').then(() => null, caught => caught);
  assert.ok(error, '夹具：本机 1 号端口应拒绝连接');
  assert.equal(error.message, 'fetch failed');
  assert.equal(error.code, undefined, '夹具：undici 的顶层没有 code');
  assert.equal(classifyLabelError(error).counts, false);
});

test('分类：真实的非 ASCII API key 请求头错误来自 fetch，不计入', async () => {
  const error = await fetch('http://127.0.0.1:1/', { headers: { Authorization: 'Bearer sk-密钥' } }).then(() => null, caught => caught);
  assert.ok(error, '夹具：非法请求头应在发请求前就抛错');
  assert.equal(error.name, 'TypeError');
  assert.equal(classifyLabelError(error).counts, false, error.message);
});

test('分类：先看错误码再看消息，消息里的数字不会改变结论', () => {
  // 旧的 classifyAiFailure 会把消息里的 503 读成 HTTP 状态。
  const dataError = pg('22P02', 'invalid input syntax for type real: "503"');
  assert.equal(classifyLabelError(dataError).counts, true);
  const busy = pg('57014', 'canceling statement due to statement timeout');
  assert.equal(classifyLabelError(busy).counts, false);
});

test('分类：常见的怪异错误形状不会让分类抛错（分类本身还被 noteLabelFailure 的 try 包着）', () => {
  for (const odd of ['a string', 42, {}, { message: 5 }, { code: 5 }, { code: {} }, { status: '400' }, Object.create(null)]) {
    assert.doesNotThrow(() => classifyLabelError(odd), JSON.stringify(odd));
  }
});

test('marker 读取：对象、字符串形式的 ai_result 和各种畸形形状', () => {
  const marker = { rules: LABEL_FAILURE_RULES_VERSION, attempts: 2, parked: false, nextAtEpoch: 1790000000.5, lastAtEpoch: 1789996400.25 };
  assert.deepEqual(readLabelFailure({ labelFailure: marker }), { rules: LABEL_FAILURE_RULES_VERSION, attempts: 2, parked: false, nextAtEpoch: 1790000000.5, lastAtEpoch: 1789996400.25 });
  assert.deepEqual(readLabelFailure(JSON.stringify({ labelFailure: marker })), readLabelFailure({ labelFailure: marker }));
  for (const bad of [null, undefined, '', 'not json', 5, [], {}, { labelFailure: null }, { labelFailure: [] }, { labelFailure: 'x' }, '"x"']) {
    assert.equal(readLabelFailure(bad), null, JSON.stringify(bad));
  }
  const odd = readLabelFailure({ labelFailure: { rules: 5, attempts: 'many', parked: 'true', nextAtEpoch: '12', lastAtEpoch: null } });
  assert.deepEqual(odd, { rules: '', attempts: 0, parked: false, nextAtEpoch: null, lastAtEpoch: null });
  // 手工改坏的次数不能让写入的 $4::int 溢出。
  assert.equal(readLabelFailure({ labelFailure: { attempts: 2 ** 40 } }).attempts, LABEL_FAILURE_BUDGET);
});

test('阻挡判断：已停放或还在等待的记录不再送模型，其他规则版本的 marker 被忽略', () => {
  const now = 1_790_000_000_000;
  const marker = patch => ({ labelFailure: { rules: LABEL_FAILURE_RULES_VERSION, attempts: 1, parked: false, nextAtEpoch: now / 1000 + 300, ...patch } });
  assert.equal(isLabelAttemptBlocked(marker({}), now), true, '等待期内');
  assert.equal(isLabelAttemptBlocked(marker({ nextAtEpoch: now / 1000 - 1 }), now), false, '到期');
  assert.equal(isLabelAttemptBlocked(marker({ parked: true, nextAtEpoch: null }), now), true, '已停放');
  assert.equal(isLabelAttemptBlocked(marker({ parked: true, rules: 'label-failure-v0' }), now), false, '旧规则版本的停放会被重试');
  assert.equal(isLabelAttemptBlocked(marker({ nextAtEpoch: null }), now), false, '没有等待时间');
  assert.equal(isLabelAttemptBlocked({}, now), false);
  assert.equal(isLabelAttemptBlocked(null, now), false);
});

test('预算：第 1 次等下一个批次，第 2 次等 1 小时，第 3 次停放；总数不超过预算', () => {
  assert.equal(LABEL_FAILURE_BUDGET, 3);
  assert.deepEqual([...LABEL_FAILURE_RETRY_DELAYS_SECONDS], [300, 3600]);
  let previous = null;
  const steps = [];
  for (let i = 0; i < 3; i += 1) {
    const plan = planLabelFailure({ previous });
    steps.push([plan.attempts, plan.parked, plan.delaySeconds]);
    previous = { rules: LABEL_FAILURE_RULES_VERSION, attempts: plan.attempts, parked: plan.parked, nextAtEpoch: null, lastAtEpoch: null };
  }
  assert.deepEqual(steps, [[1, false, 300], [2, false, 3600], [3, true, null]]);
});

test('预算：强制重判（文本变了）重新开始，旧规则版本的 marker 不累计', () => {
  const parked = { rules: LABEL_FAILURE_RULES_VERSION, attempts: 3, parked: true, nextAtEpoch: null, lastAtEpoch: null };
  assert.deepEqual(planLabelFailure({ previous: parked, force: true }), { attempts: 1, parked: false, delaySeconds: 300 });
  const old = { ...parked, rules: 'label-failure-v0' };
  assert.deepEqual(planLabelFailure({ previous: old }), { attempts: 1, parked: false, delaySeconds: 300 });
});

test('批次筛选 SQL 只引用 $2（规则版本），并且对 ai_result 的任何形状都安全', () => {
  assert.match(LABEL_RETRY_DUE_SQL, /\$2/);
  assert.doesNotMatch(LABEL_RETRY_DUE_SQL, /\$1|\$3/);
  assert.match(LABEL_RETRY_DUE_SQL, /jsonb_typeof\(ai_result -> 'labelFailure' -> 'nextAtEpoch'\) = 'number'/, '类型转换前先校验类型');
});
