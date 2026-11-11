import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCandidatePairs, groupCrossPosts, matchPair, normalizeAuthor, normalizeContent} from '../server/services/cross-posts/matching.js';

const at = '2026-11-10T08:42:00.000Z';
const record = (id, overrides = {}) => ({id, tenant_id: 'tenant-a', platform: 'douyin', record_type: 'single_note',
  author_name: '凯迪电车之家', title: '', content: '我发现贺兰山这个壁纸，充电的时候山刚好会显示在屏幕中间！效果真的绝了',
  published_ts: at, created_at: at, ...overrides});
const pair = (a = {}, b = {}) => [record('a', a), record('b', {platform: 'wechat_channels', ...b})];
const matched = (a, b) => matchPair(...pair(a, b));
const ids = groups => groups.map(group => group.records.map(row => row.id));

test('author normalization strips punctuation, whitespace, emoji and empty/fake names', () => {
  assert.equal(normalizeAuthor(' ＣＴ５ · 凯迪 电车之家📔 '), 'ct5凯迪电车之家');
  for (const name of ['。', '🐳', '👨‍👩‍👦', '🇨🇳', '1️⃣', '✨ · ']) {
    assert.equal(normalizeAuthor(name), '');
    assert.equal(matched({author_name: name}, {author_name: name}), null);
  }
  assert.equal(matched({author_name: '车'}, {author_name: '车'}), null);
  assert.ok(matched({author_name: '电车'}, {author_name: '电车'}));
});

test('content normalization uses title plus the first 500 body characters and removes promotion tokens', () => {
  assert.equal(normalizeContent(' 标题 #安吉星 #凯迪拉克# @小明 https://example.com/x 🐳 正 文 '), '标题正文');
  assert.equal(normalizeContent({title: '标题', content: '正文'}), '标题正文');
  assert.equal(normalizeContent({title: '', content: '甲'.repeat(500) + '乙'}), '甲'.repeat(500));
  assert.equal(normalizeContent({title: '超出不算正文', content: '𠮷'.repeat(500) + '乙'}), '超出不算正文' + '𠮷'.repeat(500));
  assert.equal(normalizeContent({title: 'ABC', content: ' ＣＴ５ ！'}), 'abcct5!');
});

test('real positive: 凯迪电车之家 posts two minutes apart on Douyin and Channels form one group', () => {
  const posts = pair({}, {published_ts: '2026-11-10T08:44:00.000Z'});
  const groups = groupCrossPosts(posts);
  assert.deepEqual(ids(groups), [['a', 'b']]);
  assert.equal(groups[0].tenantId, 'tenant-a');
  assert.equal(groups[0].groupId, 'a');
  const evidence = groups[0].matches[0].evidence;
  assert.equal(evidence.authorRule, 'exact');
  assert.equal(evidence.authorDice, 1);
  assert.equal(evidence.contentDice, 1);
  assert.deepEqual(evidence.contentRules, ['dice', 'substring', 'contains']);
  assert.equal(evidence.hoursApart, 2 / 60);
  assert.deepEqual(evidence.timeSources, ['published', 'published']);
});

test('real negative: 00后女大卖车日记 uses the same author for different content', () => {
  assert.equal(matched({author_name: '00后女大卖车日记📔', platform: 'xiaohongshu', content: '00后女车贩子整治市场！'},
    {author_name: '00后女大卖车日记📔', platform: 'douyin', content: '好兄弟今天一起去看昂科旗，实拍六座豪华内饰和底盘配置'}), null);
});

