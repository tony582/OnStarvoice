import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { checkExtensionUiBoundary } from '../../scripts/check-extension-ui-boundary.mjs';

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const HTML = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><link rel="stylesheet" href="./styles.css"></head><body><img src="../images/icon128.png" alt="StarVoice"><script type="module" src="./app.mjs"></script></body></html>`;

async function fixture(t, changes = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'extension-ui-boundary-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'extension-ui');
  const contents = {
    '../images/icon128.png': 'test-image',
    'index.html': HTML,
    'styles.css': 'body { color: #123; }',
    'app.mjs': "import { model } from './domain/model.mjs'; import { port } from './preview/port.mjs'; export { model, port };",
    'domain/model.mjs': 'export const model = Object.freeze({ state: "preview" });',
    'preview/port.mjs': 'export const port = { read: () => [] };',
    ...changes,
  };
  for (const [name, content] of Object.entries(contents)) {
    if (content === null) continue;
    const destination = path.resolve(root, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  return root;
}

async function expectRule(t, changes, rule) {
  const result = await checkExtensionUiBoundary({ root: await fixture(t, changes) });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.rule === rule), JSON.stringify(result.findings));
  return result;
}

test('independent local graph, offline CSP and approved icon pass', async t => {
  const result = await checkExtensionUiBoundary({ root: await fixture(t) });
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.files.length, 5);
});

test('the actual independent UI source tree passes the default boundary gate', async () => {
  const result = await checkExtensionUiBoundary();
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.ok(result.files.length > 0);
});

test('transitive module cannot import existing runtime outside UI', async t => {
  await expectRule(t, { 'domain/model.mjs': "export { x } from '../../utils/storage.js';" }, 'outside-ui');
});

test('unreferenced source files are checked as well as reachable modules', async t => {
  await expectRule(t, { 'preview/dormant.mjs': "import '../../sidebar/sidebar-logic.js';" }, 'outside-ui');
});

test('bare packages and remote modules do not enter the UI graph', async t => {
  await expectRule(t, { 'app.mjs': "import 'some-package';" }, 'local-reference');
  await expectRule(t, { 'app.mjs': "import x from 'https://cdn.example/app.mjs';" }, 'local-reference');
});

test('comments between import tokens do not hide dependency escapes', async t => {
  await expectRule(t, { 'app.mjs': "import /* note */ '../../server/entry.js';" }, 'outside-ui');
  await expectRule(t, { 'app.mjs': "export { item } /* note */ from '../../server/entry.js';" }, 'outside-ui');
  await expectRule(t, { 'app.mjs': "import(/* note */ '../../server/entry.js');" }, 'outside-ui');
});

test('literal dynamic local import passes, computed dynamic import fails closed', async t => {
  const root = await fixture(t, { 'app.mjs': "export const load = () => import('./domain/model.mjs');" });
  assert.equal((await checkExtensionUiBoundary({ root })).ok, true);
  await expectRule(t, { 'app.mjs': 'export const load = name => import(name);' }, 'dynamic-import');
});

test('missing files, unsupported module extensions and encoded paths are rejected', async t => {
  await expectRule(t, { 'app.mjs': "import './absent.mjs';" }, 'missing-reference');
  await expectRule(t, { 'app.mjs': "import './styles.css';" }, 'module-type');
  await expectRule(t, { 'app.mjs': "import './%2e%2e/utils/storage.js';" }, 'local-reference');
});

test('network calls are forbidden in every source layer', async t => {
  for (const code of ["fetch('/api/status')", 'new XMLHttpRequest()', "new WebSocket('wss://example.test')", "navigator.sendBeacon('/api', 'x')"]) {
    await expectRule(t, { 'preview/port.mjs': code }, 'network-api');
  }
});

test('extension API, dynamic code and persistent browser state are forbidden', async t => {
  for (const code of ['chrome.runtime.sendMessage({})', "browser['runtime'].sendMessage({})", 'const api = chrome;', "const api = globalThis['chrome'];"]) {
    await expectRule(t, { 'app.mjs': code }, 'extension-api');
  }
  await expectRule(t, { 'app.mjs': 'new Function("return 1")()' }, 'dynamic-code');
  await expectRule(t, { 'preview/port.mjs': "localStorage.setItem('x', 'y')" }, 'persistent-browser-state');
});

test('legacy references and brand names cannot enter new source', async t => {
  await expectRule(t, { 'styles.css': '/* MediaClaw replacement */' }, 'legacy-reference');
  await expectRule(t, { 'app.mjs': 'const path = "../background.js";' }, 'legacy-reference');
});

test('clipboard exception is restricted to one preview adapter and sanitized argument shape', async t => {
  const root = await fixture(t, {
    'preview/clipboard.mjs': 'export const copy = sanitizedDiagnostics => navigator.clipboard.writeText(sanitizedDiagnostics);',
  });
  assert.equal((await checkExtensionUiBoundary({ root })).ok, true);
  await expectRule(t, { 'app.mjs': 'navigator.clipboard.writeText(sanitizedDiagnostics)' }, 'clipboard-boundary');
  await expectRule(t, { 'preview/clipboard.mjs': 'navigator.clipboard.writeText(rawRecord)' }, 'clipboard-boundary');
  // This lint checks capability placement, not whether the input was truly sanitized.
});

test('inline scripts, import maps and handlers are rejected', async t => {
  await expectRule(t, { 'index.html': HTML.replace('</body>', '<script>alert(1)</script></body>') }, 'inline-script');
  await expectRule(t, { 'index.html': HTML.replace('</body>', '<script type="importmap">{}</script></body>') }, 'inline-script');
  await expectRule(t, { 'index.html': HTML.replace('<body>', '<body onload="alert(1)">') }, 'inline-html');
  await expectRule(t, { 'index.html': HTML.replace('src="./app.mjs"></script>', 'src="./app.mjs">alert(1)</script>') }, 'inline-script');
});

test('CSP must block connections and appear before all resource loads', async t => {
  await expectRule(t, { 'index.html': HTML.replace("connect-src 'none'", "connect-src 'self'") }, 'preview-csp');
  await expectRule(t, { 'index.html': HTML.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") }, 'preview-csp');
  await expectRule(t, { 'index.html': HTML.replace('<head>', '<head><script type="module" src="./app.mjs"></script>') }, 'preview-csp');
  await expectRule(t, { 'index.html': HTML.replace("connect-src 'none'", "connect-src 'none'; connect-src *") }, 'preview-csp');
  await expectRule(t, { 'index.html': HTML.replace("script-src 'self'", "script-src 'self'; script-src-elem *") }, 'preview-csp');
});

test('duplicate HTML attributes cannot substitute a different CSP or resource for the browser', async t => {
  await expectRule(t, {
    'index.html': HTML.replace(`content="${CSP}"`, `content="default-src *" CONTENT="${CSP}"`),
  }, 'duplicate-html-attribute');
  await expectRule(t, {
    'index.html': HTML.replace('src="./app.mjs"', 'src="./unreviewed.mjs" SRC="./app.mjs"'),
    'unreviewed.mjs': 'export const value = 1;',
  }, 'duplicate-html-attribute');
  await expectRule(t, {
    'index.html': HTML.replace('<body>', '<body hidden HIDDEN>'),
  }, 'duplicate-html-attribute');
});

test('commented CSP tags cannot satisfy the browser policy requirement', async t => {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  await expectRule(t, { 'index.html': HTML.replace(meta, `<!-- ${meta} -->`) }, 'preview-csp');
  await expectRule(t, { 'index.html': HTML.replace(meta, `<!-- ${meta}`) }, 'preview-csp');
});

test('commented tags do not count as duplicate policies or active scripts and preserve finding lines', async t => {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  const root = await fixture(t, {
    'index.html': HTML.replace('<head>', `<head><!--\n${meta}\n<script>ignored example</script>\n-->`),
  });
  const result = await checkExtensionUiBoundary({ root });
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  const invalid = await expectRule(t, {
    'index.html': HTML.replace('<body>', '<body>\n<!--\ncomment\n-->\n<script>active()</script>'),
  }, 'inline-script');
  assert.ok(invalid.findings.some(finding => finding.rule === 'inline-script' && finding.line === 5));
});

test('HTML cannot load CDN scripts or non-approved outside assets', async t => {
  await expectRule(t, { 'index.html': HTML.replace('./app.mjs', 'https://cdn.example/app.mjs') }, 'local-reference');
  await expectRule(t, { 'index.html': HTML.replace('../images/icon128.png', '../images/other.png') }, 'outside-ui');
  await expectRule(t, { 'index.html': HTML.replace('</body>', '<iframe src="./index.html"></iframe></body>') }, 'active-html');
});

test('CSS imports and URL dependencies are checked', async t => {
  await expectRule(t, { 'styles.css': "@import 'https://cdn.example/fonts.css';" }, 'local-reference');
  await expectRule(t, { 'styles.css': "body { background: url('../../sidebar/old.svg'); }" }, 'outside-ui');
});

test('symlink files cannot bridge to another source tree', async t => {
  const root = await fixture(t);
  await symlink(path.resolve(root, '../images/icon128.png'), path.join(root, 'linked.mjs'));
  const result = await checkExtensionUiBoundary({ root });
  assert.ok(result.findings.some(finding => finding.rule === 'symlink'));
});

test('missing root fails; core-only mode is explicitly not completed UI', async t => {
  const root = await fixture(t, { 'app.mjs': null, 'index.html': null });
  const core = await checkExtensionUiBoundary({ root });
  assert.equal(core.ok, true);
  assert.equal(core.mode, 'core-only');
  assert.equal(core.uiEntryPresent, false);
  const required = await checkExtensionUiBoundary({ root, requireUiEntry: true });
  assert.equal(required.ok, false);
  assert.equal(required.findings.filter(finding => finding.rule === 'missing-entry').length, 2);
  const missing = await checkExtensionUiBoundary({ root: path.join(root, 'not-created') });
  assert.equal(missing.ok, false);
  assert.equal(missing.findings[0].rule, 'missing-root');
});

test('required entry mode rejects missing app and validates complete entry', async t => {
  const root = await fixture(t, { 'app.mjs': null });
  assert.ok((await checkExtensionUiBoundary({ root, requireUiEntry: true })).findings.some(finding => finding.rule === 'missing-entry'));
  const complete = await checkExtensionUiBoundary({ root: await fixture(t), requireUiEntry: true });
  assert.equal(complete.ok, true);
  assert.equal(complete.mode, 'ui-entry');
});

test('an empty directory cannot count as a checked module batch', async t => {
  const root = await fixture(t);
  const empty = path.join(root, 'empty');
  await mkdir(empty);
  const result = await checkExtensionUiBoundary({ root: empty });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.rule === 'missing-source'));
});

test('standalone CLI prints findings and returns nonzero for violations', async t => {
  const script = fileURLToPath(new URL('../../scripts/check-extension-ui-boundary.mjs', import.meta.url));
  const validRoot = await fixture(t);
  const valid = spawnSync(process.execPath, [script, validRoot], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /5 source files/u);
  const badRoot = await fixture(t, { 'app.mjs': 'fetch("/api")' });
  const invalid = spawnSync(process.execPath, [script, badRoot], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /app\.mjs:1 \[network-api\]/u);
  const coreRoot = await fixture(t, { 'app.mjs': null, 'index.html': null });
  const core = spawnSync(process.execPath, [script, coreRoot], { encoding: 'utf8' });
  assert.equal(core.status, 0);
  assert.match(core.stdout, /core-only; UI entry absent, not a completed UI/u);
  const required = spawnSync(process.execPath, [script, '--require-ui-entry', coreRoot], { encoding: 'utf8' });
  assert.equal(required.status, 1);
  assert.match(required.stderr, /\[missing-entry\]/u);
});
