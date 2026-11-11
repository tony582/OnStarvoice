import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createWechatFlow} from '../src/device/wechat-flow.mjs';
import {ACTIVITY, POINT} from '../src/device/wechat-profile.mjs';

const keyword = '别克车机升级';
const resultRows = readFileSync(new URL('./fixtures/wechat/results-latest-20261105.ocr.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line));
const row = (text, x, y, w = 120, h = 40) => ({text, x, y, w, h});
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture({screenshotFails = false, abortOnScreenshot = null} = {}) {
  let stage = 'home', shots = 0, sortTaps = 0, resultsRead = 0, lastRows = [];
  const screen = {
    launch: async () => { stage = 'home'; }, defaultIme: async () => 'owner.keyboard/.IME',
    enableIme: async () => {}, setIme: async () => {}, disableIme: async () => {}, key: async () => {},
    typeUnicode: async value => assert.equal(value, keyword),
    tap: async (x, y) => {
      if (stage === 'home') stage = 'discover';
      else if (stage === 'discover') stage = 'channels';
      else if (stage === 'channels') stage = 'input';
      else if (stage === 'input' && x > 700) stage = 'results';
      else if (stage === 'results' && x === POINT.sort.latest.x && y === POINT.sort.latest.y) sortTaps++;
      else if (stage === 'results' && y > 500) stage = 'detail';
    },
    back: async () => { stage = 'results'; },
    screenshot: async () => {
      shots++;
      abortOnScreenshot?.abort();
      if (screenshotFails) throw Object.assign(new Error('fixture screenshot unavailable'), {code: 'screenshot_failed'});
      return Buffer.from(`fixture-shot-${shots}`);
    },
  };
  const view = {
    waitFor: async () => {}, activity: async () => ({activity: stage === 'detail' ? ACTIVITY.detail : ACTIVITY.search}),
    look: async () => {
      if (stage === 'home') return [row('微信', 60, 2150), row('通讯录', 300, 2150), row('发现', 600, 2150)];
      if (stage === 'discover') return [row('视频号', 100, 550)];
      if (stage === 'input') return [row('搜索', 920, 150)];
      lastRows = [...resultRows, ...Array.from({length: ++resultsRead}, () => row('ignored status', 900, 30))];
      return lastRows;
    },
  };
  return {flow: createWechatFlow({screen, view, now: () => Date.parse('2026-11-05T17:12:00+08:00'), wait: async () => {}}),
    shots: () => shots, sortTaps: () => sortTaps, rawRowCount: () => lastRows.length};
}

test('latest search records before/after screenshot hashes and honest limited sort evidence locally', async () => {
  const f = fixture(), notes = [];
  const result = await f.flow.search({keyword, sort: 'latest', onDiagnostic: entry => notes.push(entry)});
  assert.equal(result.verified, true);
  assert.equal(f.shots(), 2);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].event, 'wechat_sort_evidence');
  assert.equal(notes[0].beforeScreenshot.sha256, hash('fixture-shot-1'));
  assert.equal(notes[0].afterScreenshot.sha256, hash('fixture-shot-2'));
  assert.equal(notes[0].selectedState, 'unavailable', 'text-only OCR cannot prove bold/selected');
  assert.equal(notes[0].selectionEvidence, 'ocr_has_no_style');
  assert.deepEqual(notes[0].sortCheck, {passed: true, knownAges: 2, parsedCards: 2, result: 'too_few_readable_ages'});
  assert.equal(JSON.stringify(result).includes('Screenshot'), false, 'diagnostic stays out of search response');
});

test('each returned card array carries raw OCR and parsed counts without changing JSON or array behavior', async () => {
  const f = fixture();
  const check = cards => {
    assert.ok(Array.isArray(cards));
    assert.deepEqual(cards.screenEvidence, {rawOcrRows: f.rawRowCount(), parsedCards: cards.length});
    assert.equal(Object.keys(cards).includes('screenEvidence'), false);
    assert.equal(JSON.stringify(cards).includes('screenEvidence'), false);
    assert.deepEqual(cards.map(card => card.column), [0, 1]);
  };
  const result = await f.flow.search({keyword, sort: 'all'}); check(result.cards);
  assert.equal(f.shots(), 0, 'no extra evidence screenshots for non-latest searches');
  check(await f.flow.readCards({}));
  await f.flow.openCard({card: result.cards[0]});
  check(await f.flow.returnToResults({}));
  check(await f.flow.recoverResults({}));
});

test('screenshot and local diagnostic failures do not fail a verified latest search', async () => {
  const f = fixture({screenshotFails: true}), notes = [];
  const result = await f.flow.search({keyword, sort: 'latest', onDiagnostic: entry => {
    notes.push(entry); throw new Error('local diagnostic store unavailable');
  }});
  assert.equal(result.verified, true);
  assert.equal(notes[0].beforeScreenshot.sha256, null);
  assert.equal(notes[0].beforeScreenshot.error, 'screenshot_failed');
  assert.equal(notes[0].afterScreenshot.sha256, null);
  assert.equal(notes[0].afterScreenshot.error, 'screenshot_failed');
});

test('cancellation during the evidence screenshot never proceeds to the sort tap', async () => {
  const controller = new AbortController(), f = fixture({abortOnScreenshot: controller});
  await assert.rejects(f.flow.search({keyword, sort: 'latest', signal: controller.signal}), {code: 'aborted'});
  assert.equal(f.sortTaps(), 0);
});
