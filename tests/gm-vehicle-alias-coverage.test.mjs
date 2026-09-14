import assert from 'node:assert/strict';
import test from 'node:test';
import { GM_VEHICLE_ALIASES } from '../server/services/gm-vehicle-aliases.js';
import {
  findMainPostGmEvidence, findRecordMonitoringEvidence, formatGmAliasesForPrompt,
  normalizeMonitoringEvidence,
} from '../server/services/record-content-judgment.js';
import { buildSystemPrompt } from '../server/services/ai-labeler.js';

// Independent examples, not generated from the implementation's alias list.
const POSITIVE_NAMES = [
  '上汽通用汽车有限公司', '上海通用汽车', 'SAIC-GM', 'SAIC GM', 'SAIC General Motors',
  'Shanghai General Motors', 'General Motors', 'SGM', 'GM', 'Buick', 'Cadillac', 'Chevrolet', 'Chevy',
  '別克', '凱迪拉克', '雪佛蘭', '雪弗兰', 'OnStar',
  'GL8', 'GL6', '陆尊', '陆尚', '世纪', 'ELECTRA E4', 'ELECTRA E5', 'E4', 'E5', '至境L7', 'L7', '至境E7', 'E7', 'ENCASA',
  'LaCrosse', 'Regal', 'Envision', 'Envision Plus', 'Encore GX', 'Enclave', 'Verano Pro',
  'Excelle', 'Excelle GT', 'Excelle GX', 'VELITE 6', 'VELITE 7', 'Park Avenue',
  'CT4', 'CT5', 'CT6', 'XT4', 'XT5', 'XT6', 'GT4', 'ATS-L', 'XTS', 'SRX', 'CTS', 'SLS',
  'LYRIQ', 'OPTIQ', '傲歌', 'VISTIQ', '凯威德', 'ESCALADE',
  '科鲁泽', 'Monza', 'Cruze', 'Cavalier', 'Malibu XL', 'Equinox', 'Seeker', 'Menlo', 'Trax', 'Tracker RS',
  'Blazer', 'Epica', 'Sail', 'Captiva', 'LOVA RV', 'Aveo', 'Orlando', 'Trailblazer', '沃兰多', '创界',
];

test('品牌、中英车型及历史型号独立样本在汽车语境中全部可识别', async t => {
  for (const name of POSITIVE_NAMES) await t.test(name, () => {
    const record = { title: `${name}的哨兵录像怎么查看` };
    const evidence = findMainPostGmEvidence(record);
    assert.ok(evidence.some(item => item.entity === name), `${name}: ${JSON.stringify(evidence)}`);
    assert.equal(normalizeMonitoringEvidence({ relevance: 'relevant' }, record).status, 'confirmed');
  });
});

test('型号空格连字符全角与配置后缀保持原文，不吞掉相邻英文实体', () => {
  for (const name of ['ct5', 'CT 5', 'CT-5', 'CT–5', 'C T 5', 'ＣＴ５', 'ｂｕｉｃｋ', 'ATS L', 'ATS‑L', 'ＳＡＩＣ－ＧＭ']) {
    const text = `🚗体验：${name}的哨兵未录像`;
    const evidence = findMainPostGmEvidence({ content: text });
    assert.ok(evidence.some(item => item.entity === name), `${name}: ${JSON.stringify(evidence)}`);
    assert.ok(evidence.every(item => text.includes(item.quote) && item.quote.includes(item.entity)));
  }
  for (const name of ['CT5-V Blackwing', 'GL8 Avenir', 'LaCrosse Avenir']) {
    assert.ok(findMainPostGmEvidence({ title: `${name}的驻车录像` }).length > 0, name);
  }
  assert.deepEqual(findMainPostGmEvidence({ title: 'Buick Cadillac Chevrolet' }).map(item => item.entity), ['Buick', 'Cadillac', 'Chevrolet']);
});

