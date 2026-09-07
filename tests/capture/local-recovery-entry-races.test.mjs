import assert from 'node:assert/strict';
import test from 'node:test';
import {createLocalRecoveryHarness, LOCAL_KEYS, clone, deferred, tick, until} from '../helpers/local-recovery-harness.mjs';

// All lifecycle functions, authority/source checks, locks, and writes are real;
// only browser/server ports and the initial running seam use the shared fixture.
async function fixture(stage) {
  const h = createLocalRecoveryHarness();
  await h.stoppedOriginal();
  const prepared = await h.prepare();
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const from = h.shellSender();
  const pair = h.connect(from, h.context.OnStarvoiceLocalRecovery.RUNNER_PORT);
  const bind = {type: 'onstarvoice:local-recovery-runner-bind',
    launchIntentId: prepared.launchIntentId, holderId: 'successor-holder'};
  const claim = {type: 'onstarvoice:local-recovery-runner-claim',
    launchIntentId: prepared.launchIntentId, holderId: 'successor-holder',
    requestId: prepared.requestId, attemptId: prepared.attemptId, generation: 2};
  if (stage === 'claim') {
    assert.equal((await h.send(bind, from)).ok, true);
    await until(() => h.store[LOCAL_KEYS.launch].phase === 'activated');
  }
  return {h, from, pair, message: stage === 'bind' ? bind : claim};
}

function blockFirstRead(h) {
  const entered = deferred(), release = deferred(), original = h.storage.get;
  let pending = true;
  h.storage.get = async keys => {
    if (pending) {
      pending = false;
      entered.resolve();
      await release.promise;
    }
    return original(keys);
  };
  return {entered: entered.promise, release: () => release.resolve()};
}

const replacements = [
  ['disconnect and reconnect in the same document', ({h, from, pair}) => {
    pair.client.disconnect();
    return h.connect(from, h.context.OnStarvoiceLocalRecovery.RUNNER_PORT);
  }],
  ['replace the connection without a preceding disconnect', ({h, from}) =>
    h.connect(from, h.context.OnStarvoiceLocalRecovery.RUNNER_PORT)],
  ['disconnect and connect a different document in the same tab', ({h, from, pair}) => {
    pair.client.disconnect();
    return h.connect({...from, documentId: `${from.documentId}-replacement`},
      h.context.OnStarvoiceLocalRecovery.RUNNER_PORT);
  }],
  ['disconnect without a replacement', ({pair}) => {
    pair.client.disconnect();
    return null;
  }],
];

for (const stage of ['bind', 'claim']) {
  for (const [name, replace] of replacements) test(`${stage} first-read race cannot inherit another runner: ${name}`, async () => {
    const f = await fixture(stage), {h, from, pair, message} = f;
    const oldJournal = clone(h.store[LOCAL_KEYS.journal]);
    const oldRequest = clone(h.store.request), oldLock = clone(h.store.lock);
    const notificationsBefore = pair.outgoing.length;
    const blocked = blockFirstRead(h);
    const work = h.send(message, from);
    await blocked.entered;
    const replacement = replace(f);
    blocked.release();
    const result = await work;
    await tick(); await tick();
    assert.equal(result.ok, false, 'the original request must remain bound to its pre-await port');
    assert.notEqual(h.store[LOCAL_KEYS.launch].phase, 'claimed');
    assert.deepEqual(h.store[LOCAL_KEYS.journal], oldJournal);
    assert.deepEqual(h.store.request, oldRequest);
    assert.deepEqual(h.store.lock, oldLock);
    assert.equal(pair.outgoing.length, notificationsBefore, 'the failed entry cannot emit a late activation');
    assert.equal(replacement?.outgoing.length || 0, 0, 'a replacement port cannot inherit activation');
    assert.equal(h.writes.filter(patch => patch[LOCAL_KEYS.journal]?.generation === 2).length, 0);
    assert.equal(h.creates.length, 1, 'the only browser fixture effect remains the dormant shell');
    assert.equal(h.pageEffects.length, 0);
  });

  test(`${stage} first-read delay preserves the normal exact-connection path`, async () => {
    const {h, from, pair, message} = await fixture(stage);
    const blocked = blockFirstRead(h);
    const work = h.send(message, from);
    await blocked.entered;
    blocked.release();
    const result = await work;
    assert.equal(result.ok, true, JSON.stringify(result));
    if (stage === 'bind') {
      assert.equal(result.phase, 'runner_bound');
      await until(() => h.store[LOCAL_KEYS.launch].phase === 'activated');
      assert.equal(pair.outgoing.length, 1);
      assert.equal(h.store[LOCAL_KEYS.journal].generation, 1);
    } else {
      assert.equal(h.store[LOCAL_KEYS.launch].phase, 'claimed');
      assert.equal(h.store[LOCAL_KEYS.journal].generation, 2);
      assert.equal(h.writes.filter(patch => patch[LOCAL_KEYS.journal]?.generation === 2).length, 1);
      assert.equal((await h.send(message, from)).ok, false, 'an acknowledged claim stays one-shot');
    }
    assert.equal(h.pageEffects.length, 0);
  });
}
