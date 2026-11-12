import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {warnWhenHostOnBattery, BATTERY_POWER_WARNING} from '../src/cli/host-power.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {readDiagnostics} from '../src/core/diagnostics.mjs';
import {diagnoseRunner} from '../src/daemon/diagnose.mjs';
import {runUp} from '../src/cli/up-command.mjs';

const battery = "Now drawing from 'Battery Power'\n -InternalBattery-0 57%; discharging; 3:10 remaining present: true\n";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'android-host-power-'));
  const store = new RunnerStore(join(dir, 'runner.sqlite'));
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  return {dir, store};
}

test('battery startup reads pmset once and puts the exact warning in both terminal and diagnose', async t => {
  const {store} = fixture(t), lines = [], calls = [];
  const now = Date.parse('2026-11-12T03:00:00Z');
  const result = await warnWhenHostOnBattery({store, platform: 'darwin', now: () => now, stdout: line => lines.push(line),
    execFileImpl: async (...args) => { calls.push(args); return {stdout: battery}; }});
  assert.deepEqual(result, {checked: true, powerSource: 'battery'});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/pmset', ['-g', 'batt']]);
  assert.equal(calls[0][2].timeout, 2000);
  assert.equal(calls[0][2].maxBuffer, 16384);
  assert.deepEqual(lines, [BATTERY_POWER_WARNING]);
  assert.equal(BATTERY_POWER_WARNING, '电脑在用电池，合盖或电量低时可能睡眠，采集会中断');
  const notes = readDiagnostics(store);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].at, '2026-11-12T03:00:00.000Z');
  assert.equal(notes[0].message, BATTERY_POWER_WARNING);
  assert.equal(diagnoseRunner(store, {now}).problems[0].message, BATTERY_POWER_WARNING);
});

test('AC power uses the supply header, not incidental battery/discharging text', async t => {
  const {store} = fixture(t), lines = []; let calls = 0;
  const result = await warnWhenHostOnBattery({store, platform: 'darwin', stdout: line => lines.push(line),
    execFileImpl: async () => { calls++; return {stdout: "Now drawing from 'AC Power'\n Battery Power notes: discharging"}; }});
  assert.deepEqual(result, {checked: true, powerSource: 'ac'});
  assert.equal(calls, 1); assert.deepEqual(lines, []); assert.deepEqual(readDiagnostics(store), []);
});

test('unknown output and failed/slow pmset are not reported as battery power and never stop startup', async t => {
  const {store} = fixture(t), lines = [];
  for (const execFileImpl of [async () => ({stdout: 'Battery Power is not an observed supply header'}),
    async () => { throw Object.assign(new Error('PRIVATE RAW ERROR'), {code: 'ETIMEDOUT', stderr: 'PRIVATE OUTPUT'}); }]) {
    assert.deepEqual(await warnWhenHostOnBattery({store, platform: 'darwin', stdout: line => lines.push(line), execFileImpl}), {checked: false, powerSource: 'unknown'});
  }
  assert.deepEqual(lines, []); assert.deepEqual(readDiagnostics(store), []);
});

test('non-macOS startups never call pmset', async () => {
  for (const platform of ['linux', 'win32']) {
    assert.deepEqual(await warnWhenHostOnBattery({platform, execFileImpl: () => assert.fail('must not execute'), stdout: () => assert.fail('must not warn')}),
      {checked: false, powerSource: 'unsupported'});
  }
});

test('a diagnostic write failure does not suppress the terminal warning or block startup', async () => {
  const lines = [];
  const result = await warnWhenHostOnBattery({store: {loadCheckpoint: () => { throw new Error('database unavailable'); }},
    platform: 'darwin', execFileImpl: async () => ({stdout: battery}), stdout: line => lines.push(line)});
  assert.equal(result.powerSource, 'battery'); assert.deepEqual(lines, [BATTERY_POWER_WARNING]);
});

test('up checks power once before entering the daemon, using only fake device and power commands', async t => {
  const {dir, store} = fixture(t), lines = []; let checks = 0, runs = 0;
  writeFileSync(join(dir, 'connection.json'), JSON.stringify({baseUrl: 'http://127.0.0.1:3999', deviceId: 'FAKE',
    agentId: 'fake', agentToken: 'fake', clientUuid: 'fake', tenantId: 'fake', simulation: false}));
  await runUp({'state-dir': dir}, {stdout: line => lines.push(line), deps: {
    adb: {startServer: async () => {}},
    checkHostPower: options => warnWhenHostOnBattery({...options, platform: 'darwin', execFileImpl: async () => { checks++; return {stdout: battery}; }}),
    createDaemon: () => ({store, ready: false, run: async () => { runs++; assert.equal(checks, 1); return {deviceClosureRequired: false}; }, requestStop() {}}),
    onSignals: () => () => {}, sleep: async () => {}, watchMs: 1,
  }});
  assert.equal(checks, 1); assert.equal(runs, 1);
  assert.equal(lines.filter(line => line === BATTERY_POWER_WARNING).length, 1);
});

test('mac launcher execs caffeinate -is around the exact foreground command and preserves quoted state paths', t => {
  const dir = mkdtempSync(join(tmpdir(), 'android-caffeinate-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const bin = join(dir, 'fake-bin'); mkdirSync(bin);
  const trace = join(dir, 'args');
  writeFileSync(join(bin, 'caffeinate'), '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$TRACE_FILE"\nexit 23\n', {mode: 0o755});
  const source = readFileSync(new URL('../launcher/StarVoice 手机采集.command', import.meta.url), 'utf8');
  const command = source.split('\n').find(line => line.startsWith('exec '));
  assert.equal(command, 'exec caffeinate -is node cli.mjs up --state-dir "$STATE_DIR"');
  assert.doesNotMatch(source, /pmset\s+-[abc]|sudo|caffeinate[^\n]*&/);
  // Only the launcher's final line runs, against a fake caffeinate that never invokes node or the phone.
  const stateDir = join(dir, 'state with spaces $literal');
  const result = spawnSync('/bin/bash', ['-c', command], {encoding: 'utf8', env: {...process.env, PATH: `${bin}:${process.env.PATH}`,
    TRACE_FILE: trace, STATE_DIR: stateDir}});
  assert.equal(result.status, 23);
  assert.deepEqual(readFileSync(trace, 'utf8').split('\0').slice(0, -1), ['-is', 'node', 'cli.mjs', 'up', '--state-dir', stateDir]);
});

test('direct start also checks once before running and simulations skip host checks', () => {
  const source = readFileSync(new URL('../src/cli/daemon-commands.mjs', import.meta.url), 'utf8');
  const start = source.slice(source.indexOf('export async function startRunner('), source.indexOf('export async function daemonCommand('));
  assert.equal((start.match(/await warnWhenHostOnBattery\(/g) || []).length, 1);
  assert.match(start, /if \(!config\.simulation\) await warnWhenHostOnBattery\(\{store: daemon\.store, stdout\}\)/);
  assert.ok(start.indexOf('await warnWhenHostOnBattery') < start.indexOf('await daemon.run()'));
});
