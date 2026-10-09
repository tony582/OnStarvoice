// 2026-09-26 and 2026-10-08: the same invalid_ui_source signature (a TextView whose fourth attribute, text, the parser
// rejected) ended several keywords, and the notes never said which characters were there. The parser now records a
// bounded window around the failure in the local diagnostic only; the uploaded completion details stay whitelisted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUiTree, failureContext} from '../src/device/ui-tree.mjs';
import {faultDetails} from '../src/core/discovery-runner.mjs';
import {recordDiagnostic, readDiagnostics} from '../src/core/diagnostics.mjs';

const node = (attrs, body = '') => `<android.widget.TextView ${attrs}>${body}</android.widget.TextView>`;
const doc = body => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy index="0" class="hierarchy">${body}</hierarchy>`;
const caught = xml => { try { parseUiTree(xml); } catch (error) { return error; } assert.fail('expected invalid_ui_source'); };

test('an attribute the grammar rejects is reported with the text around it and the odd code points in it', () => {
  const error = caught(doc(node('index="0" package="com.ss.android.ugc.aweme" class="android.widget.TextView" text=oops\u0001 displayed="true"')));
  const {diagnostic} = error;
  assert.equal(error.code, 'invalid_ui_source');
  assert.deepEqual([diagnostic.parser, diagnostic.tag, diagnostic.parsedAttributes, diagnostic.lastAttribute],
    ['invalid_attribute', 'android.widget.TextView', 3, 'class']);
  assert.deepEqual(diagnostic.nextCodePoints, [116, 101, 120, 116]);
  assert.ok(diagnostic.context.before.endsWith('class="android.widget.TextView"'), diagnostic.context.before);
  assert.ok(diagnostic.context.after.startsWith(' text=oops\u0001 displayed="true"'), JSON.stringify(diagnostic.context.after));
  assert.deepEqual(diagnostic.context.oddCodePoints, [1]);
  assert.equal(typeof diagnostic.context.offset, 'number');
});

test('the window is bounded in code points and never splits an emoji, so a lone surrogate in it is a real one', () => {
  const long = '😀'.repeat(300);
  const error = caught(doc(node(`caption="${long}" b=c`)));
  const {context} = error.diagnostic;
  assert.equal(Array.from(context.before).length, 80);
  assert.ok(context.before.isWellFormed() && context.after.isWellFormed());
  assert.deepEqual(context.oddCodePoints, []);
  assert.ok(context.after.startsWith(' b=c'));
  // A real lone surrogate in the source is kept and reported.
  const lone = caught(doc(node(`text="a\ud83db" c=d`)));
  assert.deepEqual(lone.diagnostic.context.oddCodePoints, [0xd83d]);
  assert.equal(lone.diagnostic.context.before.includes('\ud83d'), true);
  // The window edges are cut on character boundaries even when the raw cut would land inside a pair.
  const edge = failureContext('x'.repeat(5) + '😀'.repeat(200) + 'y', 5 + 2 * 200 + 1 - 1, 80);
  assert.ok(edge.before.isWellFormed() && edge.after.isWellFormed());
  assert.equal(Array.from(edge.before).length, 80);
});

test('other rules name what they saw: a raw < in a value, stray text, a bare ampersand, a mismatched close tag', () => {
  const raw = caught(doc(node('index="0" text="a<b"')));
  assert.equal(raw.diagnostic.parser, 'invalid_tag');
  assert.ok(raw.diagnostic.context.after.startsWith('"a<b"'), raw.diagnostic.context.after);
  const stray = caught(doc('oops' + node('index="0"')));
  assert.equal(stray.diagnostic.parser, 'stray_text');
  assert.ok(stray.diagnostic.context.after.startsWith('oops<android.widget.TextView'));
  const bare = caught(doc(node('index="0" text="a & b"')));
  assert.deepEqual([bare.diagnostic.parser, bare.diagnostic.attribute, bare.diagnostic.context.after], ['bare_ampersand', 'text', '& b']);
  const entity = caught(doc(node('index="0" text="a &bogus; b"')));
  assert.deepEqual([entity.diagnostic.parser, entity.diagnostic.attribute, entity.diagnostic.entity], ['unknown_entity', 'text', 'bogus']);
  const dup = caught(doc(node('index="0" index="1"')));
  assert.deepEqual([dup.diagnostic.parser, dup.diagnostic.attribute], ['duplicate_attribute', 'index']);
  const unbalanced = caught(doc('<android.widget.FrameLayout index="0"><android.widget.TextView index="1"></android.widget.FrameLayout></android.widget.TextView>'));
  assert.deepEqual([unbalanced.diagnostic.parser, unbalanced.diagnostic.closeTag, unbalanced.diagnostic.openTag],
    ['unbalanced_tag', 'android.widget.FrameLayout', 'android.widget.TextView']);
  // A well-formed hierarchy still parses, including a caption with > and escaped characters.
  const tree = parseUiTree(doc(node('index="0" text="A>B &lt;3 &#128512;"')));
  assert.equal(tree.root.children[0].attributes.text, 'A>B <3 😀');
});

test('the context never reaches the uploaded completion details, and the local note keeps it within bounds', () => {
  const error = caught(doc(node('index="0" text=bad')));
  const details = faultDetails(error);
  assert.equal('diagnostic' in details, false);
  assert.equal('context' in details, false);
  assert.equal(JSON.stringify(details).includes('bad'), false);
  const entries = {};
  const store = {loadCheckpoint: key => entries[key] ?? null, saveCheckpoint: (key, value, revision) => { entries[key] = {value, revision: revision + 1}; }};
  recordDiagnostic(store, {at: new Date().toISOString(), event: 'task_finished', status: 'needs_action', reason: 'invalid_ui_source', diagnostic: error.diagnostic});
  const [note] = readDiagnostics(store);
  assert.equal(note.diagnostic.parser, 'invalid_attribute');
  assert.equal(note.diagnostic.context.after.startsWith(' text=bad'), true);
  assert.deepEqual(note.diagnostic.context.oddCodePoints, []);
});
