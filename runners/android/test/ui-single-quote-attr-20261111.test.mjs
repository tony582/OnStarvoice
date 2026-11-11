// 2026-11-10/11: 别克OTA exhausted three attempts in each overnight mobile batch with invalid_ui_source.
// The retained openCard diagnostics all stopped at text='别克"至境世家"广告': a valid single-quoted XML attribute.
// Keep the exact caption and exercise the real UI-session parser through a fake source, without a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUiTree} from '../src/device/ui-tree.mjs';
import {createUiSession} from '../src/device/ui-session.mjs';
import {runDiscoveryTask} from '../src/core/discovery-runner.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {fixtureTask, fixtureClock, fixturePermit, fixtureDevice} from './core-fixtures.mjs';

const node = (attrs, body = '') => `<android.widget.TextView ${attrs}>${body}</android.widget.TextView>`;
const doc = body => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy index="0" class="hierarchy">${body}</hierarchy>`;
const caught = xml => { try { parseUiTree(xml); } catch (error) { return error; } assert.fail('expected invalid_ui_source'); };
const caption = '别克"至境世家"广告';
const observedAttributes = `index="1" package="com.ss.android.ugc.aweme" class="android.widget.TextView" text='别克"至境世家"广告' resource-id="com.ss.android.ugc.aweme:id/46l" checkable="false"`;

test('the exact Buick ad attribute and the following attributes parse unchanged', () => {
  const {attributes} = parseUiTree(doc(node(observedAttributes))).root.children[0];
  assert.equal(attributes.text, caption);
  assert.equal(attributes['resource-id'], 'com.ss.android.ugc.aweme:id/46l');
  assert.equal(attributes.checkable, 'false');
});

test('a greater-than sign inside a single-quoted value does not end the tag', () => {
  const {attributes} = parseUiTree(doc(node(`text='a>b "c"'`))).root.children[0];
  assert.equal(attributes.text, 'a>b "c"');
});

test('an odd double quote inside a single-quoted value cannot swallow its sibling tag', () => {
  const {children} = parseUiTree(doc(`<A text='5" 屏'/><B text="x"/>`)).root;
  assert.equal(children.length, 2);
  assert.deepEqual(children.map(({tag, attributes}) => [tag, attributes.text]), [['A', '5" 屏'], ['B', 'x']]);
});

test('an apostrophe inside a double-quoted value remains literal', () => {
  assert.equal(parseUiTree(doc(node(`text="it's"`))).root.children[0].attributes.text, "it's");
});

test('one tag can mix single-quoted and double-quoted attributes', () => {
  assert.deepEqual(parseUiTree(doc(node(`a="1" b='2' c="3"`))).root.children[0].attributes, {a: '1', b: '2', c: '3'});
});

test('single-quoted values retain the existing bounded entity decoding', () => {
  assert.equal(parseUiTree(doc(node(`text='&apos;&quot;&lt;&#128512;'`))).root.children[0].attributes.text, `'"<😀`);
});

test('empty values are preserved with either quote delimiter', () => {
  assert.deepEqual(parseUiTree(doc(node(`a="" b=''`))).root.children[0].attributes, {a: '', b: ''});
});

for (const [name, attrs, parser] of [
  ['mismatched quotes', `text='abc"`, 'stray_text'],
  ['a bare ampersand', `text='a & b'`, 'bare_ampersand'],
  ['an unquoted value', 'text=oops', 'invalid_attribute'],
  ['whitespace before equals', `text ='abc'`, 'invalid_attribute'],
  ['whitespace after equals', `text= 'abc'`, 'invalid_attribute'],
  ['a duplicate attribute across delimiters', `text="a" text='b'`, 'duplicate_attribute'],
  ['an unknown entity', `text='&bogus;'`, 'unknown_entity'],
]) {
  test(`single-quote support still rejects ${name}`, () => {
    const error = caught(doc(node(attrs)));
    assert.equal(error.code, 'invalid_ui_source');
    assert.equal(error.diagnostic.parser, parser);
  });
}

test('raw less-than diagnostics start at the offending value rather than the previous closing quote', () => {
  for (const value of ["'a<b'", '"it\'s<x"', '"a<b"']) {
    const error = caught(doc(node(`index="0" text=${value}`)));
    assert.equal(error.code, 'invalid_ui_source');
    assert.equal(error.diagnostic.parser, 'invalid_tag');
    assert.ok(error.diagnostic.context.after.startsWith(value), error.diagnostic.context.after);
  }
});

test('single-quote support does not allow DTD or entity declarations', () => {
  const error = caught(`<!DOCTYPE hierarchy [<!ENTITY caption 'ad'>]>${doc(node("text='&caption;'"))}`);
  assert.equal(error.code, 'invalid_ui_source');
  assert.equal(error.diagnostic.parser, 'markup_declaration');
});

test('a Buick OTA keyword completes through real UI-session reads of the ad XML using a fake client', async () => {
  // Existing fake devices return business objects or already-parsed trees. Read raw XML through ui-session here
  // at both readCards and openCard, so a parser regression reaches the keyword outcome instead of being bypassed.
  const task = fixtureTask({keyword: '别克OTA'});
  const clock = fixtureClock();
  const permit = fixturePermit(task, clock);
  const store = new RunnerStore(':memory:');
  let sourceReads = 0;
  const ui = createUiSession({sessionId: 'fixture-session', client: {
    source: async (sessionId, options) => {
      assert.equal(sessionId, 'fixture-session');
      assert.equal(options.timeoutMs, 10000);
      sourceReads++;
      return doc(node('text="别克OTA"') + node(observedAttributes));
    },
  }});
  const readAd = async signal => {
    const {root} = await ui.read({signal});
    assert.equal(root.children.length, 2);
    assert.equal(root.children[0].attributes.text, task.keyword);
    const ad = root.children[1].attributes;
    assert.equal(ad.text, caption);
    assert.equal(ad['resource-id'], 'com.ss.android.ugc.aweme:id/46l');
    assert.equal(ad.checkable, 'false');
    return ad;
  };
  const {device, calls} = fixtureDevice(task, {
    readCards: async ({signal}) => ({contextVerified: true, contextId: 'context-1', end: true,
      cards: [{cardId: 'card-1', title: (await readAd(signal)).text, author: '车友'}]}),
    openCard: async ({card, signal}) => {
      assert.equal((await readAd(signal)).text, card.title);
      return {identityVerified: true, cardId: card.cardId, detailId: 'detail-1', externalId: '1234567890123456789'};
    },
  });
  try {
    const result = await runDiscoveryTask({task, store, device, permit, clock});
    assert.equal(result.status, 'completed');
    assert.equal(result.reason, 'results_end');
    assert.equal(result.stats.links, 1);
    assert.equal(result.deviceIdle, true);
    assert.equal(sourceReads, 2);
    assert.deepEqual(calls, ['inspect', 'search', 'readCards', 'openCard', 'copyLink', 'returnToResults']);
  } finally { store.close(); }
});
