import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { runMigrations } from '../../../server/db/migrate.js';
import { getPool, closePool } from '../../../server/db/pool.js';
import { labelPendingRecords, labelRecord } from '../../../server/services/ai-labeler.js';
import { LABEL_FAILURE_RULES_VERSION } from '../../../server/services/ai-label-failure.js';
import { getProcessBackgroundWorkSnapshot } from '../../../server/runtime/process-background-work.js';

// A record whose label write fails for a reason that does not go away (here: the model reply carries a
// confidence PostgreSQL cannot store, 22P02 "for type real") used to be sent to the paid model again
// every 10 minutes, without limit. It is now counted, spaced, and parked after three failures.
const goodReply = { relevance: 'relevant', sentiment: 'neutral', intent: 'inquiry', category: 'feature_usage', confidence: 0.9, relevanceConfidence: 0.9, summary: '咨询哨兵录像' };
const completion = reply => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const ok = body => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
const REPLIES = {
  good: () => ok(completion(goodReply)),
  badConfidence: () => ok(completion({ ...goodReply, confidence: 'high' })),
  empty: () => ok(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'null' } }], usage: {} })),
  http400: () => new Response(JSON.stringify({ error: { message: 'Content Exists Risk' } }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
  http401: () => new Response(JSON.stringify({ error: { message: 'Authentication Fails' } }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
};

test('a record that keeps failing to label is counted, spaced and parked, never retried without bound', async t => {
  validatePostgresIntegrationTarget({ testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true });
  await runMigrations();
  const pool = getPool();
  const tenants = [];
  async function newTenant({ configured = true } = {}) {
    const id = (await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`标注失败预算 ${randomUUID()}`])).rows[0].id;
    if (configured) {
      await pool.query(`INSERT INTO tenant_settings (tenant_id, key, value)
        VALUES ($1,'llm_provider','deepseek'),($1,'llm_api_key','sk-test-not-real'),
               ($1,'llm_model','deepseek-chat'),($1,'llm_api_endpoint','https://llm.invalid/v1')
        ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = now()`, [id]);
    }
    tenants.push(id);
    return id;
  }
  const tenant = await newTenant();
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalEnv = { key: process.env.LLM_API_KEY, provider: process.env.LLM_PROVIDER };
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_PROVIDER;
  const modes = new Map(); // title marker -> reply kind
  const hooks = new Map(); // title marker -> async function run while the model call is in flight
  const calls = new Map(); // title marker -> paid calls
  let logged = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/llm\.invalid\//, 'the stub must be the only model endpoint');
    const message = JSON.parse(init.body).messages.at(-1).content;
    const marker = message.match(/标记-[0-9a-f-]{36}/)?.[0];
    calls.set(marker, (calls.get(marker) || 0) + 1);
    await hooks.get(marker)?.();
    return REPLIES[modes.get(marker) || 'good']();
  };
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    if (originalEnv.key !== undefined) process.env.LLM_API_KEY = originalEnv.key;
    if (originalEnv.provider !== undefined) process.env.LLM_PROVIDER = originalEnv.provider;
    for (let i = 0; i < 200 && getProcessBackgroundWorkSnapshot().inFlight > 0; i += 1) await new Promise(r => setTimeout(r, 25));
    for (const id of tenants) await pool.query('DELETE FROM tenants WHERE id=$1', [id]);
    await closePool();
  });

  const own = new Set(); // every record this test created, so a batch only ever touches these
  const live = [];
  async function record(mode, { tenantId = tenant, keyword = '车机咨询' } = {}) {
    const marker = `标记-${randomUUID()}`;
    modes.set(marker, mode);
    const id = randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,content,keyword)
      VALUES($1::uuid,$2,'douyin',$1::text,$3,'车机升级后哨兵找不到录像',$4)`, [id, tenantId, marker, keyword]);
    own.add(id);
    live.push(id);
    return { id, marker, tenantId };
  }
  const calledFor = ({ marker }) => calls.get(marker) || 0;
  const state = async ({ id }) => (await pool.query(
    `SELECT ai_labeled_at, ai_result, updated_at, ai_result -> 'labelFailure' AS failure FROM records WHERE id = $1`, [id])).rows[0];
  // One batch over this test's own records only. `attempted` lists the ones the batch SELECTED (a record the
  // SQL filter excludes never shows up there), so the assertions do not depend on what else is in the database.
  const tick = async () => {
    const attempted = [];
    const result = await labelPendingRecords(1000, {
      pauseMs: 0,
      label: async id => { if (!own.has(id)) return null; attempted.push(id); return labelRecord(id); },
    });
    return { attempted, ...result };
  };
  const makeDue = ({ id }) => pool.query(`UPDATE records SET ai_result = jsonb_set(ai_result, '{labelFailure,nextAtEpoch}', to_jsonb(extract(epoch FROM now()) - 1))
    WHERE id = $1 AND jsonb_typeof(ai_result -> 'labelFailure' -> 'nextAtEpoch') = 'number'`, [id]);
  const nowEpoch = async () => Number((await pool.query('SELECT extract(epoch FROM now()) AS now')).rows[0].now);
  async function wipe() {
    if (live.length) await pool.query('DELETE FROM records WHERE id = ANY($1::uuid[])', [live.splice(0)]);
    logged = [];
  }
  async function failThreeTimes(poison) {
    await tick(); await makeDue(poison);
    await tick(); await makeDue(poison);
    await tick();
  }

  await t.test('deterministic failure: 1 call, wait for the next batch, 1 call, wait an hour, 1 call, parked; then no calls at all', async () => {
    const poison = await record('badConfidence');
    const before = await state(poison);

    await tick();
    assert.equal(calledFor(poison), 1);
    let now = await nowEpoch();
    let { failure, ai_labeled_at: labeledAt } = await state(poison);
    assert.equal(labeledAt, null, 'still unlabelled: nothing is invented');
    assert.deepEqual(Object.keys(failure).sort(), ['attempts', 'code', 'lastAt', 'lastAtEpoch', 'nextAtEpoch', 'parked', 'reason', 'rules']);
    assert.deepEqual([failure.attempts, failure.parked, failure.code, failure.reason, failure.rules], [1, false, '22P02', 'pg_22P02', LABEL_FAILURE_RULES_VERSION]);
    assert.ok(failure.nextAtEpoch - now > 200 && failure.nextAtEpoch - now < 400, 'next batch, about 5 minutes');
    assert.ok(logged.some(line => line.includes(`Label error for record ${poison.id}`) && line.includes('[pg_22P02, counted 1/3]')), logged.join('\n'));

    assert.deepEqual((await tick()).attempted, [], 'not due yet: the batch does not even select it, so it cannot take a slot from other records');
    assert.equal(await labelRecord(poison.id), null, 'and a direct call is refused too');
    assert.equal(calledFor(poison), 1, 'no model call while it waits');

    await makeDue(poison);
    await tick();
    assert.equal(calledFor(poison), 2);
    now = await nowEpoch();
    ({ failure } = await state(poison));
    assert.deepEqual([failure.attempts, failure.parked], [2, false]);
    assert.ok(failure.nextAtEpoch - now > 3400 && failure.nextAtEpoch - now < 3800, 'second wait is an hour');
    assert.deepEqual((await tick()).attempted, []);
    assert.equal(calledFor(poison), 2);

    await makeDue(poison);
    await tick();
    assert.equal(calledFor(poison), 3);
    ({ failure } = await state(poison));
    assert.deepEqual([failure.attempts, failure.parked, failure.nextAtEpoch], [3, true, null]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM records WHERE tenant_id = $1 AND ai_labeled_at IS NOT NULL`, [tenant])).rows[0].n, 0,
      'a tenant where nothing else was ever labelled parks a poison record at 3 as well');
    assert.equal(logged.filter(line => line.includes(`Label parked for record ${poison.id}`)).length, 1, 'parking is logged once');
    assert.ok(logged.some(line => line.includes('counted 3/3, parked')));

    for (let i = 0; i < 4; i += 1) assert.deepEqual((await tick()).attempted, [], 'parked: not selected');
    assert.equal(await labelRecord(poison.id), null);
    assert.equal(calledFor(poison), 3, 'parked: three paid calls in total, however many batches run');
    const after = await state(poison);
    assert.equal(after.ai_labeled_at, null);
    assert.equal(after.ai_result.relevance, undefined, 'no invented judgement');
    assert.equal(after.updated_at.getTime(), before.updated_at.getTime(), 'the failure state does not touch updated_at');
    await wipe();
  });

  await t.test('a forced relabel (text changed) gets through a parked record and a good result clears the marker', async () => {
    const poison = await record('badConfidence');
    await failThreeTimes(poison);
    assert.equal((await state(poison)).failure.parked, true);
    assert.equal(calledFor(poison), 3);

    modes.set(poison.marker, 'good'); // the re-capture fixed whatever made the reply unusable
    const result = await labelRecord(poison.id, { force: true });
    assert.equal(result.relevance, 'relevant');
    assert.equal(calledFor(poison), 4);
    const row = await state(poison);
    assert.ok(row.ai_labeled_at);
    assert.equal(row.failure, null, 'the label replaced ai_result, so the marker is gone');
    assert.equal(row.ai_result.relevance, 'relevant');
    await wipe();
  });

  await t.test('a forced relabel that fails again starts a fresh budget instead of staying parked', async () => {
    const poison = await record('badConfidence');
    await failThreeTimes(poison);
    assert.equal((await state(poison)).failure.parked, true);
    assert.equal(await labelRecord(poison.id, { force: true }), null);
    const { failure } = await state(poison);
    assert.deepEqual([failure.attempts, failure.parked], [1, false]);
    assert.equal(calledFor(poison), 4);
    await wipe();
  });

  await t.test('any truthy force is read the same way by the gate and by the budget', async () => {
    const poison = await record('badConfidence');
    await failThreeTimes(poison);
    assert.equal((await state(poison)).failure.parked, true);
    assert.equal(await labelRecord(poison.id, { force: 1 }), null);
    const { failure } = await state(poison);
    assert.deepEqual([failure.attempts, failure.parked], [1, false], 'it got through the gate, so it also gets the fresh budget');
    await wipe();
  });

  await t.test('a parked record from an older rules version gets a fresh budget once the rules version changes', async () => {
    const poison = await record('badConfidence');
    await failThreeTimes(poison);
    assert.deepEqual((await tick()).attempted, []);
    assert.equal(calledFor(poison), 3);
    await pool.query(`UPDATE records SET ai_result = jsonb_set(ai_result, '{labelFailure,rules}', '"label-failure-v0"') WHERE id = $1`, [poison.id]);
    assert.deepEqual((await tick()).attempted, [poison.id], 'selected again');
    assert.equal(calledFor(poison), 4);
    const { failure } = await state(poison);
    assert.deepEqual([failure.attempts, failure.parked, failure.rules], [1, false, LABEL_FAILURE_RULES_VERSION]);
    await wipe();
  });

  await t.test('failures that are not the record\'s fault are never counted and never parked (tenant key rejected)', async () => {
    const record401 = await record('http401');
    for (let i = 0; i < 4; i += 1) await tick();
    assert.equal(calledFor(record401), 4, 'retried on every batch, exactly as before');
    assert.equal((await state(record401)).failure, null);
    assert.ok(logged.some(line => line.includes('[llm_http_config, not counted]')));
    await wipe();
  });

  await t.test('no provider configured: no model call, no marker (the record is waiting for configuration)', async () => {
    const bare = await newTenant({ configured: false });
    const waiting = await record('good', { tenantId: bare });
    for (let i = 0; i < 3; i += 1) assert.equal(await labelRecord(waiting.id), null);
    assert.equal(calledFor(waiting), 0);
    assert.equal((await state(waiting)).failure, null);
    await wipe();
  });

  await t.test('a record edited while the model call is in flight is not counted as a failure', async () => {
    const edited = await record('good');
    hooks.set(edited.marker, () => pool.query(`UPDATE records SET content = content || '（编辑）' WHERE id = $1`, [edited.id]));
    assert.equal(await labelRecord(edited.id), null, 'the stale result is discarded');
    assert.equal(calledFor(edited), 1);
    const row = await state(edited);
    assert.equal(row.failure, null);
    assert.equal(row.ai_labeled_at, null);
    hooks.delete(edited.marker);
    assert.ok(await labelRecord(edited.id), 'and the next attempt labels it');
    await wipe();
  });

  await t.test('a provider rejection of this input (HTTP 400) is counted and parked like any other repeatable failure', async () => {
    const moderated = await record('http400');
    await failThreeTimes(moderated);
    const { failure } = await state(moderated);
    assert.deepEqual([failure.attempts, failure.parked, failure.reason], [3, true, 'llm_http_400']);
    assert.equal(calledFor(moderated), 3);
    await wipe();
  });

  await t.test('KNOWN LIMIT: a fault that every record hits parks the whole backlog until the rules version changes or the marker is deleted', async () => {
    const backlog = [];
    for (let i = 0; i < 4; i += 1) backlog.push(await record('badConfidence')); // e.g. the tenant switched to a model that answers confidence "high"
    for (let round = 0; round < 3; round += 1) {
      assert.equal((await tick()).attempted.length, 4);
      for (const item of backlog) await makeDue(item);
    }
    for (const item of backlog) assert.equal((await state(item)).failure.parked, true);
    // The cause is fixed, but parked records are not retried on their own ...
    for (const item of backlog) modes.set(item.marker, 'good');
    assert.deepEqual((await tick()).attempted, []);
    // ... an operator deletes the marker (the query in docs/hotfix/20260929-ai-label-surrogate.md) ...
    await pool.query(`UPDATE records SET ai_result = ai_result - 'labelFailure' WHERE id = ANY($1::uuid[])`, [backlog.map(item => item.id)]);
    assert.equal((await tick()).attempted.length, 4);
    for (const item of backlog) assert.equal((await state(item)).ai_result.relevance, 'relevant');
    await wipe();
    // ... or the next hotfix bumps LABEL_FAILURE_RULES_VERSION, which gives every parked record a fresh budget.
    const again = [];
    for (let i = 0; i < 2; i += 1) again.push(await record('badConfidence'));
    for (let round = 0; round < 3; round += 1) { await tick(); for (const item of again) await makeDue(item); }
    for (const item of again) modes.set(item.marker, 'good');
    await pool.query(`UPDATE records SET ai_result = jsonb_set(ai_result, '{labelFailure,rules}', '"label-failure-v0"') WHERE id = ANY($1::uuid[])`, [again.map(item => item.id)]);
    assert.equal((await tick()).attempted.length, 2);
    for (const item of again) assert.equal((await state(item)).ai_result.relevance, 'relevant');
    await wipe();
  });

  await t.test('a pending record whose ai_result is not a JSON object is still counted and bounded (a string, an array, JSON null)', async () => {
    for (const shape of [`to_jsonb('{}'::text)`, `'[]'::jsonb`, `'null'::jsonb`, `to_jsonb('not json at all'::text)`]) {
      const odd = await record('badConfidence');
      await pool.query(`UPDATE records SET ai_result = ${shape} WHERE id = $1`, [odd.id]);
      await failThreeTimes(odd);
      const { failure } = await state(odd);
      assert.deepEqual([failure?.attempts, failure?.parked], [3, true], `shape ${shape}`);
      assert.equal(calledFor(odd), 3, `shape ${shape}: three paid calls, not one per batch`);
      assert.deepEqual((await tick()).attempted, [], `shape ${shape}: parked, not selected`);
    }
    await wipe();
  });

  await t.test('an empty model reply is counted and logged (it used to loop silently)', async () => {
    const empty = await record('empty');
    await failThreeTimes(empty);
    const { failure } = await state(empty);
    assert.deepEqual([failure.attempts, failure.parked, failure.reason, failure.code], [3, true, 'llm_empty_result', 'LABEL_MODEL_EMPTY_RESULT']);
    assert.equal(calledFor(empty), 3);
    assert.ok(logged.some(line => line.includes(`Label error for record ${empty.id}`) && line.includes('llm_empty_result')));
    await wipe();
  });

  await t.test('a failed forced relabel of a record that already has a label leaves the label alone', async () => {
    const labelled = await record('good');
    await labelRecord(labelled.id);
    const before = await state(labelled);
    assert.equal(before.ai_result.relevance, 'relevant');
    modes.set(labelled.marker, 'badConfidence');
    assert.equal(await labelRecord(labelled.id, { force: true }), null);
    const after = await state(labelled);
    assert.equal(after.failure, null, 'no marker on a record that is not pending');
    assert.deepEqual(after.ai_result, before.ai_result);
    assert.equal(after.ai_labeled_at.getTime(), before.ai_labeled_at.getTime());
    assert.ok(logged.some(line => line.includes(`Label error for record ${labelled.id}`) && line.includes('not recorded')));
    await wipe();
  });

  await t.test('a legacy ai_result stored as a JSON string is never rewritten by a failure note', async () => {
    const legacy = await record('badConfidence');
    const original = JSON.stringify({ relevance: 'relevant', sentiment: 'positive', summary: 'legacy label' });
    await pool.query(`UPDATE records SET ai_result = to_jsonb($2::text), ai_labeled_at = now() WHERE id = $1`, [legacy.id, original]);
    assert.equal(await labelRecord(legacy.id, { force: true }), null);
    const row = (await pool.query(`SELECT ai_result #>> '{}' AS text, jsonb_typeof(ai_result) AS kind FROM records WHERE id = $1`, [legacy.id])).rows[0];
    assert.deepEqual([row.kind, row.text], ['string', original], 'the legacy label survives');
    await wipe();
  });

  await t.test('a malformed marker never breaks the batch query and reads as due', async () => {
    const odd = await record('good');
    for (const marker of [`{"rules":"${LABEL_FAILURE_RULES_VERSION}","attempts":1,"parked":false,"nextAtEpoch":"not-a-number"}`,
      `{"rules":"${LABEL_FAILURE_RULES_VERSION}","parked":false}`, '"just a string"', '[1,2]', 'null']) {
      await pool.query(`UPDATE records SET ai_result = jsonb_build_object('labelFailure', $2::jsonb) WHERE id = $1`, [odd.id, marker]);
      assert.deepEqual((await tick()).attempted, [odd.id], `selected with marker ${marker}`);
      await pool.query(`UPDATE records SET ai_labeled_at = NULL, ai_result = '{}'::jsonb WHERE id = $1`, [odd.id]);
    }
    // A record whose whole ai_result is not an object at all is still selected.
    await pool.query(`UPDATE records SET ai_result = '"legacy string"'::jsonb WHERE id = $1`, [odd.id]);
    assert.deepEqual((await tick()).attempted, [odd.id]);
    await wipe();
  });

  await t.test('a record labelled meanwhile is not overwritten by a late failure note', async () => {
    const racing = await record('badConfidence');
    const source = (await pool.query(`SELECT *, ai_labeled_at::text AS classification_version FROM records WHERE id = $1`, [racing.id])).rows[0];
    // Someone else labels it while our attempt is in flight ...
    modes.set(racing.marker, 'good');
    await labelRecord(racing.id);
    assert.ok((await state(racing)).ai_labeled_at);
    // ... and our failure arrives afterwards.
    const { writeLabelFailure } = await import('../../../server/services/ai-label-failure.js');
    const written = await writeLabelFailure({
      record: source, failure: { reason: 'pg_22P02' }, error: { code: '22P02' },
      plan: { attempts: 1, parked: false, delaySeconds: 300 },
    });
    assert.equal(written, null);
    assert.equal((await state(racing)).failure, null);
    await wipe();
  });

  await t.test('the batch keeps going when one record throws, and stops after three errors in a row', async () => {
    for (let i = 0; i < 6; i += 1) await record('good');
    const seen = [];
    let calls = 0;
    // throw, ok, throw, ok, ...: an error in between must reset the run of consecutive errors
    let result = await labelPendingRecords(1000, {
      pauseMs: 0,
      label: async id => { seen.push(id); calls += 1; if (calls % 2 === 1) throw new Error('Database general capacity is temporarily unavailable.'); return { relevance: 'relevant' }; },
    });
    assert.equal(seen.length, result.total, 'every selected record was attempted despite the errors');
    assert.ok(seen.filter(id => own.has(id)).length >= 6);
    assert.ok(logged.some(line => line.includes('Batch label error for record')));

    seen.length = 0;
    result = await labelPendingRecords(1000, {
      pauseMs: 0,
      label: async id => { seen.push(id); throw new Error('database is not answering'); },
    });
    assert.equal(seen.length, 3, 'three in a row: stop and let the next tick try again');
    assert.equal(result.labeled, 0);
    assert.ok(logged.some(line => line.includes('Batch stopped after 3 consecutive errors')));
    await wipe();
  });
});
