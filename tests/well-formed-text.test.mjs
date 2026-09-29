import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isWellFormed,
  sliceWellFormed,
  splitsSurrogatePair,
  stringifyJsonWellFormed,
  toWellFormed,
  truncateWellFormed,
} from '../server/utils/well-formed-text.js';

const HIGH = '\uD83D';
const LOW = '\uDCB0';
const MONEY_BAG = '💰'; // U+1F4B0 = 💰
const FAMILY = '👨‍👩‍👧'; // three astral people joined by ZWJ
const FLAG = '🇨🇳'; // two regional indicators, four code units

// The failure this module exists for, spelled out so it cannot be argued away.
const hasLoneSurrogateEscape = json => /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i.test(json);

test('测试夹具本身：emoji 由一对 UTF-16 代理项组成，按 code unit 切会留下孤立代理项', () => {
  assert.equal(MONEY_BAG, HIGH + LOW);
  assert.equal(MONEY_BAG.length, 2);
  const cut = `abc${MONEY_BAG}`.slice(0, 4);
  assert.equal(cut, `abc${HIGH}`);
  assert.equal(isWellFormed(cut), false);
  assert.equal(hasLoneSurrogateEscape(JSON.stringify({ quote: cut })), true);
});

test('isWellFormed / toWellFormed：完整的代理项对保留，孤立的高位或低位代理项换成 U+FFFD', () => {
  assert.equal(isWellFormed(''), true);
  assert.equal(isWellFormed('谁看谁心动'), true);
  assert.equal(isWellFormed(`a${MONEY_BAG}b`), true);
  assert.equal(isWellFormed(`a${HIGH}`), false);
  assert.equal(isWellFormed(`${LOW}a`), false);
  assert.equal(isWellFormed(`${LOW}${HIGH}`), false, '顺序反了的一对不是合法代理项对');

  assert.equal(toWellFormed(`a${MONEY_BAG}b`), `a${MONEY_BAG}b`);
  assert.equal(toWellFormed(`a${HIGH}`), 'a\uFFFD');
  assert.equal(toWellFormed(`${LOW}a`), '\uFFFDa');
  assert.equal(toWellFormed(`${HIGH}${HIGH}${LOW}`), `\uFFFD${MONEY_BAG}`);
  assert.equal(toWellFormed(`${HIGH}${LOW}${LOW}`), `${MONEY_BAG}\uFFFD`);
  assert.equal(toWellFormed(`${LOW}${HIGH}`), '\uFFFD\uFFFD');
  assert.equal(toWellFormed(null), '');
  assert.equal(toWellFormed(undefined), '');
  assert.equal(toWellFormed(42), '42');
  // 连续调用不能互相影响（全局正则的 lastIndex）。
  for (let i = 0; i < 3; i += 1) assert.equal(toWellFormed(`a${HIGH}`), 'a\uFFFD');
  for (let i = 0; i < 3; i += 1) assert.equal(isWellFormed(`a${HIGH}`), false);
});

test('splitsSurrogatePair：只有落在一对代理项中间的下标才算切断字符', () => {
  const text = `a${MONEY_BAG}b`; // a=0，emoji=1-2，b=3
  assert.deepEqual([0, 1, 2, 3, 4].map(index => splitsSurrogatePair(text, index)), [false, false, true, false, false]);
  assert.equal(splitsSurrogatePair(text, -1), false);
  assert.equal(splitsSurrogatePair(text, 99), false);
  assert.equal(splitsSurrogatePair('', 0), false);
  assert.equal(splitsSurrogatePair(`${HIGH}${HIGH}`, 1), false, '高位后面跟的不是低位');
  assert.equal(splitsSurrogatePair(`${LOW}${LOW}`, 1), false, '前面不是高位');
});

