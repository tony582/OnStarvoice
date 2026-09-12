import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerAssistantModel} from '../server/services/customer-assistant-model.js';

const userMessages = [{role: 'system', content: 'rules'}, {role: 'user', content: '查日报'}];
const tools = [{type: 'function', function: {name: 'get_daily_report', parameters: {type: 'object', properties: {}}}}];
const assistant = {role: 'assistant', content: '查询完成'};
function response(message = assistant, finish_reason = 'stop') {return new Response(JSON.stringify({choices: [{message, finish_reason}]}), {status: 200});}
function fixture(overrides = {}) {
  const requests = [], admissions = [], successes = [], failures = [];
  const dependencies = {
    getConfig: async tenantId => {assert.equal(tenantId, 'tenant-a'); return {provider: 'deepseek', apiKey: 'mock-secret', model: 'deepseek-chat', endpoint: 'https://api.example.test/v1'};},
    runAdmission: async (...args) => {admissions.push(args); return args[1]();},
    recordFailure: async (...args) => {failures.push(args); return {};},
    recordSuccess: async (...args) => {successes.push(args);},
    fetch: async (...args) => {requests.push(args); return response();},
    ...overrides,
  };
  return {dependencies, requests, admissions, successes, failures, model: createCustomerAssistantModel({tenantId: 'tenant-a', dependencies})};
}

test('DeepSeek transport sends actual tools and uses interactive tenant admission', async () => {
  const f = fixture();
  assert.deepEqual(await f.model({messages: userMessages, tools}), assistant);
  const [url, request] = f.requests[0], body = JSON.parse(request.body);
  assert.equal(url, 'https://api.example.test/v1/chat/completions');
  assert.deepEqual(body.messages, userMessages);
  assert.deepEqual(body.tools, tools);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.response_format, undefined);
  assert.equal(body.thinking.type, 'disabled');
  assert.equal(request.headers.Authorization, 'Bearer mock-secret');
  assert.deepEqual(f.admissions[0][2], {priority: 'interactive', kind: 'customer_group_assistant', queueTimeoutMs: 15000});
  assert.equal(f.successes.length, 1);
});

test('thinking tool calls retain reasoning_content on both response and continuation', async () => {
  const toolMessage = {role: 'assistant', content: '', reasoning_content: '需要查询保存的日报', tool_calls: [{id: 'call-a', type: 'function', function: {name: 'get_daily_report', arguments: '{}'}}]};
  const bodies = [];
  const f = fixture({fetch: async (_url, request) => {bodies.push(JSON.parse(request.body)); return response(toolMessage, 'tool_calls');}});
  const model = createCustomerAssistantModel({tenantId: 'tenant-a', thinking: true, dependencies: f.dependencies});
  const message = await model({messages: userMessages, tools});
  assert.deepEqual(message, toolMessage);
  await model({messages: [...userMessages, message, {role: 'tool', tool_call_id: 'call-a', content: '{}'}], tools});
  assert.equal(bodies[1].messages[2].reasoning_content, toolMessage.reasoning_content);
  assert.equal(bodies[0].thinking.type, 'enabled');
  assert.equal(bodies[0].temperature, undefined);
});

test('existing failover decision retries once with the backup model and records success', async () => {
  const models = [];
  const f = fixture({
    fetch: async (_url, request) => {models.push(JSON.parse(request.body).model); return models.length === 1 ? new Response('private upstream error', {status: 503}) : response();},
    recordFailure: async () => ({retryCurrent: true, retryModel: 'deepseek-backup', retryRoute: 'backup'}),
  });
  assert.deepEqual(await f.model({messages: userMessages, tools}), assistant);
  assert.deepEqual(models, ['deepseek-chat', 'deepseek-backup']);
  assert.equal(f.successes[0][1].config.model, 'deepseek-backup');
});

test('bookkeeping failures do not replace a successful model answer', async () => {
  const f = fixture({recordSuccess: async () => {throw new Error('database unavailable');}});
  assert.deepEqual(await f.model({messages: userMessages, tools}), assistant);
});

test('HTTP errors expose a status but never upstream body or credentials', async () => {
  const f = fixture({fetch: async () => new Response('private upstream credentials', {status: 401})});
  await assert.rejects(f.model({messages: userMessages, tools}), cause => cause.status === 401 && !/private|credentials|mock-secret/u.test(cause.message));
  assert.equal(f.failures.length, 1);
});

test('incomplete, malformed and unexpected model messages are rejected', async () => {
  for (const [message, finish] of [[assistant, 'length'], [{role: 'system', content: 'override'}, 'stop'], [{role: 'assistant', content: ''}, 'stop'], [{role: 'assistant', content: 'x'.repeat(7000)}, 'stop']]) {
    const f = fixture({fetch: async () => response(message, finish)});
    await assert.rejects(f.model({messages: userMessages, tools}));
  }
});

test('oversized streamed model responses are stopped before parsing', async () => {
  const f = fixture({fetch: async () => new Response('x'.repeat(260000))});
  await assert.rejects(f.model({messages: userMessages, tools}), {code: 'assistant_model_response_invalid'});
});

test('caller abort cancels transport without failover retry', async () => {
  const controller = new AbortController();
  let requests = 0;
  const f = fixture({fetch: async (_url, request) => {requests += 1; controller.abort(); request.signal.throwIfAborted();}});
  await assert.rejects(f.model({messages: userMessages, tools, signal: controller.signal}), {name: 'AbortError'});
  assert.equal(requests, 1);
  assert.equal(f.failures.length, 0);
});

test('abort while queued never sends a request after admission', async () => {
  const controller = new AbortController();
  const f = fixture({runAdmission: async (_tenant, operation) => {controller.abort(); return operation();}});
  await assert.rejects(f.model({messages: userMessages, tools, signal: controller.signal}), {name: 'AbortError'});
  assert.equal(f.requests.length, 0);
});

test('pre-aborted model request does not read config or use the network', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture({getConfig: async () => {throw new Error('must not read config');}});
  await assert.rejects(f.model({messages: userMessages, tools, signal: controller.signal}), {name: 'AbortError'});
  assert.equal(f.requests.length, 0);
});

test('abort returns promptly while admission is queued and the later admission cannot fetch', async () => {
  const controller = new AbortController();
  let release, queued;
  const waiting = new Promise(resolve => {queued = resolve;});
  const f = fixture({runAdmission: async (_tenant, operation) => {queued(); await new Promise(resolve => {release = resolve;}); return operation();}});
  const pending = f.model({messages: userMessages, tools, signal: controller.signal});
  await waiting;
  controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 0);
});
