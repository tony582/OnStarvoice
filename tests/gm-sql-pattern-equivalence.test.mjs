import assert from 'node:assert/strict';
import test from 'node:test';
import {GM_VEHICLE_ALIASES, GM_COMPATIBLE_MODEL_SPELLINGS} from '../server/services/gm-vehicle-aliases.js';
import {
  GM_POST_ENTITY_PATTERN, GM_POST_ENTITY_SQL_PATTERNS, GM_CONTEXTUAL_MODEL_PATTERN,
  GM_VEHICLE_CONTEXT_PATTERN, getRecordEvidenceSources, maskNonSaicGmOrganizations,
} from '../server/services/record-content-judgment.js';

// The unfactored expression remains the source-evidence JS reference. These
// cases compare only the boolean language used by SQL, not match order/spans.
const original = new RegExp(GM_POST_ENTITY_PATTERN, 'i');
const groups = GM_POST_ENTITY_SQL_PATTERNS.map(pattern => new RegExp(pattern, 'i'));
const aliases = [...new Set([...GM_VEHICLE_ALIASES, ...GM_COMPATIBLE_MODEL_SPELLINGS].flatMap(entry => entry.aliases))];
const normalized = value => maskNonSaicGmOrganizations(value.normalize('NFKC'));
const groupedMatch = value => groups.some(pattern => pattern.test(value));
function assertSame(value) {
  const text = normalized(value);
  assert.equal(groupedMatch(text), original.test(text), value);
}
const fullWidth = value => [...value].map(char => /[!-~]/u.test(char) ? String.fromCharCode(char.charCodeAt(0) + 0xfee0) : char).join('');

export function generatedGmPatternCases() {
  const samples = new Set();
  const prefixes = ['', '我的', '这辆', '这台', '这款', '车主的', '驾驶', '开着', 'my ', 'drive ', 'my  ', 'x', '9', '人类文明的'];
  const suffixes = ['', '车主', '的哨兵', '的我这台辆款车机', '的我这台辆款新车机', ' cars', 'owner', '的风景', '文化', 'x', '9', '-V Blackwing', '。'];
  for (const alias of aliases) {
    for (const prefix of prefixes) for (const suffix of suffixes) samples.add(`${prefix}${alias}${suffix}`);
    const variants = new Set([alias, alias.toLowerCase(), alias.toUpperCase(), fullWidth(alias), alias.replace(/[ -]/g, '–')]);
    if (/^[a-z]{1,4}[ -]*\d{1,3}(?:[ -]*[a-z])?$/i.test(alias)) {
      const symbols = [...alias.replace(/[ -]/g, '')];
      for (const separator of [' ', '-', '_', '‑', '—']) variants.add(symbols.join(separator));
    }
    for (const variant of variants) for (const wrapper of [value => value, value => `${value}的车主反馈哨兵`, value => `🚗${value}。`, value => `my ${value}`, value => `x${value}9`]) samples.add(wrapper(variant));
  }
  return [...samples];
}

// Independent sentences retained from the previous alias/admission review.
const independentCases = [
  ['昂科威Plus哨兵没有触发', true], ['至境L7哨兵体验', true], ['CT50的哨兵功能演示', true],
  ['CT 5 的哨兵怎么开启', true], ['CT–5驻车异常', true], ['C T 5哨兵', true],
  ['GL8的驻车录像', true], ['我的开拓者哨兵录像没触发', true], ['景程车主咨询驻车监控', true],
  ['L7哨兵模式怎么开', true], ['E5驻车监控异常', true], ['通用旗下车型驻车录像', true],
  ['通用集团新闻', true], ['通用的哨兵功能', true], ['通用的my car', false],
  ['myct50测试录像', false], ['CT500哨兵模式', false], ['GL80测试录像', false], ['EL70测试', false], ['E50资料', false],
  ['哨兵模式的行业开拓者', false], ['追求至境，哨兵技术再升级', false], ['一路景程，沿途风景真好', false],
  ['通用哨兵安装教程', false], ['GMAT课程', false], ['SAIC的新闻', false], ['跨越世纪的工程', false],
  ['encore the song at Park Avenue', false], ['Seeker of wisdom', false], ['GM是游戏管理员', false],
  ['上汽通用五菱的哨兵', false], ['上汽 通用 五菱汽车', false], ['SGMW 的驻车录像', false],
  ['SAIC-GM-Wuling 的驻车录像', false], ['Shanghai General Motors Wuling 的驻车录像', false],
  ['SAIC General Motors Wuling 的驻车录像', false], ['上汽通用五菱与别克的驻车录像对比', true],
  ['ＳＡＩＣ－ＧＭ－Ｗｕｌｉｎｇ的驻车录像', false], ['ＣＴ５的哨兵', true], ['ｂｕｉｃｋ', true],
];