test('truncateWellFormed：限制正好落在 emoji 中间时整个字符丢弃，其余按 code unit 计', () => {
  const text = `abc${MONEY_BAG}def`; // 长度 8，emoji 占 3、4 两个位置
  assert.equal(truncateWellFormed(text, 3), 'abc');
  assert.equal(truncateWellFormed(text, 4), 'abc', '第 4 个 code unit 是高位代理项，不能单独留下');
  assert.equal(truncateWellFormed(text, 5), `abc${MONEY_BAG}`);
  assert.equal(truncateWellFormed(text, 6), `abc${MONEY_BAG}d`);
  assert.equal(truncateWellFormed(text, 8), text);
  assert.equal(truncateWellFormed(text, 999), text);
  assert.equal(truncateWellFormed(text, Infinity), text);
  for (let limit = 0; limit <= text.length + 1; limit += 1) {
    const cut = truncateWellFormed(text, limit);
    assert.equal(isWellFormed(cut), true, `limit ${limit}`);
    assert.ok(cut.length <= limit, `limit ${limit}`);
    assert.ok(text.startsWith(cut), `limit ${limit}：截断结果必须是原文前缀`);
  }
});

test('truncateWellFormed：边界输入', () => {
  assert.equal(truncateWellFormed(MONEY_BAG, 1), '', '只有一个 emoji、限制 1：宁可为空');
  assert.equal(truncateWellFormed(MONEY_BAG, 2), MONEY_BAG);
  assert.equal(truncateWellFormed('abc', 0), '');
  assert.equal(truncateWellFormed('abc', -3), '');
  assert.equal(truncateWellFormed('abcdef', -1), '', '负的限制不是「去掉最后几个」，而是没有配额');
  assert.equal(truncateWellFormed('abc', NaN), '');
  assert.equal(truncateWellFormed('abc', undefined), '');
  assert.equal(truncateWellFormed('abc', '2'), 'ab');
  assert.equal(truncateWellFormed('abc', 2.9), 'ab');
  assert.equal(truncateWellFormed(null, 5), '');
  assert.equal(truncateWellFormed(undefined, 5), '');
  assert.equal(truncateWellFormed(12345, 3), '123');
  assert.equal(truncateWellFormed('', 5), '');
});

test('truncateWellFormed：ZWJ 序列、国旗、键帽只保证不留半个代理项，不拆分字素簇', () => {
  // 目标是「文本合法」，不是「字素完整」：字素簇被截开是无害的，孤立代理项才会让 jsonb 写入失败。
  for (const cluster of [FAMILY, FLAG, '1️⃣', '👍🏽']) {
    const text = `x${cluster}y`;
    for (let limit = 0; limit <= text.length; limit += 1) {
      const cut = truncateWellFormed(text, limit);
      assert.equal(isWellFormed(cut), true, `${JSON.stringify(cluster)} limit ${limit}`);
      assert.ok(text.startsWith(cut));
    }
  }
});

test('truncateWellFormed：输入里原有的孤立代理项换成 U+FFFD，而不是原样带进 JSON', () => {
  assert.equal(truncateWellFormed(`ab${HIGH}cd`, 10), 'ab\uFFFDcd');
  assert.equal(truncateWellFormed(`ab${LOW}cd`, 3), 'ab\uFFFD');
  assert.equal(isWellFormed(truncateWellFormed(`${LOW}${HIGH}${LOW}${HIGH}`, 3)), true);
});

test('sliceWellFormed：窗口两端都落在 emoji 中间时各自丢弃半个字符，结果仍是原文的子串', () => {
  const text = `${MONEY_BAG}abc${MONEY_BAG}`; // 0-1 emoji，2-4 abc，5-6 emoji
  assert.equal(sliceWellFormed(text, 1, 6), 'abc', '起点在低位代理项上、终点在高位代理项后');
  assert.equal(sliceWellFormed(text, 0, 6), `${MONEY_BAG}abc`);
  assert.equal(sliceWellFormed(text, 2, 5), 'abc');
  assert.equal(sliceWellFormed(text, 2, 6), 'abc');
  assert.equal(sliceWellFormed(text, 1), `abc${MONEY_BAG}`);
  assert.equal(sliceWellFormed(text), text);
  assert.equal(sliceWellFormed(text, 6), '', '起点落在末尾 emoji 中间：整个字符丢弃');
  for (let from = 0; from <= text.length; from += 1) {
    for (let to = from; to <= text.length; to += 1) {
      const cut = sliceWellFormed(text, from, to);
      assert.equal(isWellFormed(cut), true, `[${from}, ${to})`);
      assert.ok(text.includes(cut), `[${from}, ${to})：必须是原文的子串`);
    }
  }
});

