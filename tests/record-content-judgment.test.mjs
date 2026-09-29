import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POST_INTENTS,
  currentPostMediaUrl,
  findMainPostGmEvidence,
  getRecordEvidenceSources,
  isSentryEvidenceScope,
  normalizeJudgmentConfidence,
  normalizeMonitoringEvidence,
  normalizePostIntent,
} from '../server/services/record-content-judgment.js';
import {
  applyManualRelevanceOverride,
  buildUserMessage,
  normalizeRecordClassificationResult,
} from '../server/services/ai-labeler.js';
import { isWellFormed } from '../server/utils/well-formed-text.js';

const CURRENT_VIDEO = 'https://sns-video.example.test/current.mp4';
const PREVIOUS_VIDEO = 'https://sns-video.example.test/previous.mp4';
const mediaRecord = (patch = {}) => ({
  title: '哨兵录像在哪里查看',
  content: '想查看昨晚的录像。',
  video_url: CURRENT_VIDEO,
  transcript_status: 'done',
  transcript_source_url: CURRENT_VIDEO,
  transcript: '我的昂科威Plus升级以后找不到哨兵录像了。',
  ...patch,
});

test('发帖意图包含广告软文五类，并兼容历史 suggestion', () => {
  assert.deepEqual(POST_INTENTS, ['share', 'advertising', 'other', 'complaint', 'inquiry']);
  for (const intent of POST_INTENTS) {
    assert.equal(normalizePostIntent(` ${intent.toUpperCase()} `), intent);
    assert.equal(normalizeRecordClassificationResult({ relevance: 'relevant', intent }).intent, intent);
  }
  assert.equal(normalizePostIntent('suggestion'), 'other');
  assert.equal(normalizeRecordClassificationResult({ intent: 'suggestion' }).intent, 'other');
  for (const value of [null, undefined, '', 'unknown', '咨询']) assert.equal(normalizePostIntent(value), '');
});

test('发帖目的独立于相关性和情感，未分类意图不冒充其他', () => {
  const irrelevantInquiry = normalizeRecordClassificationResult({
    relevance: 'irrelevant', sentiment: 'negative', intent: 'inquiry',
  });
  assert.equal(irrelevantInquiry.intent, 'inquiry');
  assert.equal(irrelevantInquiry.sentiment, '');
  assert.equal(irrelevantInquiry.sentimentStatus, 'not_applicable');
  assert.equal(normalizeRecordClassificationResult({}).intent, '');
});

test('广告意图保留独立的情感、相关性和判断理由，历史其他不自动改为广告', () => {
  for (const relevance of ['relevant', 'uncertain', 'irrelevant']) {
    for (const sentiment of ['positive', 'neutral', 'negative']) {
      const result = normalizeRecordClassificationResult({
        relevance, sentiment, intent: ' ADVERTISING ', intentReason: '  以体验分享形式推广安装服务  ',
      });
      assert.equal(result.intent, 'advertising');
      assert.equal(result.intentReason, '以体验分享形式推广安装服务');
      assert.equal(result.relevance, relevance);
      assert.equal(result.sentiment, relevance === 'irrelevant' ? '' : sentiment);
      assert.equal(result.sentimentStatus, relevance === 'irrelevant' ? 'not_applicable' : 'classified');
    }
  }
  for (const intent of ['other', 'suggestion']) {
    assert.equal(normalizeRecordClassificationResult({ intent }).intent, 'other');
  }
});

test('缺失、错误的相关性结论均保守待核实', () => {
  for (const relevance of [undefined, null, '', 'unknown', 'likely', false]) {
    assert.equal(normalizeRecordClassificationResult({ relevance }).relevance, 'uncertain');
  }
  assert.equal(normalizeRecordClassificationResult({ relevance: ' RELEVANT ' }).relevance, 'relevant');
});

test('合法分类置信度保留端点和小数，未知相关性置信度不借用情感 confidence', () => {
  for (const value of [0, 0.8, 1, '0', '0.8', ' 1 ']) {
    assert.equal(normalizeJudgmentConfidence(value), Number(value));
  }
  assert.equal(normalizeRecordClassificationResult({ confidence: 0.98 }).relevanceConfidence, null);
  assert.equal(normalizeRecordClassificationResult({ relevance_confidence: 0 }).relevanceConfidence, 0);
});