test('英文车型的车辆语境可以跨字段或在自然问句中，无需紧挨车型名', () => {
  for (const record of [
    { title: 'LaCrosse', content: '哨兵昨晚没有录像' },
    { title: 'Regal', content: '远程解锁故障' },
    { title: '刚买了Regal，哨兵根本没录到' },
    { title: 'LaCrosse怎么开启哨兵模式' },
    { title: 'Monza', transcript: '我的车哨兵打不开', transcript_status: 'done', transcript_source_url: 'https://example.test/video', video_url: 'https://example.test/video' },
  ]) assert.equal(normalizeMonitoringEvidence({ relevance: 'relevant' }, record).status, 'confirmed', JSON.stringify(record));
  for (const record of [
    { title: 'LaCrosse', content: '曲棍球运动', comments_text: '汽车哨兵' },
    { title: 'Monza', content: '旅行', transcript: '车主反馈哨兵失灵', transcript_status: 'done', transcript_source_url: 'https://example.test/old', video_url: 'https://example.test/new' },
    { title: 'Park Avenue', content: 'cartography map' },
    { title: 'Regal', content: '#汽车 #哨兵' },
  ]) assert.deepEqual(findMainPostGmEvidence(record), [], JSON.stringify(record));
});

test('完整词边界、普通词义和独立公司不产生上汽通用证据', () => {
  for (const title of [
    'CT500哨兵模式', 'myct50测试', 'GMAT课程', 'E50资料', 'SAIC的新闻',
    '哨兵模式的行业开拓者', '通用哨兵安装教程', '追求至境，技术再升级', '跨越世纪的工程',
    'encore the song at Park Avenue', 'Seeker of wisdom', 'GM是游戏管理员',
    '上汽通用五菱的哨兵', '上汽 通用 五菱汽车', 'SGMW 的驻车录像', 'SAIC-GM-Wuling 的驻车录像',
    'Shanghai General Motors Wuling 的驻车录像', 'SAIC General Motors Wuling 的驻车录像',
  ]) assert.deepEqual(findMainPostGmEvidence({ title }), [], title);
  const evidence = findMainPostGmEvidence({ title: '上汽通用五菱与别克的驻车录像对比' });
  assert.deepEqual(evidence.map(item => item.entity), ['别克']);
});

