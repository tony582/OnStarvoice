import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  defaultAuthCodeExpiry,
  parseAuthCodeExpiry,
  parseAuthCodeMaxBindings,
} from '../server/routes/admin.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('activation code device limit accepts configurable positive integers', () => {
  assert.equal(parseAuthCodeMaxBindings(1), 1);
  assert.equal(parseAuthCodeMaxBindings('12'), 12);
  assert.equal(parseAuthCodeMaxBindings(undefined), 3);
  assert.throws(() => parseAuthCodeMaxBindings(0), /设备上限/);
  assert.throws(() => parseAuthCodeMaxBindings(1.5), /设备上限/);
  assert.throws(() => parseAuthCodeMaxBindings(10001), /设备上限/);
});

test('manual expiry date remains valid through the selected Shanghai calendar day', () => {
  assert.equal(
    parseAuthCodeExpiry('2026-07-24').toISOString(),
    '2026-07-24T15:59:59.999Z',
  );
  assert.equal(parseAuthCodeExpiry(null, { allowNull: true }), null);
  assert.throws(() => parseAuthCodeExpiry('not-a-date'), /到期日格式/);
});

test('default activation code expiry keeps existing presets compatible', () => {
  assert.equal(defaultAuthCodeExpiry('permanent'), null);
  const trialDays = Math.round(
    (defaultAuthCodeExpiry('trial').getTime() - Date.now()) / 86400000,
  );
  assert.equal(trialDays, 7);
  assert.ok(defaultAuthCodeExpiry('annual') > new Date());
});

test('admin activation code page exposes create and post-create entitlement controls', async () => {
  const source = await readFile(
    resolve(repoRoot, 'web/admin/src/pages/AdminPages.tsx'),
    'utf8',
  );
  assert.match(source, /设备上限\(浏览器 Agent\)/);
  assert.match(source, /type="date"/);
  assert.match(source, /maxBindings,/);
  assert.match(source, /expiresAt: form\.type === 'permanent' \? null : form\.expiresOn/);
  assert.match(source, /调整设备与有效期/);
  assert.match(source, /设备上限不能低于当前已绑定数量/);
});