test('无效或缺失置信度不会被转换成零分', async t => {
  const cases = [null, undefined, '', '   ', true, false, [], [0.8], {}, 'invalid', NaN, Infinity, -0.1, 1.1];
  for (let i = 0; i < cases.length; i += 1) {
    await t.test(`invalid value ${i}`, () => {
      assert.equal(normalizeJudgmentConfidence(cases[i]), null);
      assert.equal(normalizeRecordClassificationResult({ relevanceConfidence: cases[i] }).relevanceConfidence, null);
    });
  }
});

test('哨兵门槛仅由已知任务词及历史观察决定，兼容复合采集词', () => {
  for (const keyword of ['别克哨兵', '至境哨兵', '凯迪拉克哨兵', '雪佛兰哨兵', '通用哨兵', '上汽通用哨兵', '至境哨兵别克壁纸', ' 别克\n哨兵 ']) {
    assert.equal(isSentryEvidenceScope({ keyword }), true, keyword);
  }
  assert.equal(isSentryEvidenceScope({ keyword: '别克壁纸', observed_keywords: ['其他', '至境哨兵'] }), true);
  assert.equal(isSentryEvidenceScope({ keyword: '别克壁纸', title: '别克哨兵', content: '至境哨兵' }), false);
  for (const keyword of ['哨兵模式', '特斯拉哨兵', '别克车机', '']) {
    assert.equal(isSentryEvidenceScope({ keyword }), false, keyword);
  }
});

test('关键词、作者、评论、单独标签和旧 OCR 不能成为主帖实体证据', () => {
  const record = {
    keyword: '别克哨兵', observed_keywords: ['至境哨兵'],
    title: '哨兵为什么没录像', content: '昨晚被开门杀。 #别克[话题]# #至境L7 ＃凯迪拉克',
    author_name: '别克官方车友会', tags: ['上汽通用', '昂科威'],
    comments_text: '评论里说这是凯迪拉克CT5',
    image_ocr: '别克至境L7', ocrText: '别克至境L7',
  };
  assert.deepEqual(findMainPostGmEvidence(record), []);
  const normalized = normalizeMonitoringEvidence({ relevance: 'relevant' }, record);
  assert.equal(normalized.status, 'needs_review');
  assert.deepEqual(normalized.evidence, []);
});

test('主帖车型名称、简称与CT50原写法可作线索，不匹配单词内部片段', () => {
  for (const title of ['昂科威Plus哨兵没有触发', '至境L7哨兵体验', '至境智驾不可用后恢复', 'CT5 的哨兵怎么开启', 'GL8的驻车录像', '我的开拓者哨兵录像没触发', '至境的哨兵怎么用', '景程车主咨询驻车监控', 'L7哨兵模式怎么开', 'E5驻车监控异常', 'CT50的哨兵功能演示']) {
    assert.ok(findMainPostGmEvidence({ title }).length > 0, title);
  }
  for (const title of ['通用哨兵安装教程', 'myct50测试录像', 'CT500哨兵模式', 'GL80测试录像', 'EL70测试', 'E50资料', '哨兵模式的行业开拓者', '追求至境，哨兵技术再升级', '一路景程，沿途风景真好']) {
    assert.deepEqual(findMainPostGmEvidence({ title }), [], title);
  }
});

test('相关主体必须与整体相关结论同时成立，车型出现不反转明确无关或待核实', () => {
  const record = { title: '昂科威Plus车漆问题' };
  assert.equal(normalizeMonitoringEvidence({ relevance: 'relevant' }, record).status, 'confirmed');
  for (const relevance of ['uncertain', 'irrelevant']) {
    assert.equal(normalizeMonitoringEvidence({ relevance }, record).status, 'needs_review');
  }
  assert.equal(normalizeMonitoringEvidence({
    relevance: 'relevant', monitoringEvidence: { status: 'needs_review', evidence: [] },
  }, record).status, 'confirmed');
  assert.equal(normalizeMonitoringEvidence({ relevance: 'irrelevant' }, { title: '理想L7没有录像' }).status, 'needs_review');
});

test('只采信当前媒体已完成的逐字稿，过期或未完成文本不作证据', () => {
  const current = mediaRecord();
  assert.ok(findMainPostGmEvidence(current).some(item => item.source === 'transcript'));
  assert.match(buildUserMessage(current), /当前媒体已完成的逐字稿：我的昂科威Plus/);
  for (const patch of [
    { transcript_source_url: PREVIOUS_VIDEO },
    { transcript_status: 'processing' },
    { transcript_status: 'failed' },
    { video_url: '', transcript_source_url: CURRENT_VIDEO },
    { transcript_source_url: '' },
  ]) {
    const record = mediaRecord(patch);
    assert.ok(!getRecordEvidenceSources(record).some(item => item.source === 'transcript'));
    assert.deepEqual(findMainPostGmEvidence(record), []);
    assert.doesNotMatch(buildUserMessage(record), /我的昂科威Plus/);
  }
});

