import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardFixture = path.join(
  repositoryRoot,
  'tests',
  'fixtures',
  'process-role-entrypoint-guard.mjs',
);

const probeSource = String.raw`
  import assert from 'node:assert/strict';
  import net from 'node:net';
  import { once } from 'node:events';

  const server = net.createServer(socket => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const localSocket = net.connect({ host: '127.0.0.1', port: address.port });
  await once(localSocket, 'connect');
  localSocket.end();
  await once(localSocket, 'close');

  assert.throws(
    () => net.connect({ host: '203.0.113.1', port: 443 }),
    error => error?.code === 'P2B_TEST_NONLOCAL_OUTBOUND_BLOCKED',
  );
  assert.throws(
    () => fetch('http://203.0.113.1/'),
    error => error?.code === 'P2B_TEST_NONLOCAL_OUTBOUND_BLOCKED',
  );

  server.close();
  await once(server, 'close');
`;

test('entrypoint child guard allows loopback TCP and blocks non-local socket and fetch traffic', () => {
  const result = spawnSync(process.execPath, [
    '--import',
    pathToFileURL(guardFixture).href,
    '--input-type=module',
    '--eval',
    probeSource,
  ], {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH || '',
      TMPDIR: process.env.TMPDIR || '',
      LANG: process.env.LANG || 'C',
      ONSTARVOICE_TEST_EXIT_DELAY_MS: '0',
    },
    encoding: 'utf8',
    timeout: 5000,
  });

  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, output);
  assert.match(output, /\[P2BTestGuard\] active/u);
  assert.equal(
    [...output.matchAll(/\[P2BTestGuard\] BLOCKED_NONLOCAL_OUTBOUND/gu)].length,
    2,
  );
});