test('sliceWellFormed：与 String#slice 一致的下标语义（负数、越界、非数字）', () => {
  const text = `abc${MONEY_BAG}def`;
  assert.equal(sliceWellFormed(text, -3), 'def');
  assert.equal(sliceWellFormed(text, 0, -3), `abc${MONEY_BAG}`);
  assert.equal(sliceWellFormed(text, 0, -4), 'abc', '负数终点落在 emoji 中间');
  assert.equal(sliceWellFormed(text, -100, 100), text);
  assert.equal(sliceWellFormed(text, 5, 2), '');
  assert.equal(sliceWellFormed(text, NaN, NaN), '');
  assert.equal(sliceWellFormed(text, undefined, 3), 'abc');
  assert.equal(sliceWellFormed(null), '');
});

test('stringifyJsonWellFormed：值和键里的孤立代理项都不会变成 \\udXXX 转义', () => {
  const dirty = {
    quote: `谁看谁心动${HIGH}`,
    [`key${LOW}`]: 'v',
    nested: [{ reason: `${LOW}x` }, `ok${MONEY_BAG}`],
    number: 1,
    nothing: null,
    skipped: undefined,
  };
  assert.equal(hasLoneSurrogateEscape(JSON.stringify(dirty)), true, '对照：原生 JSON.stringify 会写出孤立转义');

  const json = stringifyJsonWellFormed(dirty);
  assert.equal(hasLoneSurrogateEscape(json), false);
  assert.deepEqual(JSON.parse(json), {
    quote: '谁看谁心动\uFFFD',
    'key\uFFFD': 'v',
    nested: [{ reason: '\uFFFDx' }, `ok${MONEY_BAG}`],
    number: 1,
    nothing: null,
  });
});

test('stringifyJsonWellFormed：合法输入与 JSON.stringify 逐字节一致', () => {
  const clean = {
    a: `x${MONEY_BAG}y${FAMILY}`,
    b: [1, 'two', null, { c: FLAG }],
    when: new Date('2026-09-29T00:00:00Z'),
    'quote"d': 'back\\slash \n newline',
  };
  assert.equal(stringifyJsonWellFormed(clean), JSON.stringify(clean));
  assert.equal(stringifyJsonWellFormed(clean, 2), JSON.stringify(clean, null, 2));
  assert.equal(stringifyJsonWellFormed('plain'), '"plain"');
  assert.equal(stringifyJsonWellFormed(null), 'null');
  assert.equal(stringifyJsonWellFormed(undefined), undefined);
  // 字面上的反斜杠加 ud83d 不是代理项，不能被误改。
  assert.equal(stringifyJsonWellFormed({ text: '\\ud83d' }), JSON.stringify({ text: '\\ud83d' }));
});

test('stringifyJsonWellFormed：toJSON 与循环引用的行为不变', () => {
  assert.equal(stringifyJsonWellFormed({ id: { toJSON: () => `id${HIGH}` } }), '{"id":"id\uFFFD"}');
  const loop = {};
  loop.self = loop;
  assert.throws(() => stringifyJsonWellFormed(loop), TypeError);
});

test('stringifyJsonWellFormed：干净的文档走原生 JSON.stringify，深层嵌套不会比原来更早溢出', () => {
  // 带 replacer 的序列化在 Node 18 上约 2,200 层数组就会栈溢出，原生约 5,200 层。
  const deep = JSON.parse(`${'['.repeat(3000)}${']'.repeat(3000)}`);
  assert.equal(stringifyJsonWellFormed(deep), JSON.stringify(deep));
  // 有孤立代理项时才走 replacer，结果仍然干净。
  assert.deepEqual(JSON.parse(stringifyJsonWellFormed({ a: [`x${HIGH}`], deep: [[[[1]]]] })), { a: ['x\uFFFD'], deep: [[[[1]]]] });
  // 文本里字面写着 \\ud83d 的普通字符串会触发慢路径，但结果与原生一致。
  const literal = { text: '\\ud83d and \\udcb0' };
  assert.equal(stringifyJsonWellFormed(literal), JSON.stringify(literal));
  // 环形结构在原生路径就抛 TypeError，和 JSON.stringify 一致。
  const loop = { [`k${HIGH}`]: 1 };
  loop.self = loop;
  assert.throws(() => stringifyJsonWellFormed(loop), TypeError);
});