test('rule 1: only different platforms, identical nonempty tenant, distinct IDs and main posts', () => {
  assert.equal(matched({}, {tenant_id: 'tenant-b'}), null);
  assert.equal(matched({tenant_id: ''}, {tenant_id: ''}), null);
  assert.equal(matched({}, {platform: 'douyin'}), null);
  assert.equal(matched({}, {id: 'a'}), null);
  for (const platform of ['unknown', 'wechat_articles', 'weibo', '', 'custom']) {
    assert.equal(matched({}, {platform}), null);
    assert.deepEqual(groupCrossPosts(pair({}, {platform})), []);
  }
  for (const record_type of ['comment', 'comments', 'record_comment', 'comment_detail', 'official_content', 'blogger_profile']) {
    assert.equal(matched({record_type}), null, record_type);
    assert.equal(matched({}, {record_type}), null, record_type);
  }
  assert.ok(matched({record_type: 'keyword_notes'}));
});

test('rule 2: 72 hours inclusive, missing/invalid publish time falls back to created_at, undated posts fail', () => {
  const offset = delta => new Date(Date.parse(at) + delta).toISOString();
  assert.equal(matched({}, {published_ts: offset(72 * 3_600_000)}).evidence.hoursApart, 72);
  assert.equal(matched({}, {published_ts: offset(72 * 3_600_000 + 1)}), null);
  assert.ok(matched({}, {published_ts: offset(-72 * 3_600_000)}));
  const fallback = matched({published_ts: null}, {published_ts: 'not a date'});
  assert.deepEqual(fallback.evidence.timeSources, ['created_at', 'created_at']);
  assert.equal(matched({published_ts: null, created_at: null}), null);
  assert.ok(matched({author_name: undefined, author: '凯迪电车之家', published_ts: undefined, published_at: at}));
});

test('rule 3: author exact, length-qualified containment and Dice have independent acceptance gates', () => {
  assert.equal(matched({author_name: 'AB'}, {author_name: 'ab'}).evidence.authorRule, 'exact');
  assert.equal(matched({author_name: '电车家'}, {author_name: '凯迪电车家官方'}).evidence.authorRule, 'contains');
  const dice = matched({author_name: '汽车电车维修中心'}, {author_name: '汽车电车维修中芯'});
  assert.equal(dice.evidence.authorRule, 'dice');
  assert.ok(dice.evidence.authorDice >= 0.8 && dice.evidence.authorDice < 1);
  assert.equal(matched({author_name: '电车'}, {author_name: '凯迪电车之家'}), null);
  assert.equal(matched({author_name: '凯迪电车之家'}, {author_name: '别克汽车专修'}), null);
});

test('rule 4: short text fails even if equal, and content Dice can pass without either other rule', () => {
  assert.equal(matched({content: '七个汉字不够长'}, {content: '七个汉字不够长'}), null);
  const result = matched({content: 'abcdefghij'}, {content: 'abcdefxhij'});
  assert.deepEqual(result.evidence.contentRules, ['dice']);
  assert.ok(result.evidence.contentDice >= 0.6);
  assert.ok(result.evidence.longestCommonSubstring < 15);
});

test('rule 4: complete containment requires 12 characters and does not require high Dice', () => {
  const result = matched({content: 'abcdefghijkl'}, {content: '甲'.repeat(50) + 'abcdefghijkl' + '乙'.repeat(50)});
  assert.deepEqual(result.evidence.contentRules, ['contains']);
  assert.equal(result.evidence.longestCommonSubstring, 12);
  assert.ok(result.score < 0.6);
  assert.equal(matched({content: 'abcdefghijk'}, {content: '甲'.repeat(50) + 'abcdefghijk' + '乙'.repeat(50)}), null);
});

test('rule 4: longest common substring (not subsequence) requires 15 characters', () => {
  const common = 'abcdefghijklmno';
  const result = matched({content: '甲'.repeat(20) + common}, {content: common + '乙'.repeat(20)});
  assert.deepEqual(result.evidence.contentRules, ['substring']);
  assert.equal(result.evidence.longestCommonSubstring, 15);
  assert.equal(matched({content: '甲'.repeat(40) + common.slice(1)}, {content: common.slice(1) + '乙'.repeat(40)}), null);
  assert.equal(matched({content: '甲'.repeat(40) + common}, {content: charsSpaced(common) + '乙'.repeat(40)}), null);
});
function charsSpaced(value) { return Array.from(value).join('隔'); }

