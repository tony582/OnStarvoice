import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const minimumTestCount = 1341;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(repositoryRoot, 'tests');

async function listTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTests(absolutePath);
    return entry.isFile() && entry.name.endsWith('.test.mjs') ? [absolutePath] : [];
  }));
  return nested.flat();
}

const tests = (await listTests(testRoot)).sort();
if (tests.length === 0) {
  console.error(`No Node.js regression tests found in ${testRoot}.`);
  process.exit(2);
}

const child = spawn(
  process.execPath,
  ['--test', '--test-reporter=spec', ...tests],
  { cwd: repositoryRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
);

let outputTail = '';
const tailLimit = 4 * 1024 * 1024;

child.stdout.on('data', chunk => {
  const text = chunk.toString();
  process.stdout.write(text);
  outputTail = `${outputTail}${text}`.slice(-tailLimit);
});
child.stderr.pipe(process.stderr);

const status = await new Promise(resolve => {
  child.once('error', error => {
    console.error(`Could not start Node.js regression tests: ${error.message}`);
    resolve(2);
  });
  child.once('close', code => resolve(code ?? 2));
});

if (status !== 0) process.exit(status);

const summaries = [...outputTail.matchAll(/(?:^|\n)\s*ℹ tests\s+(\d+)\s*(?:\n|$)/gu)];
const testCount = Number(summaries.at(-1)?.[1]);

if (!Number.isInteger(testCount)) {
  console.error('Could not read the final test count from the Node.js test reporter.');
  process.exit(2);
}

if (testCount < minimumTestCount) {
  console.error(`Regression test count dropped below its floor: ${testCount} < ${minimumTestCount}.`);
  process.exit(1);
}

console.log(`Regression test floor satisfied: ${testCount} >= ${minimumTestCount}.`);
