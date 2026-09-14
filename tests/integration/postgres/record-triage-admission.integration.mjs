import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { runMigrations } from '../../../server/db/migrate.js';
import { getPool, closePool } from '../../../server/db/pool.js';
import { createApp } from '../../../server/app.js';
import { hashPassword } from '../../../server/services/auth-service.js';
import { recordTriageAdmissionSql, recordTriageAdmission } from '../../../server/services/record-triage-admission.js';
import { GM_VEHICLE_ALIASES, GM_COMPATIBLE_MODEL_SPELLINGS } from '../../../server/services/gm-vehicle-aliases.js';
const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const ExcelJS = require('exceljs');

test('sentry content admission is shared by HTTP lists, exports, badges and workspace; excluded posts remain only in raw storage with their existing human state', async t => {
  validatePostgresIntegrationTarget({ testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true });
  await runMigrations();
  const pool = getPool(), tenants = [], users = [];
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    if (tenants.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
    await closePool();
  });
  for (let i = 0; i < 2; i++) tenants.push((await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`Admission ${randomUUID()}`])).rows[0].id);
  const [tenant, otherTenant] = tenants, fixtures = new Map(), ids = {};
  async function record(name, fields = {}) {
    const value = { id: randomUUID(), tenant_id: tenant, platform: 'douyin', external_id: name, title: '开启哨兵模式', keyword: '别克哨兵', record_type: 'keyword_notes', business_visibility: 'eligible', ai_result: { relevance: 'relevant' }, intent: '', ...fields };
    const columns = Object.keys(value);
    await pool.query(`INSERT INTO records(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(value).map(item => item !== null && typeof item === 'object' ? JSON.stringify(item) : item));
    ids[name] = value.id; fixtures.set(name, value);
    return value.id;
  }
  await record('missing-proof');
  await record('uncertain', { title: '别克车主', ai_result: { relevance: 'uncertain' } });
  await record('no-judgment', { title: '别克车主', ai_result: {} });
  await record('hashtags-only', { title: '#别克哨兵 #CT5 功能展示', author_name: '凯迪拉克车主', tags: ['别克'] });
  await record('substring', { title: 'CT50哨兵模式' });
  const ambiguousModelCases = [
    ['blazer-figurative', '哨兵模式行业开拓者', false],
    ['blazer-vehicle', '我的开拓者哨兵录像没触发', true],
    ['electra-figurative', '追求至境，哨兵技术再升级', false],
    ['electra-model', '至境L7哨兵体验', true],
    ['epica-figurative', '一路景程，沿途风景真好', false],
    ['epica-owner', '景程车主咨询驻车监控', true],
  ];
  for (const [name, title] of ambiguousModelCases) await record(name, { title });
  const modelClueCases = [
    ['short-l7', 'L7哨兵模式怎么开', { relevance: 'relevant' }, true],
    ['short-e5', 'E5驻车监控异常', { relevance: 'relevant' }, true],
    ['short-l7-old-metadata', 'L7哨兵体验', { relevance: 'relevant', monitoringEvidence: { status: 'needs_review', evidence: [] } }, true],
    ['short-uncertain', 'L7哨兵功能咨询', { relevance: 'uncertain' }, false],
    ['other-brand-l7', '理想L7的哨兵功能', { relevance: 'irrelevant' }, false],
    ['quote-without-source-clue', '昨晚哨兵录像失败', { relevance: 'relevant', monitoringEvidence: { status: 'confirmed', evidence: [{ source: 'title', quote: '别克车主' }] } }, false],
  ];
  for (const [name, title, ai_result] of modelClueCases) await record(name, { title, ai_result });
  const aliasCases = [
    ['alias-fullwidth', 'ＣＴ５哨兵体验', true],
    ['alias-spaced', 'CT 5驻车异常', true],
    ['alias-unicode-hyphen', 'CT‑5录像故障', true],
    ['alias-saic-gm', 'SAIC‑GM驻车服务', true],
    ['sgmw-chinese', '上汽通用五菱哨兵体验', false],
    ['sgmw-latin', 'SAIC-GM-Wuling录像', false],
    ['sgmw-fullwidth', 'ＳＡＩＣ－ＧＭ－Ｗｕｌｉｎｇ录像', false],
    ['sgmw-acronym', 'SGMW驻车', false],
    ['sgmw-and-buick', '上汽通用五菱与别克车型对比', true],
    ['partial-ct500', 'CT500录像', false],
    ['partial-el70', 'EL70录像', false],
    ['partial-myct50', 'myct50录像', false],
  ];
  for (const [name, title] of aliasCases) await record(name, { title });
  const crossSourceCases = [
    ['model-context-lacrosse', { title: 'LaCrosse', content: '哨兵昨晚没有录像' }, true],
    ['model-context-regal', { title: 'Regal', content: '远程解锁故障' }, true],
    ['model-context-sentence', { title: '刚买了Regal，哨兵根本没录到' }, true],
    ['model-context-question', { title: 'LaCrosse怎么开启哨兵模式' }, true],
    ['model-context-current-media', { title: 'Regal', video_url: 'https://video.example.test/current.mp4', transcript_status: 'done', transcript_source_url: 'https://video.example.test/current.mp4', transcript: '远程解锁没有响应' }, true],
    ['model-context-song', { title: 'Regal', content: '这首歌曲很好听' }, false],
    ['model-context-place', { title: 'Monza', content: '意大利城市风景很美' }, false],
    ['model-context-comments', { title: 'Regal', comments_text: '哨兵昨晚没有录像' }, false],
    ['model-context-tags', { title: 'Regal', content: '#哨兵 #驻车录像', tags: ['汽车'] }, false],
    ['model-context-stale-media', { title: 'Regal', video_url: 'https://video.example.test/current.mp4', transcript_status: 'done', transcript_source_url: 'https://video.example.test/old.mp4', transcript: '远程解锁没有响应' }, false],
    ['model-context-company', { title: 'SGM', content: '哨兵昨晚没有录像' }, false],
    ['model-context-ordinary-word', { title: '开拓者', content: '哨兵行业正在发展' }, false],
  ];
  for (const [name, fields] of crossSourceCases) await record(name, fields);
  const fallbackTitle = '星穹Z9哨兵录像无法保存';
  const fallbackEntry = { source: 'title', quote: fallbackTitle, entity: '星穹Z9', entityType: 'model', manufacturer: 'saic_gm' };
  const fallbackAi = (entry = fallbackEntry, relevance = 'relevant') => ({ relevance, monitoringEvidence: { status: 'needs_review', evidence: [entry] } });
  const fallbackCases = [
    ['fallback-valid', { title: fallbackTitle, ai_result: fallbackAi() }, true],
    ['fallback-no-dictionary', { title: fallbackTitle }, false],
    ['fallback-content', { content: fallbackTitle, ai_result: fallbackAi({ ...fallbackEntry, source: 'content' }) }, true],
    ['fallback-false-quote', { title: fallbackTitle, ai_result: fallbackAi({ ...fallbackEntry, quote: '星穹Z9并不存在的原话' }) }, false],
    ['fallback-false-entity', { title: fallbackTitle, ai_result: fallbackAi({ ...fallbackEntry, entity: '别的名字' }) }, false],
    ['fallback-array-quote', { title: fallbackTitle, ai_result: fallbackAi({ ...fallbackEntry, quote: [fallbackTitle] }) }, false],
    ['fallback-array-entity', { title: fallbackTitle, ai_result: fallbackAi({ ...fallbackEntry, entity: ['星穹Z9'] }) }, false],
    ['fallback-no-entity-type', { title: fallbackTitle, ai_result: fallbackAi({ ...fallbackEntry, entityType: null }) }, false],
    ['fallback-other-company', { title: fallbackTitle, ai_result: fallbackAi({ ...fallbackEntry, manufacturer: 'sgmw' }) }, false],
    ['fallback-uncertain', { title: fallbackTitle, ai_result: fallbackAi(fallbackEntry, 'uncertain') }, false],
    ['fallback-irrelevant', { title: fallbackTitle, ai_result: fallbackAi(fallbackEntry, 'irrelevant') }, false],
    ['fallback-hashtag', { title: '#星穹Z9 哨兵体验', ai_result: fallbackAi({ ...fallbackEntry, quote: '星穹Z9' }) }, false],
    ['fallback-keyword', { keyword: '别克哨兵星穹Z9', ai_result: fallbackAi({ ...fallbackEntry, source: 'keyword', quote: '星穹Z9' }) }, false],
    ['fallback-comments', { comments_text: fallbackTitle, ai_result: fallbackAi({ ...fallbackEntry, source: 'comments' }) }, false],
    ['fallback-tags', { tags: ['星穹Z9'], ai_result: fallbackAi({ ...fallbackEntry, source: 'tags', quote: '星穹Z9' }) }, false],
    ['fallback-generic', { title: '这辆车哨兵故障', ai_result: fallbackAi({ ...fallbackEntry, quote: '这辆车哨兵故障', entity: '这辆车' }) }, false],
    ['fallback-truncated', { title: 'ZX90哨兵', ai_result: fallbackAi({ ...fallbackEntry, quote: 'ZX90哨兵', entity: 'ZX9' }) }, false],
    ['fallback-prefix', { title: 'myZX9哨兵', ai_result: fallbackAi({ ...fallbackEntry, quote: 'myZX9哨兵', entity: 'ZX9' }) }, false],
    ['fallback-width-prefix', { title: 'ＸZX9哨兵', ai_result: fallbackAi({ ...fallbackEntry, quote: 'ＸZX9哨兵', entity: 'ZX9' }) }, false],
    ['fallback-repeated', { title: 'myZX9旧名字，ZX9哨兵录像', ai_result: fallbackAi({ ...fallbackEntry, quote: 'myZX9旧名字，ZX9哨兵录像', entity: 'ZX9' }) }, true],
    ['fallback-raw-width', { title: '星穹Ｚ９哨兵', ai_result: fallbackAi({ ...fallbackEntry, quote: '星穹Ｚ９哨兵', entity: '星穹Ｚ９' }) }, true],
    ['fallback-invented-normalization', { title: '星穹Ｚ９哨兵', ai_result: fallbackAi({ ...fallbackEntry, quote: '星穹Z9哨兵', entity: '星穹Z9' }) }, false],
    ['fallback-sgmw-prefix', { title: '上汽通用五菱录像', ai_result: fallbackAi({ ...fallbackEntry, quote: '上汽通用五菱录像', entity: '上汽通用', entityType: 'brand' }) }, false],
    ['fallback-sgmw-latin-prefix', { title: 'SAIC-GM-Wuling录像', ai_result: fallbackAi({ ...fallbackEntry, quote: 'SAIC-GM-Wuling录像', entity: 'SAIC-GM', entityType: 'brand' }) }, false],
    ['fallback-transcript', { video_url: 'https://v.douyinvod.com/fallback.mp4', transcript_source_url: 'https://v.douyinvod.com/fallback.mp4', transcript_status: 'done', transcript: fallbackTitle, ai_result: fallbackAi({ ...fallbackEntry, source: 'transcript' }) }, true],
    ['fallback-stale-transcript', { video_url: 'https://v.douyinvod.com/new.mp4', transcript_source_url: 'https://v.douyinvod.com/old.mp4', transcript_status: 'done', transcript: fallbackTitle, ai_result: fallbackAi({ ...fallbackEntry, source: 'transcript' }) }, false],
  ];
  for (const [name, fields] of fallbackCases) await record(name, fields);
  await record('legacy-proof', { title: '我的 CT5 哨兵体验', keyword: '至境哨兵', intent: 'share' });
  await record('new-proof', { title: '别克车主分享', intent: 'inquiry', ai_result: { relevance: 'relevant', monitoringEvidence: { status: 'confirmed', evidence: [{ source: 'title', quote: '别克车主' }] } } });
  await record('stale-proof', { title: '别克车主分享', ai_result: { relevance: 'relevant', monitoringEvidence: { status: 'confirmed', evidence: [{ source: 'title', quote: 'CT5车主' }] } } });
  await record('cropped-model-proof', { title: 'CT50的哨兵功能演示', ai_result: { relevance: 'relevant', monitoringEvidence: { status: 'confirmed', evidence: [{ source: 'title', quote: 'CT5' }] } } });
  await record('new-needs-review', { title: '别克车主分享', ai_result: { relevance: 'relevant', monitoringEvidence: { status: 'needs_review', evidence: [{ source: 'title', quote: '别克车主' }] } } });
  await record('malformed-false', { title: '别克车主', ai_result: { relevance: 'relevant', monitoringEvidence: false } });
  await record('malformed-empty', { title: '别克车主', ai_result: { relevance: 'relevant', monitoringEvidence: '' } });
  await record('array-quote', { title: '["别克"]', ai_result: { relevance: 'relevant', monitoringEvidence: { status: 'confirmed', evidence: [{ source: 'title', quote: ['别克'] }] } } });
  await record('whitespace-quote', { title: '别克车主', ai_result: { relevance: 'relevant', monitoringEvidence: { status: 'confirmed', evidence: [{ source: 'title', quote: '\n别克\n' }] } } });
  await record('fullwidth-hashtag', { title: '＃别克哨兵 功能演示' });
  await record('compound-scope', { keyword: '至境哨兵别克壁纸' });
  await record('historic-scope', { keyword: '壁纸' });
  await pool.query('INSERT INTO record_observations(tenant_id,record_id,keyword) VALUES($1,$2,$3)', [tenant, ids['historic-scope'], '凯迪拉克哨兵']);
  fixtures.get('historic-scope').observed_keywords = ['凯迪拉克哨兵'];
  await record('unscoped', { keyword: '哨兵模式', intent: 'suggestion', ai_result: { relevance: 'uncertain' } });
  await record('unscoped-watched-irrelevant', { keyword: '普通监测', title: '已人工关注的日常分享', sentiment: 'neutral', ai_result: { relevance: 'irrelevant' } });
  await pool.query('INSERT INTO record_watchlist(tenant_id,record_id) VALUES($1,$2)', [tenant, ids['unscoped-watched-irrelevant']]);
  await record('foreign-observation', { keyword: '壁纸' });
  // A historical corrupt cross-tenant observation must not scope another tenant's record.
  await pool.query('INSERT INTO record_observations(tenant_id,record_id,keyword) VALUES($1,$2,$3)', [otherTenant, ids['foreign-observation'], '别克哨兵']);
  await record('manual-release', { manual_overrides: { relevance: { value: 'relevant', reason: '已核对车型图片' } }, ai_result: { relevance: 'irrelevant' }, intent: 'complaint' });
  await record('manual-reject', { title: 'CT5内容', manual_overrides: { relevance: 'irrelevant' } });
  await record('manual-uncertain', { title: 'CT5内容', manual_overrides: { relevance: { value: 'uncertain' } } });
  const videoUrl = 'https://v.douyinvod.com/current.mp4';
  await record('valid-transcript', { video_url: videoUrl, transcript_status: 'done', transcript_source_url: videoUrl, transcript: '我是别克车主', intent: 'other' });
  await record('whitespace-media', { video_url: ` ${videoUrl}\n`, transcript_status: 'done', transcript_source_url: `\n${videoUrl} `, transcript: '别克体验', intent: '\nshare\n' });
  await record('stale-transcript', { video_url: videoUrl, transcript_status: 'done', transcript_source_url: 'https://v.douyinvod.com/old.mp4', transcript: '我是别克车主' });
  await record('object-media', { payload: { videoUrls: [{ src: videoUrl }] }, transcript_status: 'done', transcript_source_url: videoUrl, transcript: '我是CT5车主' });
  await record('archived-manual-override', { manual_overrides: { relevance: { value: 'relevant', reason: 'Existing decision' } }, ai_result: { relevance: 'irrelevant' } });
  await pool.query("INSERT INTO record_triage(tenant_id,record_id,status,archived_at,archived_by_name) VALUES($1,$2,'reviewed',now(),'Original reviewer')", [tenant, ids['archived-manual-override']]);
  await record('archived-blocked');
  await pool.query("INSERT INTO record_triage(tenant_id,record_id,status,archived_at,archived_by_name) VALUES($1,$2,'reviewed',now(),'Original reviewer')", [tenant, ids['archived-blocked']]);
  await pool.query('INSERT INTO record_watchlist(tenant_id,record_id) VALUES($1,$2)', [tenant, ids['missing-proof']]);

  const sqlRows = (await pool.query(`SELECT r.*, ${recordTriageAdmissionSql('r')} AS admitted FROM records r WHERE tenant_id=$1`, [tenant])).rows;
  for (const row of sqlRows) {
    const js = recordTriageAdmission({ ...row, observed_keywords: fixtures.get(row.external_id).observed_keywords });
    assert.equal(row.admitted, js.admitted, `${row.external_id}: JS/SQL admission`);
  }
  for (const [name, title, expected] of ambiguousModelCases) {
    const row = sqlRows.find(item => item.external_id === name);
    assert.equal(row.admitted, expected, title);
  }
  for (const [name, title, , expected] of modelClueCases) assert.equal(sqlRows.find(row => row.external_id === name).admitted, expected, title);
  for (const [name, title, expected] of aliasCases) assert.equal(sqlRows.find(row => row.external_id === name).admitted, expected, title);
  for (const [name, , expected] of crossSourceCases) assert.equal(sqlRows.find(row => row.external_id === name).admitted, expected, name);
  for (const [name, , expected] of fallbackCases) assert.equal(sqlRows.find(row => row.external_id === name).admitted, expected, name);
  // Cover the complete shared catalog without inflating the paged HTTP fixture.
  // These are typed record values, not database writes or classifier requests.
  const catalogAliases = [...new Set([...GM_VEHICLE_ALIASES.flatMap(entry => entry.aliases), ...GM_COMPATIBLE_MODEL_SPELLINGS.flatMap(value => typeof value === 'string' ? [value] : value.aliases)])];
  const parityCases = catalogAliases.map(alias => ({ name: `catalog:${alias}`, fields: { title: `我的${alias}的哨兵录像` }, expected: true }));
  const cappedEvidence = count => ({ relevance: 'relevant', monitoringEvidence: { evidence: [...Array(count).fill({ ...fallbackEntry, quote: '不存在的原话' }), fallbackEntry] } });
  const exactQuote = `星穹Z9${'😀'.repeat(248)}`, longQuote = `${exactQuote}😀`, longEntity = `星穹Z9${'😀'.repeat(39)}`;
  const longSource = `${'背景'.repeat(5000)}myZX9${'经历'.repeat(5000)}，ZX9哨兵录像异常`;
  parityCases.push(
    { name: 'fallback-entry-12', fields: { title: fallbackTitle, ai_result: cappedEvidence(11) }, expected: true },
    { name: 'fallback-entry-13', fields: { title: fallbackTitle, ai_result: cappedEvidence(12) }, expected: false },
    { name: 'fallback-quote-limit', fields: { title: exactQuote, ai_result: fallbackAi({ ...fallbackEntry, quote: exactQuote }) }, expected: true },
    { name: 'fallback-quote-over-limit', fields: { title: longQuote, ai_result: fallbackAi({ ...fallbackEntry, quote: longQuote }) }, expected: false },
    { name: 'fallback-entity-over-limit', fields: { title: longEntity, ai_result: fallbackAi({ ...fallbackEntry, quote: longEntity, entity: longEntity }) }, expected: false },
    { name: 'fallback-null-entry', fields: { title: fallbackTitle, ai_result: fallbackAi(null) }, expected: false },
    { name: 'fallback-object-evidence', fields: { title: fallbackTitle, ai_result: { relevance: 'relevant', monitoringEvidence: { evidence: fallbackEntry } } }, expected: false },
    { name: 'fallback-trimmed-citation', fields: { title: fallbackTitle, ai_result: fallbackAi({ ...fallbackEntry, quote: `\n${fallbackTitle}\n`, entity: '\n星穹Z9\n' }) }, expected: true },
    { name: 'fallback-long-source-later-match', fields: { content: longSource, ai_result: fallbackAi({ ...fallbackEntry, source: 'content', quote: 'ZX9', entity: 'ZX9' }) }, expected: true },
    { name: 'fallback-long-source-only-embedded', fields: { content: longSource.replace('，ZX9哨兵录像异常', ''), ai_result: fallbackAi({ ...fallbackEntry, source: 'content', quote: 'ZX9', entity: 'ZX9' }) }, expected: false },
    { name: 'fallback-overlapping-later-match', fields: { title: 'xA中A中A哨兵', ai_result: fallbackAi({ ...fallbackEntry, quote: 'A中A', entity: 'A中A' }) }, expected: true },
    { name: 'fallback-empty-entity', fields: { title: fallbackTitle, ai_result: fallbackAi({ ...fallbackEntry, entity: '' }) }, expected: false },
  );
  const parityInput = parityCases.map(({ name, fields }) => ({ id: randomUUID(), tenant_id: tenant, external_id: name, keyword: '别克哨兵', ai_result: { relevance: 'relevant' }, ...fields }));
  const parityRows = (await pool.query(`SELECT r.*,${recordTriageAdmissionSql('r')} AS admitted FROM jsonb_populate_recordset(NULL::records,$1::jsonb) r`, [JSON.stringify(parityInput)])).rows;
  for (const row of parityRows) {
    const expected = parityCases.find(item => item.name === row.external_id).expected;
    assert.equal(recordTriageAdmission(row).admitted, expected, `${row.external_id}: JS`);
    assert.equal(row.admitted, expected, `${row.external_id}: PostgreSQL`);
  }
  t.diagnostic(`Verified ${catalogAliases.length} shared catalog aliases and ${parityCases.length - catalogAliases.length} fallback boundaries in JavaScript and PostgreSQL; ${fixtures.size} HTTP fixtures.`);
  async function login(role) {
    const email = `admission-${randomUUID()}@integration.invalid`;
    const id = (await pool.query("INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'Admission reviewer',$2,'active',false,'',false) RETURNING id", [email, hashPassword('admission-test-password')])).rows[0].id;
    users.push(id);
    await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,$3,'active')", [id, tenant, role]);
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'admission-test-password' }) });
    assert.equal(response.status, 200);
    return { authorization: `Bearer ${(await response.json()).token}`, 'x-tenant-id': tenant, 'content-type': 'application/json' };
  }
  server = await new Promise(resolve => { const instance = createApp({ logger: { log() {}, error() {} } }).listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`, headers = await login('tenant_analyst'), readerHeaders = await login('tenant_viewer');
  async function json(path, options = {}) {
    const response = await fetch(`${base}/api${path}`, { headers, ...options });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body)); return body;
  }
  async function list(query = '') { return json(`/triage/records?pageSize=100&${query}`); }
  const admittedIds = sqlRows.filter(row => row.admitted).map(row => row.id).sort();
  const workingIds = admittedIds.filter(id => id !== ids['archived-manual-override']);
  const activeIds = workingIds.filter(id => id !== ids['unscoped-watched-irrelevant']);
  for (const query of ['', 'queue=triage', 'queue=active']) {
    const body = await list(query);
    const expected = query === 'queue=active' ? activeIds : query === 'queue=triage' ? workingIds : admittedIds;
    assert.deepEqual(body.records.map(row => row.id).sort(), expected, query);
    assert.equal(Number(body.pagination.total), expected.length);
    assert.ok(body.records.every(row => !('relevance_review_required' in row) && !('relevance_review_reason' in row)));
  }
  const visible = (await list('queue=triage')).records;
  for (const name of ['short-l7','short-e5','short-l7-old-metadata','substring','cropped-model-proof','new-needs-review','stale-proof']) {
    const row = visible.find(item => item.id === ids[name]);
    assert.ok(row, `${name} must remain in ordinary triage when the whole-post AI decision is relevant`);
    assert.equal(row.ai_result.monitoringEvidence.status, 'confirmed');
    assert.equal(row.ai_result.monitoringEvidence.version, 'main-post-entity-v3');
  }
  const explicitModel = visible.find(row => row.id === ids['fallback-valid']);
  assert.deepEqual(explicitModel.ai_result.monitoringEvidence.evidence, [fallbackEntry]);
  for (const name of ['alias-fullwidth', 'alias-spaced', 'alias-unicode-hyphen', 'fallback-raw-width']) {
    const row = visible.find(item => item.id === ids[name]);
    assert.ok(row.ai_result.monitoringEvidence.evidence.every(item => row.title.includes(item.quote) && item.quote.includes(item.entity)), `${name} preserves literal original citations`);
  }
  const corrected = visible.find(row => row.id === ids['cropped-model-proof']);
  assert.ok(corrected.ai_result.monitoringEvidence.evidence.some(item => item.quote.includes('CT50')));
  assert.ok(corrected.ai_result.monitoringEvidence.evidence.every(item => item.quote !== 'CT5'));
  const wrongQuote = visible.find(row => row.id === ids['stale-proof']);
  assert.ok(wrongQuote.ai_result.monitoringEvidence.evidence.every(item => !item.quote.includes('CT5')));
  const transcriptProjection = visible.find(row => row.id === ids['valid-transcript']);
  assert.deepEqual(transcriptProjection.ai_result.monitoringEvidence.evidence, [], 'list omits transcript text and must not display unchecked historical quotes');
  assert.match(transcriptProjection.ai_result.monitoringEvidence.reason, /媒体/);
  const mediaContextProjection = visible.find(row => row.id === ids['model-context-current-media']);
  assert.deepEqual(mediaContextProjection.ai_result.monitoringEvidence.evidence, []);
  assert.match(mediaContextProjection.ai_result.monitoringEvidence.reason, /结合主帖标题、正文与当前媒体/);
  assert.deepEqual((await list('queue=triage&watched=true')).records.map(row => row.id), [ids['unscoped-watched-irrelevant']], 'ordinary watched content remains visible despite AI irrelevant, but an unverified sentry post does not');
  assert.deepEqual((await list('queue=triage&intent=none')).records, []);
  assert.equal((await list('queue=triage&intent=none')).pagination.total, 0);
  const blockedIds = sqlRows.filter(row => !row.admitted).map(row => row.id).sort();
  for (const route of ['/triage/records', '/triage/records/export']) {
    for (const query of ['bucket=relevance_review', 'queue=triage&bucket=relevance_review&watched=true']) {
      const response = await fetch(`${base}/api${route}?${query}`, { headers });
      assert.equal(response.status, 400, 'retired review bucket cannot bypass admission');
      assert.equal((await response.json()).error, 'invalid_bucket');
    }
  }
  assert.deepEqual((await list('bucket=archived')).records.map(row => row.id), [ids['archived-manual-override']]);
  const badges = (await json('/workspace/badges')).badges;
  assert.equal(badges.triagePending, activeIds.length);
  assert.equal('relevanceReviewPending' in badges, false);
  const overview = await json('/workspace/overview');
  assert.equal(Number(overview.kpi.total_records), admittedIds.length);
  assert.ok(overview.latestContent.every(row => admittedIds.includes(row.id)));
  assert.ok(overview.pendingRecords.every(row => admittedIds.includes(row.id)));
  const intentRows = (await list('intent=share&intent=inquiry')).records;
  assert.deepEqual(intentRows.map(row => row.intent_display).sort(), ['inquiry', 'share', 'share']);
  assert.deepEqual((await list('intent=other,complaint')).records.map(row => row.intent_display).sort(), ['complaint', 'other', 'other']);
  assert.equal((await list()).records.find(row => row.id === ids['foreign-observation']).intent_display, null);
  for (const route of ['/triage/records', '/triage/records/export']) assert.equal((await fetch(`${base}/api${route}?intent=bogus`, { headers })).status, 400);
  async function exportRows(query) {
    const response = await fetch(`${base}/api/triage/records/export?${query}`, { headers });
    assert.equal(response.status, 200);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
    return workbook.worksheets[0];
  }
  assert.equal((await exportRows('')).rowCount, admittedIds.length + 1);
  assert.equal((await exportRows('bucket=archived')).rowCount, 2);
  const unjudgedSheet = await exportRows('');
  const headerValues = unjudgedSheet.getRow(1).values;
  assert.ok(headerValues.includes('相关性依据'));
  const exportText = JSON.stringify(unjudgedSheet.getSheetValues());
  assert.ok(exportText.includes('CT50的哨兵功能演示'));
  assert.ok(exportText.includes('L7哨兵模式怎么开'));
  assert.ok(exportText.includes('E5驻车监控异常'));
  assert.ok(exportText.includes(fallbackTitle));
  assert.ok(exportText.includes('ＣＴ５哨兵体验'));
  assert.ok(exportText.includes('CT‑5录像故障'));
  assert.ok(!exportText.includes('SAIC-GM-Wuling录像'));
  assert.ok(!exportText.includes('CT500录像'));
  assert.ok(!exportText.includes('理想L7的哨兵功能'));
  assert.ok(!exportText.includes('哨兵模式行业开拓者'));
  assert.ok(exportText.includes('Existing decision'));
  assert.deepEqual(headerValues.slice(headerValues.indexOf('情感'), headerValues.indexOf('情感') + 6), ['情感','意图','相关性','AI置信度','判断来源','分类']);
  assert.ok(JSON.stringify(unjudgedSheet.getSheetValues()).includes('待判断'));
  assert.ok(JSON.stringify(unjudgedSheet.getSheetValues()).includes('投诉/抱怨'));
  const sheet = await exportRows('intent=other');
  assert.equal(sheet.rowCount, 3);
  const intentColumn = sheet.getRow(1).values.indexOf('意图');
  assert.ok(intentColumn > 0);
  assert.equal(sheet.getRow(2).getCell(intentColumn).value, '其他');

  const patchPath = `/triage/records/${ids['archived-blocked']}/relevance`;
  for (const actorHeaders of [headers, readerHeaders]) {
    const response = await fetch(`${base}/api${patchPath}`, { method: 'PATCH', headers: actorHeaders, body: JSON.stringify({ relevance: 'relevant', reason: 'This retired route must not change anything' }) });
    assert.equal(response.status, 404, 'there is no new human review endpoint');
  }
  const preserved = (await pool.query('SELECT r.content,r.business_visibility,rt.status,rt.archived_at,rt.archived_by_name FROM records r JOIN record_triage rt ON rt.record_id=r.id AND rt.tenant_id=r.tenant_id WHERE r.id=$1', [ids['archived-blocked']])).rows[0];
  assert.equal(preserved.business_visibility, 'eligible'); assert.equal(preserved.status, 'reviewed'); assert.ok(preserved.archived_at); assert.equal(preserved.archived_by_name, 'Original reviewer');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND action='record.relevance_reviewed'", [tenant])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM record_versions WHERE tenant_id=$1', [tenant])).rows[0].n, 0);
  const raw = await json('/records/tables/keyword_notes?pageSize=100');
  assert.equal(raw.pagination.total, fixtures.size, 'all original records remain available in the raw database table');
  assert.deepEqual(raw.rows.map(row => row.id).sort(), sqlRows.map(row => row.id).sort());
  assert.ok(blockedIds.every(id => raw.rows.some(row => row.id === id)));
  assert.deepEqual(raw.rows.find(row => row.id === ids['cropped-model-proof']).ai_result.monitoringEvidence.evidence, [{ source: 'title', quote: 'CT5' }], 'read-time quote repair must not rewrite persisted raw AI evidence');
  assert.equal(raw.rows.find(row => row.id === ids['short-l7-old-metadata']).ai_result.monitoringEvidence.status, 'needs_review');
  const rawReader = await json('/records/tables/keyword_notes?pageSize=100', { headers: readerHeaders });
  assert.equal(rawReader.pagination.total, fixtures.size);
  assert.equal((await fetch(`${base}/api/triage/records?queue=triage`, { headers: { ...headers, 'x-tenant-id': otherTenant } })).status, 403);
});