test('candidate index covers author containment and Dice, drops unrelated, out-of-window and same-platform pairs', () => {
  const posts = [record('a', {author_name: 'abc'}), record('b', {platform: 'xiaohongshu', author_name: 'prefixabcsuffix'}),
    record('c', {platform: 'wechat_channels', author_name: '汽车电车维修中心'}),
    record('d', {platform: 'douyin', author_name: '汽车电车维修中芯'}),
    record('e', {platform: 'xiaohongshu', author_name: '完全无关昵称'}),
    record('f', {platform: 'xiaohongshu', author_name: 'abc', published_ts: '2025-01-01T00:00:00Z'}),
    record('g', {platform: 'douyin', author_name: 'abc'})];
  assert.deepEqual(buildCandidatePairs(posts).map(pair => pair.map(row => row.id)), [['a', 'b'], ['c', 'd'], ['b', 'g']]);
  assert.deepEqual(buildCandidatePairs(pair({}, {tenant_id: 'other'})), []);
});

test('transitive A-B-C links form one group even when A and C have distinct content', () => {
  const first = 'abcdefghijklmnop', last = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳';
  const posts = [record('a', {content: first}), record('b', {platform: 'xiaohongshu', content: first + last}),
    record('c', {platform: 'wechat_channels', content: last})];
  assert.equal(matchPair(posts[0], posts[2]), null);
  assert.deepEqual(ids(groupCrossPosts(posts)), [['a', 'b', 'c']]);
  assert.equal(groupCrossPosts(posts)[0].matches.length, 2);
});

test('exclusions constrain whole union, so an excluded pair cannot reconnect through another platform', () => {
  const posts = [record('a'), record('b', {platform: 'xiaohongshu'}), record('c', {platform: 'wechat_channels'})];
  const exclusions = [{tenant_id: 'tenant-a', record_a: 'c', record_b: 'a'}];
  const groups = groupCrossPosts(posts, {exclusions});
  assert.deepEqual(ids(groups), [['a', 'b']]);
  assert.deepEqual(groupCrossPosts([...posts].reverse(), {exclusions}), groups);
  assert.deepEqual(ids(groupCrossPosts(posts, {exclusions: [{...exclusions[0], tenant_id: 'other'}]})), [['a', 'b', 'c']]);
  assert.deepEqual(groupCrossPosts(pair(), {exclusions: [{tenant_id: 'tenant-a', record_a: 'a', record_b: 'b'}]}), []);
});

test('group cap is six, deterministic under input permutation; group ID uses earliest created_at then ID', () => {
  const platforms = ['douyin', 'xiaohongshu', 'wechat_channels'];
  const posts = Array.from({length: 8}, (_, i) => record(String(i), {platform: platforms[i % 3]}));
  const groups = groupCrossPosts(posts);
  assert.deepEqual(ids(groups), [['0', '1', '2', '3', '4', '5'], ['6', '7']]);
  assert.deepEqual(groupCrossPosts([...posts].reverse()), groups);
  assert.deepEqual(ids(groupCrossPosts(posts, {maxGroupSize: 3})), [['0', '1', '2'], ['3', '4', '5'], ['6', '7']]);
  assert.throws(() => groupCrossPosts(posts, {maxGroupSize: 7}), RangeError);
  const later = record('a', {created_at: '2026-11-10T09:00:00Z', published_ts: '2026-11-09T08:42:00Z'});
  assert.equal(groupCrossPosts([later, record('z', {platform: 'wechat_channels'})])[0].groupId, 'z');
});

test('groups never span tenants even with colliding record IDs, and duplicate input does not enlarge groups', () => {
  const posts = [...pair(), ...pair({tenant_id: 'tenant-b'}, {tenant_id: 'tenant-b'})];
  const groups = groupCrossPosts(posts.concat(posts[0]));
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.tenantId), ['tenant-a', 'tenant-b']);
  assert.deepEqual(ids(groups), [['a', 'b'], ['a', 'b']]);
});