function sourceBoolean(record, match) {
  const sources = getRecordEvidenceSources(record).map(({text}) => normalized(text));
  const context = sources.some(text => new RegExp(GM_VEHICLE_CONTEXT_PATTERN, 'i').test(text));
  return sources.some(text => match(text) || (context && new RegExp(GM_CONTEXTUAL_MODEL_PATTERN, 'i').test(text)));
}

test('factored SQL pattern union preserves every registered alias across owner, vehicle and token boundaries', () => {
  const samples = generatedGmPatternCases();
  assert.ok(aliases.length >= 262);
  assert.ok(samples.length > 45000);
  for (const value of samples) assertSame(value);
});

test('direct and factored contextual patterns preserve special 通用 and exact gap limits', () => {
  for (const alias of ['通用', '世纪', '世家', '至境', '开拓者', '景程', 'LaCrosse', 'Regal', 'Envision', 'Seeker', 'GM', 'SGM']) {
    for (const size of [0, 1, 5, 6, 7, 8]) for (const gap of [' '.repeat(size), '的'.repeat(size), '我'.repeat(size)]) {
      for (const context of ['哨兵', '车主', 'my car', 'car', 'cars', 'driving', 'drive', '风景', '文化', '']) {
        assertSame(`${alias}${gap}${context}`);
        assertSame(`我的${gap}${alias}${context}`);
        assertSame(`drive ${gap}${alias}${context}`);
      }
    }
  }
});

test('factored SQL union retains independent positive and nonvehicle counterexamples', () => {
  for (const [value, expected] of independentCases) {
    assert.equal(original.test(normalized(value)), expected, `reference: ${value}`);
    assert.equal(groupedMatch(normalized(value)), expected, value);
  }
});

test('split SQL booleans preserve cross-source English model context without borrowing comments, hashtags or stale media', () => {
  const current = {video_url: 'https://example.test/current.mp4', transcript_status: 'done', transcript_source_url: 'https://example.test/current.mp4'};
  const records = [
    [{title: 'LaCrosse', content: '哨兵昨晚没有录像'}, true], [{title: 'Regal', content: '远程解锁故障'}, true],
    [{title: '刚买了Regal，哨兵根本没录到'}, true], [{title: 'LaCrosse怎么开启哨兵模式'}, true],
    [{title: 'Monza', transcript: '我的车哨兵打不开', ...current}, true],
    [{title: 'LaCrosse', content: '曲棍球运动', comments_text: '汽车哨兵'}, false],
    [{title: 'Monza', content: '旅行', transcript: '车主反馈哨兵失灵', ...current, transcript_source_url: 'https://example.test/old.mp4'}, false],
    [{title: 'Park Avenue', content: 'cartography map'}, false], [{title: 'Regal', content: '#汽车 #哨兵'}, false],
    [{title: '开拓者', content: '哨兵行业正在发展'}, false], [{title: '＃ＣＴ５ #Chevy #科鲁泽'}, false],
    [{title: '驻车录像', keyword: '别克哨兵', author_name: 'Buick', comments_text: '凯迪拉克'}, false],
  ];
  for (const [record, expected] of records) {
    assert.equal(sourceBoolean(record, text => original.test(text)), expected, JSON.stringify(record));
    assert.equal(sourceBoolean(record, groupedMatch), expected, JSON.stringify(record));
  }
});
