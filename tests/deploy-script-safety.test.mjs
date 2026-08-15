import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deployScript = path.join(repositoryRoot, 'deploy', 'deploy.sh');

test('retired deploy script fails closed before build, network, or write tools run', async t => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'onstarvoice-deploy-guard-'));
  const mockBinDirectory = path.join(temporaryDirectory, 'bin');
  const invocationLog = path.join(temporaryDirectory, 'external-tool-called.log');
  await mkdir(mockBinDirectory);
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const externalTools = [
    'build',
    'node',
    'npm',
    'ssh',
    'rsync',
    'scp',
    'pm2',
    'mkdir',
    'install',
    'cp',
    'mv',
    'rm',
    'chown',
    'chmod',
    'stat',
  ];
  const mockTool = [
    '#!/bin/sh',
    'printf "%s\\n" "external tool called" >> "$DEPLOY_MOCK_INVOCATION_LOG"',
    'exit 99',
    '',
  ].join('\n');

  await Promise.all(externalTools.map(async tool => {
    const toolPath = path.join(mockBinDirectory, tool);
    await writeFile(toolPath, mockTool, 'utf8');
    await chmod(toolPath, 0o755);
  }));

  const result = spawnSync('/bin/bash', [deployScript, '203.0.113.10'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      DEPLOY_MOCK_INVOCATION_LOG: invocationLog,
      PATH: mockBinDirectory,
    },
    timeout: 5000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 64, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /deploy\/deploy\.sh is retired and disabled/u);
  assert.match(result.stderr, /controlled production release runbook: deploy\/DEPLOY\.md/u);
  assert.equal(existsSync(invocationLog), false, 'no mocked external tool may run');
});