test('indexed candidates cover the exact-rule oracle, including containment that has low author Dice', () => {
  const names = ['汽车电车维修中心', '汽车电车维修中芯', '电车维修', 'AB', 'abc', 'prefixabcsuffix', '🐳', '。', '全新名称'];
  const platforms = ['douyin', 'xiaohongshu', 'wechat_channels'];
  const posts = Array.from({length: 36}, (_, i) => record(String(i), {author_name: names[i % names.length],
    tenant_id: i < 18 ? 'tenant-a' : 'tenant-b', platform: platforms[Math.floor(i / 3) % 3]}));
  const key = pair => pair.map(row => row.id).sort().join(',');
  const expected = [];
  for (let i = 0; i < posts.length; i++) for (let j = i + 1; j < posts.length; j++) {
    if (matchPair(posts[i], posts[j])) expected.push(key([posts[i], posts[j]]));
  }
  assert.deepEqual(buildCandidatePairs(posts).map(key).sort(), expected.sort());
});

test('substring evidence agrees with a simple independent oracle on repeated and Unicode text', () => {
  function longest(a, b) {
    const points = Array.from(a); let best = 0;
    for (let start = 0; start < points.length; start++) for (let end = start + best + 1; end <= points.length; end++) {
      if (b.includes(points.slice(start, end).join(''))) best = end - start;
    }
    return best;
  }
  const alphabet = ['甲', '乙', '𠮷', '丁']; let state = 912_341;
  function sample() { return Array.from({length: 50}, () => { state = (state * 16_807) % 2_147_483_647; return alphabet[state % 4]; }).join(''); }
  let checked = 0;
  for (let i = 0; i < 40; i++) {
    const a = sample(), b = sample(), result = matched({content: a}, {content: b});
    if (result) { assert.equal(result.evidence.longestCommonSubstring, longest(a, b)); checked++; }
  }
  assert.ok(checked >= 20);
});


test('content admission requires eight real letters or digits; punctuation left after hashtags is insufficient', () => {
  for (const content of ['#安吉星#！！！！！！！！', '@小明 ！！！！！！！！', '七个汉字不够长！！！！！！！！']) {
    assert.equal(matched({content}, {content}), null);
    assert.deepEqual(groupCrossPosts(pair({content}, {content})), []);
  }
  assert.ok(matched({content: '刚好八个汉字通过！'}, {content: '刚好八个汉字通过！'}));
  assert.ok(matched({content: 'AB12CD34！！！'}, {content: 'AB12CD34！！！'}));
  assert.equal(normalizeContent('ABC12345！！！'), 'abc12345!!!', 'punctuation remains in comparison text');
});


test('containment needs 12 meaningful characters; punctuation does not pad its length threshold', () => {
  const short = 'abcdefgh!!!!';
  assert.equal(matched({content: short}, {content: '甲'.repeat(50) + short + '乙'.repeat(50)}), null);
  const valid = 'abcdef!ghijkl!!';
  const result = matched({content: valid}, {content: '甲'.repeat(50) + valid + '乙'.repeat(50)});
  assert.deepEqual(result.evidence.contentRules, ['contains']);
  assert.equal(result.evidence.shorterContentLength, 15);
  assert.equal(result.evidence.shorterMeaningfulContentLength, 12);
});

test('a common substring needs 15 meaningful characters while preserving original punctuation continuity', () => {
  for (const common of ['!'.repeat(15), 'abcdefghijklmn!']) {
    assert.equal(matched({content: '甲'.repeat(50) + common}, {content: common + '乙'.repeat(50)}), null);
  }
  const common = 'abcde!fghij!klmno';
  const result = matched({content: '甲'.repeat(20) + common}, {content: common + '乙'.repeat(20)});
  assert.deepEqual(result.evidence.contentRules, ['substring']);
  assert.equal(result.evidence.longestCommonSubstring, 17);
  assert.equal(result.evidence.longestCommonSubstringMeaningful, 15);
  assert.equal(matched({content: '甲'.repeat(50) + common}, {content: 'abcde?fghij?klmno' + '乙'.repeat(50)}), null,
    'different punctuation still breaks the continuous substring; it is not removed for this rule');
});


