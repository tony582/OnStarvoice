import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {cardKey, parseResultCards, RESULTS_TOP, sameCard, SCREEN} from '../src/device/wechat-ocr-parse.mjs';

// Unedited real DE106 / WeChat OCR supplied by Claude, 2026-11-11. The source paths are provenance only;
// tests use these tracked fixtures, never the ignored output directory or a running phone.
const cases = [
  {file: 'results-missing-duration-anjixing-20261111.json', source: 'm-anjixing/007.json',
    sha: '13ef939e655ebc992585bf0b5852911009e9a0dd802d6d94ce8bca63ee0d52b1',
    authors: ['永杰辰溪', '甘肃卓润汽'], times: ['18小时前', '19小时前'], durations: ['00:04', ''],
    snippets: ['…别克至境E7#新能源汽车#车机体验 #安吉星#真实车.', '别克的安吉星到期，还有没有必要继续续费？哪些功.']},
  {file: 'results-duration-zero-20261111.json', source: 'search-only/005.json',
    sha: '3e64858dd2ed6effa5fa500d6217245eebce97fcc6960968e5a8be47de2d6e50',
    authors: ['南宁360全', '鑫互联车改汽车'], times: ['18小时前', '昨天'], durations: ['00', '01:03'],
    snippets: ['2021款凯迪拉克 CT5原车屏升级360/720°全景记.…', '凯迪拉克xts换屏升级原车风格全景影像#凯迪拉克xt...']},
  {file: 'results-duration-dash-20261111.json', source: 'search-only/017.json',
    sha: 'b98e7645a8daf08985e2524eb9d9e3da6649368f1e26b721aff9ba7684303f1d',
    authors: ['云舟度月2024', '星拓的至境E7'], times: ['9天前', '10天前'], durations: ['00-45', '01:19'],
    snippets: ['别克至境E7 想减少静置掉电，记住这几个设置！先.', '至境E7提车前须知：一定要提前准备一张专用内存卡.']},
  {file: 'results-merged-author-time-20261111.json', source: 'search-only/023.json',
    sha: 'f1af81e7ac5c641c7ce91f9c18ac5caad416585df24854c280be5deecbd8b5fb',
    authors: ['海南凯迪拉克', 'ishoug 好奇'], times: ['4小时前', '18小时前'], durations: ['00:33', ''],
    snippets: ['凯迪拉克XT5 PHEV哨兵模式，全车多颗摄像头环绕.', '今天充完电，顺便试试XT5PHEV的哨兵模式，看看.']},
];
const now = Date.parse('2026-11-11T13:53:00+08:00');
function fixture(item) {
  const bytes = readFileSync(new URL(`./fixtures/wechat/${item.file}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha, `unaltered ${item.source}`);
  return JSON.parse(bytes);
}

for (const item of cases) {
  test(`real card screen ${item.source}: both complete cards, correct order, incomplete bottom row omitted`, () => {
    const screen = fixture(item);
    assert.deepEqual([screen.width, screen.height], [SCREEN.width, SCREEN.height]);
    const cards = parseResultCards(screen.rows, {now});
    assert.equal(cards.length, 2);
    assert.deepEqual(cards.map(card => card.column), [0, 1]);
    assert.deepEqual(cards.map(card => card.author), item.authors);
    assert.deepEqual(cards.map(card => card.timeLabel), item.times);
    assert.deepEqual(cards.map(card => card.durationLabel), item.durations);
    assert.deepEqual(cards.map(card => card.snippet), item.snippets);
    for (const card of cards) {
      assert.equal(card.cardKey, cardKey(card));
      assert.equal(card.tap.x, card.column === 0 ? 275 : 805);
      assert.equal(card.tap.y, Math.max(RESULTS_TOP + 60, card.metadataY - 420));
      assert.ok(card.tap.y < card.anchorY && card.tap.y >= RESULTS_TOP + 60);
    }
  });
}

test('duration is optional evidence: missing, truncated and duplicated duration rows do not change card identity', () => {
  const screen = fixture(cases[0]);
  const original = parseResultCards(screen.rows, {now});
  const without = screen.rows.filter(row => !/^\d{1,2}[:：-]\d{2}$/u.test(row.text));
  const absent = parseResultCards(without, {now});
  assert.deepEqual(absent.map(card => card.durationLabel), ['', '']);
  assert.deepEqual(absent.map(card => card.cardKey), original.map(card => card.cardKey));
  const duration = screen.rows.find(row => row.text === '00:04');
  const variant = without.concat({...duration, text: '0:04'}, {...duration, text: '00'});
  const cards = parseResultCards(variant, {now});
  assert.equal(cards.length, 2);
  assert.equal(cards[0].durationLabel, '0:04');
  assert.deepEqual(cards.map(card => card.cardKey), original.map(card => card.cardKey));
  assert.equal(sameCard(cards[0], original[0]), true);
  assert.equal(sameCard(cards[1], original[1]), true);
});

test('a readable name with unknown age remains a card; no name or incomplete metadata never becomes a card', () => {
  const screen = fixture(cases[0]);
  const noTime = screen.rows.filter(row => row.text !== '18小时前');
  const cards = parseResultCards(noTime, {now});
  assert.equal(cards.length, 2);
  assert.equal(cards[0].author, '永杰辰溪');
  assert.equal(cards[0].timeLabel, '');
  assert.equal(cards[0].age, null);
  const noName = screen.rows.filter(row => row.text !== '永杰辰溪');
  assert.deepEqual(parseResultCards(noName, {now}).map(card => card.author), ['甘肃卓润汽']);
  const clipped = screen.rows.map(row => row.text === '永杰辰溪' ? {...row, h: SCREEN.height - row.y + 1} : row);
  assert.deepEqual(parseResultCards(clipped, {now}).map(card => card.author), ['甘肃卓润汽']);
});

test('the new name anchor preserves top-to-bottom ordering after a scroll and stays within the thumbnail', () => {
  const rows = fixture(cases[0]).rows.filter(row => row.y >= 1150 && row.y < 1400);
  const shifted = rows.map(row => ({...row, y: row.y - 600}));
  const cards = parseResultCards(shifted.concat(rows), {now});
  assert.deepEqual(cards.map(card => card.column), [0, 1, 0, 1]);
  assert.deepEqual(cards.map(card => card.author), ['永杰辰溪', '甘肃卓润汽', '永杰辰溪', '甘肃卓润汽']);
  assert.equal(cards[0].tap.y, RESULTS_TOP + 60);
  assert.equal(cards[1].tap.y, RESULTS_TOP + 60);
});

// The upper thumbnail may already be hidden under the filter bar. Wait for an actually tappable card.
test('a cropped top card cannot turn a thumbnail tap into a caption or filter tap', () => {
  const rows = fixture(cases[0]).rows.filter(row => row.y >= 1150 && row.y < 1400);
  const shifted = rows.map(row => ({...row, y: row.y - 700}));
  assert.deepEqual(parseResultCards(shifted, {now}), []);
});