test('当前视频优先于历史 payload 和音频，支持采集 payload 中的媒体对象', () => {
  const record = mediaRecord({
    payload: { videoUrl: PREVIOUS_VIDEO }, audio_url: PREVIOUS_VIDEO,
    transcript_source_url: PREVIOUS_VIDEO,
  });
  assert.equal(currentPostMediaUrl(record), CURRENT_VIDEO);
  assert.deepEqual(findMainPostGmEvidence(record), []);
  const fromPayload = mediaRecord({ video_url: '', payload: JSON.stringify({ videoUrls: [{ downloadUrl: CURRENT_VIDEO }] }) });
  assert.equal(currentPostMediaUrl(fromPayload), CURRENT_VIDEO);
  assert.ok(findMainPostGmEvidence(fromPayload).some(item => item.source === 'transcript'));
});

test('已核验 quote 使用真实原文实体，不信任模型自报的 entity', () => {
  const record = { title: '昂科威Plus哨兵没触发', content: '昨晚记录失败。' };
  const result = normalizeMonitoringEvidence({
    relevance: 'relevant', monitoringEvidence: {
      status: 'confirmed', evidence: [{ source: 'title', quote: record.title, entity: '特斯拉' }],
    },
  }, record);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.evidence[0].entity, '昂科威Plus');
});

test('错误模型引用不否决原帖：重新抽取实际来源，不沿用伪造引用', () => {
  const record = { title: '昂科威Plus哨兵没触发', content: '没有录到昨晚的开门杀。' };
  for (const evidence of [
    [{ source: 'title', quote: '别克至境L7失灵' }],
    [{ source: 'content', quote: record.title }],
    [{ source: 'keyword', quote: '别克哨兵' }],
    [{ source: 'author_name', quote: '别克官方' }],
    [{ source: 'image_ocr', quote: '别克至境L7' }],
    [{ source: 'transcript', quote: '昂科威Plus' }],
    [{ source: 'content', quote: record.content }],
  ]) {
    const result = normalizeMonitoringEvidence({ relevance: 'relevant', monitoringEvidence: { status: 'confirmed', evidence } }, record);
    assert.equal(result.status, 'confirmed');
    assert.deepEqual(result.evidence, findMainPostGmEvidence(record));
    assert.ok(result.evidence.every(item => item.source === 'title' && item.entity === '昂科威Plus'));
    const anonymous = normalizeMonitoringEvidence({ relevance: 'relevant', monitoringEvidence: { status: 'confirmed', evidence } }, { content: '哨兵没有录像' });
    assert.equal(anonymous.status, 'needs_review');
    assert.deepEqual(anonymous.evidence, []);
  }
});

test('畸形模型引用不会被当作主帖内容，仍由原文自身决定线索', () => {
  const record = { title: '哨兵体验' };
  const result = normalizeMonitoringEvidence({
    relevance: 'relevant', monitoringEvidence: {
      status: 'confirmed', evidence: [{ source: 'title', quote: ['别克'] }],
    },
  }, record);
  assert.equal(result.status, 'needs_review');
  assert.deepEqual(result.evidence, []);
  assert.equal(normalizeMonitoringEvidence({ relevance: 'relevant', monitoringEvidence: false }, { title: '别克哨兵体验' }).status, 'confirmed');
});

test('CT50被引用成CT5时保留相关原帖，并用原文完整写法重建引用', () => {
  const result = normalizeMonitoringEvidence({
    relevance: 'relevant', monitoringEvidence: {
      status: 'confirmed', evidence: [{ source: 'title', quote: 'CT5' }],
    },
  }, { title: 'CT50的哨兵功能演示' });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.version, 'main-post-entity-v3');
  assert.deepEqual(result.evidence, [{ source: 'title', entity: 'CT50', quote: 'CT50的哨兵功能演示' }]);
});