// Constructed equivalents of the reviewed dry-run samples; no production text is copied into the repository.
test('reviewed sample 3: a 20-character signature cannot connect the unrelated post to the other two', () => {
  const signature = 'abcdefghijklmnopqrst';
  const posts = [record('unrelated', {author_name: 'ROUTERS路透', content: '甲'.repeat(134) + signature}),
    record('same-a', {author_name: 'ROUTERS路透', platform: 'wechat_channels', content: '乙'.repeat(134) + signature}),
    record('same-b', {author_name: 'ROUTERS路透', platform: 'xiaohongshu', content: '乙'.repeat(134) + signature + '丙'})];
  // Old fragment-only rule matched all three: 20 common effective characters, Dice 19/153 ~= .124.
  assert.equal(matchPair(posts[0], posts[1]), null);
  assert.equal(matchPair(posts[0], posts[2]), null);
  assert.ok(matchPair(posts[1], posts[2]));
  assert.deepEqual(ids(groupCrossPosts(posts)), [['same-a', 'same-b']]);
  assert.deepEqual(groupCrossPosts([...posts].reverse()), groupCrossPosts(posts));
});

test('reviewed samples 7, 16 and 19 retain their long common text or complete short-post containment', () => {
  for (const [commonLength, prefixLength] of [[421, 287], [93, 63]]) {
    const common = '公'.repeat(commonLength);
    const result = matched({title: '甲'.repeat(prefixLength), content: common}, {title: '乙'.repeat(prefixLength), content: common});
    assert.ok(result);
    assert.deepEqual(result.evidence.contentRules, ['substring']);
    assert.equal(result.evidence.longestCommonSubstringMeaningful, commonLength);
    assert.ok(result.score > 0.593 && result.score < 0.595, 'overall Dice remains approximately .594');
    assert.ok(result.evidence.commonSubstringCoverage > 0.4);
  }
  const short = 'abcdefghijklmnopq';
  const result = matched({content: short}, {content: '甲'.repeat(480) + short});
  assert.ok(result.score < 0.3);
  assert.deepEqual(result.evidence.contentRules, ['substring', 'contains']);
  assert.equal(result.evidence.commonSubstringCoverage, 1);
});

test('fragment coverage is inclusive at 40 percent of meaningful characters and fails immediately below', () => {
  const common = 'abcdefghijklmnopqrst';
  const accepted = matched({content: '甲'.repeat(30) + common}, {content: '乙'.repeat(180) + common});
  assert.ok(accepted.score < 0.3);
  assert.equal(accepted.evidence.commonSubstringCoverage, 0.4);
  assert.equal(matched({content: '甲'.repeat(31) + common}, {content: '乙'.repeat(180) + common}), null);
  const punctuated = matched({content: '!'.repeat(10) + '甲'.repeat(30) + common}, {content: '乙'.repeat(180) + common});
  assert.equal(punctuated.evidence.commonSubstringCoverage, 0.4, 'punctuation does not pad the effective denominator');
});

test('Dice fallback is inclusive at .3 when fragment coverage is below 40 percent', () => {
  const common = 'abcdefghijklmnop';
  const accepted = matched({content: '甲'.repeat(35) + common}, {content: '乙'.repeat(35) + common});
  assert.equal(accepted.score, 0.3);
  assert.ok(accepted.evidence.commonSubstringCoverage < 0.4);
  assert.equal(accepted.evidence.longestCommonSubstringMeaningful, 16);
  assert.equal(matched({content: '甲'.repeat(36) + common}, {content: '乙'.repeat(35) + common}), null);
});
