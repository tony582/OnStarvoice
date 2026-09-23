import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {runCli} from '../src/cli/index.mjs';
import {parseArguments} from '../src/cli/arguments.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';

test('CLI rejects unknown, duplicate and missing options instead of selecting a device', () => {
  for (const args of [['doctor', '--serial'], ['doctor', '--token', 'secret'],
    ['doctor', '--serial', 'one', '--serial', 'two'], ['status'], ['unknown']]) {
    assert.throws(() => parseArguments(args));
  }
});

test('doctor exit status separates connection readiness from actual search readiness', async () => {
  const output = [];
  const status = await runCli(['doctor', '--serial', 'wanted'], {stdout: line => output.push(JSON.parse(line)),
    doctor: async options => { assert.equal(options.serial, 'wanted');
      return {readyForP0: true, readyForSearch: false}; }});
  assert.equal(status, 0);
  assert.equal(output[0].readyForSearch, false);
});

test('unvalidated run does not invoke device doctor or start a task', async () => {
  assert.equal(await runCli(['run'], {stdout() {}, doctor: () => assert.fail('no device operation')}), 2);
});

test('demo runs two keywords through real core and SQLite, with explicit simulation output', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'android-cli-test-'));
  t.after(() => rmSync(stateDir, {recursive: true, force: true}));
  const reports = [];
  const status = await runCli(['demo', '--state-dir', stateDir], {stdout: line => reports.push(JSON.parse(line))});
  assert.equal(status, 0);
  const report = reports[0];
  assert.equal(report.mode, 'simulation_only');
  assert.equal(report.networkUsed, false);
  assert.equal(report.results.length, 2);
  assert.equal(report.pendingEvents, 4);
  const store = new RunnerStore(join(stateDir, 'runner.sqlite'));
  const batch = store.nextBatch();
  assert.equal(new Set(batch.events.map(item => item.itemId)).size, 2);
  assert.equal(new Set(batch.events.map(item => item.verifiedExternalId)).size, 3);
  store.close();
});