test('所有登记别名均可在声明的车辆语境中使用，来源与标识完整', () => {
  const ids = new Set();
  for (const entry of GM_VEHICLE_ALIASES) {
    assert.ok(!ids.has(entry.id), entry.id); ids.add(entry.id);
    assert.ok(entry.sources.length > 0 && entry.sources.every(url => /^https:\/\//.test(url)), entry.id);
    for (const alias of entry.aliases) {
      const title = alias === '通用' ? '通用旗下车型的驻车录像' : `${alias}的车主反馈哨兵录像异常`;
      const normalizedAlias = alias.normalize('NFKC');
      assert.ok(findMainPostGmEvidence({ title }).some(item => item.entity.normalize('NFKC') === normalizedAlias), `${entry.id}: ${alias}`);
    }
  }
});

// Invented names exercise the path for a not-yet-catalogued name. They do not
// assert that these vehicles exist, or measure live model classification quality.
const unknownRecord = { title: '穹曜Z9的驻车录像无法保存' };
const unknownEvidence = { source: 'title', quote: unknownRecord.title, entity: '穹曜Z9', entityType: 'model', manufacturer: 'saic_gm' };
const resultWith = (evidence, relevance = 'relevant') => ({ relevance, monitoringEvidence: { status: 'needs_review', evidence: [evidence] } });

test('词典外名称可由整体相关和可核验逐字主帖证据保留', () => {
  assert.deepEqual(findMainPostGmEvidence(unknownRecord), []);
  const result = normalizeMonitoringEvidence(resultWith(unknownEvidence), unknownRecord);
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(result.evidence, [unknownEvidence]);
  assert.deepEqual(findRecordMonitoringEvidence({ relevance: 'relevant', monitoringEvidence: result }, unknownRecord), [unknownEvidence]);
  for (const relevance of ['uncertain', 'irrelevant']) {
    assert.equal(normalizeMonitoringEvidence(resultWith(unknownEvidence, relevance), unknownRecord).status, 'needs_review');
  }
});

test('中文口语与拼音缩写由全文归属和逐字证据支持，不按首字母自动归品牌', () => {
  for (const entity of ['凯迪', 'BK', 'KDLK', 'XFL']) {
    const record = { title: `${entity}的驻车录像没保存` };
    const evidence = { source: 'title', quote: record.title, entity, entityType: 'brand', manufacturer: 'saic_gm' };
    assert.equal(normalizeMonitoringEvidence(resultWith(evidence), record).status, 'confirmed', entity);
    assert.equal(normalizeMonitoringEvidence(resultWith({ ...evidence, manufacturer: 'other' }, 'irrelevant'), record).status, 'needs_review', entity);
    assert.equal(normalizeMonitoringEvidence({ relevance: 'relevant' }, record).status, 'needs_review', entity);
  }
});

test('词典外兜底拒绝伪造、泛称、错误来源和实体截断', () => {
  for (const patch of [
    { source: 'content' }, { source: 'keyword' }, { source: 'comments' }, { source: 'author' },
    { entityType: 'unknown' }, { entityType: undefined }, { manufacturer: 'other' }, { manufacturer: undefined },
    { quote: '穹曜Z9正常录像' }, { quote: ['穹曜Z9'] }, { entity: '穹曜Z' }, { entity: ['穹曜Z9'] },
  ]) assert.equal(normalizeMonitoringEvidence(resultWith({ ...unknownEvidence, ...patch }), unknownRecord).status, 'needs_review', JSON.stringify(patch));
  for (const entity of ['我的车', '车型', '哨兵', '汽车', '通用', 'GM', 'SAIC']) {
    const title = `${entity}出现了问题`;
    assert.equal(normalizeMonitoringEvidence(resultWith({ ...unknownEvidence, quote: title, entity }), { title }).status, 'needs_review', entity);
  }
  const blocked = { title: '上汽通用五菱的驻车监控' };
  assert.equal(normalizeMonitoringEvidence(resultWith({ ...unknownEvidence, entity: '上汽通用', quote: blocked.title }), blocked).status, 'needs_review');
  assert.equal(normalizeMonitoringEvidence(resultWith({ ...unknownEvidence, entity: 'Z9', quote: 'Z9' }), { title: 'Z90的驻车监控' }).status, 'needs_review');
});

test('词典外兜底仍隔离标签、评论、作者与过期逐字稿', () => {
  const quote = unknownRecord.title;
  for (const record of [
    { title: '#穹曜Z9的驻车录像无法保存' },
    { title: '驻车录像', comments_text: quote, author_name: quote, keyword: quote },
    { title: '驻车录像', transcript: quote, transcript_status: 'done', transcript_source_url: 'https://example.test/old', video_url: 'https://example.test/new' },
  ]) {
    for (const source of ['title', 'content', 'transcript']) {
      assert.equal(normalizeMonitoringEvidence(resultWith({ ...unknownEvidence, source }), record).status, 'needs_review');
    }
  }
  const record = { transcript: quote, transcript_status: 'done', transcript_source_url: 'https://example.test/new', video_url: 'https://example.test/new' };
  assert.equal(normalizeMonitoringEvidence(resultWith({ ...unknownEvidence, source: 'transcript' }), record).status, 'confirmed');
  assert.deepEqual(findMainPostGmEvidence({ title: '＃ＣＴ５ #Chevy #科鲁泽' }), []);
});

test('哨兵提示词使用统一别名参考并解释词典外兜底与公司边界', () => {
  const prompt = buildSystemPrompt({ brandName: '安吉星', brandAliases: [], businessContext: '', positiveContextTerms: [], noiseTerms: [] }, { keyword: '别克哨兵' });
  assert.ok(prompt.includes(formatGmAliasesForPrompt()));
  for (const text of ['LaCrosse', 'Monza', 'ELECTRA E4', 'CT-5', '上汽通用五菱', '参考表未收录不等于无关', 'manufacturer=saic_gm']) assert.ok(prompt.includes(text), text);
});
