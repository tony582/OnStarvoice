import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool, closePool} from '../../../server/db/pool.js';
import {getReportStats} from '../../../server/services/report-generator.js';
import {createApp} from '../../../server/app.js';
import {hashPassword} from '../../../server/services/auth-service.js';

const START = new Date('2026-11-11T00:00:00Z'), END = new Date('2026-11-12T00:00:00Z');
const at = minute => new Date(START.getTime() + (360 + minute) * 60_000).toISOString();

test('nullable interactions preserve known metrics across real published reports and authenticated triage HTTP', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input);
    assert.equal(url.hostname, '127.0.0.1', 'only this test HTTP server may be contacted');
    return originalFetch(input, options);
  };
  await runMigrations();
  const pool = getPool(), tenants = [], users = [];
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  let server;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (server) {server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));}
    try {
      if (users.length) await query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      if (tenants.length) await query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
    } finally {await closePool();}
  });
  for (let i = 0; i < 2; i++) {
    tenants.push((await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`T19 metrics ${randomUUID()}`]))[0].id);
  }
  const [tenantId, foreignTenant] = tenants;
  const records = {};
  async function record(name, sentiment, metrics, {platform = 'wechat_articles', negativeComments = 0, owner = tenantId} = {}) {
    const id = randomUUID(), timestamp = at(Object.keys(records).length);
    await query(`INSERT INTO records(id,tenant_id,platform,external_id,record_type,note_type,title,content,author_name,
      business_visibility,ai_result,manual_overrides,sentiment,category,keyword,published_ts,created_at,first_seen_at,last_seen_at,
      likes,comments_count,collects,shares,negative_comment_count)
      VALUES($1::uuid,$2,$3,($1::uuid)::text,'keyword_notes',$4,$5,$5,$5,'eligible','{"relevance":"relevant"}',
        '{"relevance":"relevant"}',$6,'服务体验','安吉星',$7,$7,$7,$7,$8,$9,$10,$11,$12)`,
    [id, owner, platform, platform === 'wechat_articles' ? 'article' : 'video', name, sentiment, timestamp, ...metrics, negativeComments]);
    // Reviewed low-engagement records can still have historical negative comments.
    // This deliberately tests risk buckets, not just descending engagement within a bucket.
    await query("INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,'reviewed')", [owner, id]);
    records[name] = {id, metrics, timestamp}; return id;
  }
  const highNegative = await record('partial-high-negative', 'negative', [10000, null, null, null]);
  const lowNegative = await record('known-low-negative', 'negative', [5, 5, 0, 0], {negativeComments: 3});
  const highPositive = await record('partial-high-positive', 'positive', [8000, null, null, null]);
  const lowPositive = await record('known-low-positive', 'positive', [10, 10, 10, 10], {negativeComments: 1});
  const zero = await record('known-zero', 'neutral', [0, 0, 0, 0]);
  const unknown = await record('unknown-all', 'neutral', [null, null, null, null]);
  const legacy = await record('known-douyin', 'negative', [20, 10, 5, 5], {platform: 'douyin'});
  const foreign = await record('foreign-large', 'negative', [99999, null, null, null], {owner: foreignTenant});
  const comments = [];
  for (const [recordId, likes] of [[lowNegative, null], [lowNegative, 0], [lowNegative, 7], [lowPositive, 3]]) {
    const id = randomUUID();
    await query(`INSERT INTO record_comments(id,tenant_id,record_id,platform,external_comment_id,content,like_count,
      is_negative,sentiment,risk_level,first_seen_at,last_seen_at,created_at)
      VALUES($1::uuid,$2,$3,'wechat_articles',($1::uuid)::text,'离线留言测试',$4,true,'negative','low',$5,$5,$5)`,
    [id, tenantId, recordId, likes, at(20 + comments.length)]);
    comments.push({id, likes});
  }

  const stats = await getReportStats(tenantId, START, END, [], {timeBasis: 'published', commentRiskAttentionEnabled: true});
  const index = (rows, id) => {const result = rows.findIndex(row => row.id === id); assert.ok(result >= 0, `missing record ${id}`); return result;};
  const before = (rows, first, second) => assert.ok(index(rows, first) < index(rows, second), `${first} must precede ${second}`);

  await t.test('published samples and rankings retain 10000 known likes despite three NULL metrics', () => {
    assert.equal(stats.total, 7); assert.equal(stats.timeBasis, 'published'); assert.equal(stats.commentRiskAttentionEnabled, true);
    assert.equal(stats.topInteraction[0].id, highNegative); assert.equal(stats.topInteraction[1].id, highPositive);
    assert.equal(stats.topNegative[0].id, highNegative);
    assert.equal(stats.sentimentSamples[0].id, highNegative); assert.equal(stats.sentimentSamples[1].id, highPositive);
    for (const rows of [stats.topInteraction, stats.sentimentSamples]) {
      for (const low of [lowNegative, lowPositive, zero, unknown, legacy]) before(rows, highNegative, low);
      assert.ok(!rows.some(row => row.id === foreign));
    }
    before(stats.topNegative, highNegative, lowNegative); before(stats.topNegative, highNegative, legacy);
    t.diagnostic(JSON.stringify({kind: 'nullable-report-ranking', total: stats.total,
      firstInteraction: stats.topInteraction[0].id, firstNegative: stats.topNegative[0].id,
      firstSample: stats.sentimentSamples[0].id, knownLikes: stats.topInteraction[0].likes}));
  });

  await t.test('platform, category, keyword and author sums include partial rows instead of dropping them', () => {
    const articles = stats.platform.find(row => row.platform === 'wechat_articles');
    const douyin = stats.platform.find(row => row.platform === 'douyin');
    assert.equal(articles.count, 6); assert.equal(articles.interaction_total, 18050);
    assert.equal(douyin.count, 1); assert.equal(douyin.interaction_total, 40);
    assert.equal(stats.category.find(row => row.category === '服务体验').interaction_total, 18090);
    assert.equal(stats.keyword.find(row => row.keyword === '安吉星').interaction_total, 18090);
    assert.equal(stats.topAuthors.find(row => row.author_name === 'partial-high-negative').interaction_total, 10000);
    assert.equal(stats.topAuthors.find(row => row.author_name === 'unknown-all').interaction_total, 0);
    t.diagnostic(JSON.stringify({kind: 'nullable-platform-sums', articles: 18050, douyin: 40, total: 18090}));
  });

  await t.test('report comment ranking puts unknown likes after seven, three and known zero', () => {
    assert.deepEqual(stats.negativeComments.map(row => row.id), [comments[2].id, comments[3].id, comments[1].id, comments[0].id]);
  });

  const email = `t19-metrics-${randomUUID()}@integration.invalid`, password = 'T19-local-metrics-password';
  const userId = (await query(`INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password)
    VALUES($1,'T19 metrics',$2,'active',false,'',false) RETURNING id`, [email, hashPassword(password)]))[0].id;
  users.push(userId);
  await query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_analyst','active')", [userId, tenantId]);
  server = await new Promise((resolve, reject) => {
    const instance = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1');
    instance.once('error', reject); instance.once('listening', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password})});
  assert.equal(login.status, 200);
  const headers = {authorization: `Bearer ${(await login.json()).token}`, 'x-tenant-id': tenantId};
  const list = async filters => {
    const response = await fetch(`${base}/api/triage/records?${new URLSearchParams({queue: 'triage', pageSize: '100', ...filters})}`, {headers});
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.pagination.total, 7); assert.ok(!body.records.some(row => row.id === foreign)); return body.records;
  };

  await t.test('authenticated risk sorting honors high-negative bucket 1 and high-positive bucket 4', async () => {
    const rows = await list({sort: 'risk'});
    assert.equal(rows[0].id, highNegative);
    // The low rows carry historical negative comments and would win the secondary
    // ordering if a partial high row fell into the same (incorrect) risk bucket.
    before(rows, highNegative, lowNegative); before(rows, highPositive, lowPositive);
    before(rows, lowNegative, highPositive); before(rows, legacy, highPositive);
    t.diagnostic(JSON.stringify({kind: 'nullable-risk-order', highNegativePosition: index(rows, highNegative),
      lowNegativePosition: index(rows, lowNegative), highPositivePosition: index(rows, highPositive), lowPositivePosition: index(rows, lowPositive)}));
  });

  await t.test('authenticated interaction sorts include partial values in both directions and metric sorts keep NULL last', async () => {
    const desc = await list({sort: 'interactions', dir: 'desc'});
    assert.equal(desc[0].id, highNegative); assert.equal(desc[1].id, highPositive);
    for (const low of [lowNegative, lowPositive, zero, unknown, legacy]) before(desc, highNegative, low);
    const asc = await list({sort: 'interactions', dir: 'asc'});
    before(asc, zero, lowNegative); before(asc, unknown, lowNegative); before(asc, highPositive, highNegative);
    assert.equal((await list({sort: 'likes', dir: 'desc'})).at(-1).id, unknown);
    const byComments = await list({sort: 'comments', dir: 'desc'});
    for (const id of [highNegative, highPositive, unknown]) before(byComments, zero, id);
    const partial = desc.find(row => row.id === highNegative);
    assert.equal(partial.likes, 10000); assert.equal(partial.comments_count, null); assert.equal(partial.collects, null); assert.equal(partial.shares, null);
  });

  await t.test('reports and HTTP reads leave raw NULL evidence unchanged in records and comments', async () => {
    for (const {id, metrics} of Object.values(records)) {
      const [row] = await query('SELECT likes,comments_count,collects,shares FROM records WHERE id=$1', [id]);
      assert.deepEqual([row.likes, row.comments_count, row.collects, row.shares], metrics);
    }
    assert.equal((await query('SELECT like_count FROM record_comments WHERE id=$1', [comments[0].id]))[0].like_count, null);
  });
});