test('人工相关性可覆盖模型结论，同时保留发帖目的和可判断的负面情感', () => {
  const result = normalizeRecordClassificationResult(applyManualRelevanceOverride({
    relevance: 'irrelevant', sentiment: 'negative', intent: 'complaint', relevanceReason: '模型误判对象',
  }, { relevance: { value: 'relevant', reason: '人工查看完整原文确认车型' } }));
  assert.equal(result.relevance, 'relevant');
  assert.equal(result.relevanceReason, '人工查看完整原文确认车型');
  assert.equal(result.manualRelevanceOverride, true);
  assert.equal(result.intent, 'complaint');
  assert.equal(result.sentiment, 'negative');
});

test('长主帖超过旧 2000 字截断点仍可进入实际分类输入，评论仍隔离', () => {
  const body = `${'背景信息。'.repeat(450)}昂科威Plus的哨兵没有触发`;
  const message = buildUserMessage({
    content: body, keyword: '别克哨兵', comments_text: '评论秘密正文',
  });
  assert.match(message, /昂科威Plus的哨兵没有触发/);
  assert.doesNotMatch(message, /评论秘密正文/);
});

// PostgreSQL jsonb rejects a lone-surrogate escape, so one half-emoji in an evidence
// quote fails the whole label write (SQLSTATE 22P02) and the record is retried forever.
const loneSurrogateEscape = json => /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i.test(json);
const assertEvidenceIsWholeText = (content, evidence, label) => {
  assert.ok(evidence.length > 0, `${label}：应能抽取到线索`);
  for (const item of evidence) {
    assert.equal(isWellFormed(item.quote), true, `${label}：quote 含孤立代理项`);
    assert.equal(isWellFormed(item.entity), true, `${label}：entity 含孤立代理项`);
    assert.ok(content.includes(item.quote), `${label}：quote 必须仍是原文的子串`);
    assert.ok(item.quote.includes(item.entity), `${label}：quote 必须包含 entity`);
  }
  assert.equal(loneSurrogateEscape(JSON.stringify(evidence)), false, `${label}：序列化后不能有孤立转义`);
};

test('引用窗口的起点或终点落在 emoji 中间时整字丢弃，引用仍是原文子串且含实体', () => {
  // 窗口是实体前 25、后 60 个 UTF-16 code unit：逐个偏移扫过两个边界，含正好切断的那一个。
  for (let filler = 20; filler <= 28; filler += 1) {
    const content = `💰${'，'.repeat(filler)}别克哨兵昨晚没有录像`;
    assertEvidenceIsWholeText(content, findMainPostGmEvidence({ content, keyword: '别克哨兵' }), `起点 filler=${filler}`);
  }
  for (let filler = 55; filler <= 63; filler += 1) {
    const content = `别克${'，'.repeat(filler)}💰谁看谁心动`;
    assertEvidenceIsWholeText(content, findMainPostGmEvidence({ content, keyword: '别克哨兵' }), `终点 filler=${filler}`);
  }
  const both = `💰${'，'.repeat(24)}别克${'，'.repeat(59)}💰后面`;
  assertEvidenceIsWholeText(both, findMainPostGmEvidence({ content: both, keyword: '别克哨兵' }), '两端同时');
  // 生产日志里的形状：句子以 emoji 结尾，窗口恰好切在 emoji 前一半之后。
  const production = `别克${'，'.repeat(50)}💡 算完全包落地💰谁看谁心动🤝`;
  for (const cut of [1, 2, 3]) {
    const trimmed = production.slice(0, production.length - cut);
    assertEvidenceIsWholeText(trimmed, findMainPostGmEvidence({ content: trimmed, keyword: '别克哨兵' }), `尾部裁掉 ${cut}`);
  }
});

test('NFKC 会折叠的花体品牌名不会让实体被切在一对代理项中间', () => {
  // 数学字母、方框字母折叠成一个 BMP 字母，归一化偏移落在原文一对代理项的中间。
  for (const [content, entity] of [
    ['𝐁𝐮𝐢𝐜𝐤哨兵没录像', '𝐁𝐮𝐢𝐜𝐤'],
    ['𝓑𝓾𝓲𝓬𝓴哨兵怎么开', '𝓑𝓾𝓲𝓬𝓴'],
    ['𝔹𝕦𝕚𝕔𝕜哨兵怎么开', '𝔹𝕦𝕚𝕔𝕜'],
    ['🄱🅄🄸🄲🄺哨兵怎么开', '🄱🅄🄸🄲🄺'],
    ['𝘊𝘢𝘥𝘪𝘭𝘭𝘢𝘤的哨兵', '𝘊𝘢𝘥𝘪𝘭𝘭𝘢𝘤'],
    ['我的𝐋𝐚𝐂𝐫𝐨𝐬𝐬𝐞哨兵', '𝐋𝐚𝐂𝐫𝐨𝐬𝐬𝐞'],
  ]) {
    const evidence = findMainPostGmEvidence({ content, keyword: '别克哨兵' });
    assertEvidenceIsWholeText(content, evidence, content);
    assert.equal(evidence[0].entity, entity, `${content}：实体应是完整的原文写法`);
  }
});

test('随机混排 emoji、花体和实体：每条证据都是完整文本（固定种子，可复现）', () => {
  let seed = 20260929;
  const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = list => list[Math.floor(next() * list.length)];
  const filler = ['，', '。', '哨兵', '录像', '💰', '👍🏽', '🇨🇳', '👨‍👩‍👧', '1️⃣', '谁看谁心动', ' ', 'abc'];
  const entities = ['别克', '昂科威Plus', '𝐁𝐮𝐢𝐜𝐤', '🄱🅄🄸🄲🄺', '凯迪拉克', 'LaCrosse'];
  let checked = 0;
  for (let round = 0; round < 400; round += 1) {
    let content = '';
    for (let i = Math.floor(next() * 30); i > 0; i -= 1) content += pick(filler);
    content += pick(entities);
    for (let i = Math.floor(next() * 50); i > 0; i -= 1) content += pick(filler);
    const evidence = findMainPostGmEvidence({ content, keyword: '别克哨兵' });
    if (!evidence.length) continue;
    checked += 1;
    assertEvidenceIsWholeText(content, evidence, `round ${round}`);
  }
  assert.ok(checked > 200, `随机样本里大部分应抽到线索，实际 ${checked}`);
});

test('模型引用停在半个 emoji 上会通过 includes 校验，必须被丢弃；完整引用仍被接受', () => {
  const record = { title: '新车ZX9000哨兵没触发💰', content: '' };
  const cite = quote => normalizeMonitoringEvidence({
    relevance: 'relevant',
    monitoringEvidence: {
      status: 'confirmed',
      evidence: [{ source: 'title', entityType: 'model', manufacturer: 'saic_gm', entity: 'ZX9000', quote }],
    },
  }, record);
  const halfEmoji = record.title.slice(0, -1);
  assert.equal(isWellFormed(halfEmoji), false, '夹具：引用确实以孤立高位代理项结尾');
  assert.ok(record.title.includes(halfEmoji), '夹具：UTF-16 的 includes 会放行它');
  const rejected = cite(halfEmoji);
  assert.ok(rejected.evidence.every(item => isWellFormed(item.quote) && isWellFormed(item.entity)));
  assert.equal(rejected.evidence.some(item => item.entityType === 'model'), false, '半个 emoji 的模型引用不能入库');
  assert.equal(loneSurrogateEscape(JSON.stringify(rejected)), false);

  const accepted = cite(record.title);
  assert.equal(accepted.status, 'confirmed');
  assert.deepEqual(accepted.evidence.map(item => [item.source, item.entity, item.quote, item.entityType]),
    [['title', 'ZX9000', record.title, 'model']]);
});

test('模型引用的 quote 完整、但 entity 以半个 emoji 结尾或开头时同样丢弃', () => {
  // hasWholeSourceEntity 用 UTF-16 indexOf，所以带半个 emoji 的 entity 也能在完整的 quote 里找到。
  const cases = [
    { title: '新车ZX9000💰哨兵没触发', entity: 'ZX9000\uD83D', quote: '新车ZX9000💰哨兵' },
    { title: '新车💰ZX9000哨兵没触发', entity: '\uDCB0ZX9000', quote: '新车💰ZX9000哨兵' },
  ];
  for (const { title, entity, quote } of cases) {
    assert.equal(isWellFormed(quote), true, '夹具：quote 本身是完整文本');
    assert.equal(isWellFormed(entity), false, '夹具：entity 带孤立代理项');
    assert.ok(title.includes(quote) && quote.includes(entity), '夹具：includes 校验会放行它');
    const result = normalizeMonitoringEvidence({
      relevance: 'relevant',
      monitoringEvidence: {
        status: 'confirmed',
        evidence: [{ source: 'title', entityType: 'model', manufacturer: 'saic_gm', entity, quote }],
      },
    }, { title });
    assert.equal(result.evidence.some(item => item.entityType === 'model'), false);
    assert.ok(result.evidence.every(item => isWellFormed(item.entity) && isWellFormed(item.quote)));
    assert.equal(loneSurrogateEscape(JSON.stringify(result)), false);
  }
});
