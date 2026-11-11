# 哨兵准入时间界线与分诊显示

基线：生产 T19 `2d4fd3fe0d8952dbf5581d86e0be3d20cfc95745`。本轮不改手机、采集计划、AI 提示词或数据库结构。

## 最终行为

- `records.created_at >= SENTRY_SCOPE_RETIRED_AT` 的内容按普通关键词准入。相关和 uncertain 仍受原有业务可见性及分诊查询条件限制；irrelevant 不进入待处理。时间之前继续旧规则，缺失/非法时间不意外放行。JS 与 PostgreSQL 使用同一 UTC 界线。
- `server/config/sentry-admission.json` 的仓库默认值为空，保持旧规则。部署时记录实际 UTC 切换时刻，安装配置后依次重启 API、scheduler，逐个确认就绪。这个配置是持久生产配置，后续发布不得用仓库空值覆盖，不能以进程启动时间重置界线。可选绝对路径环境变量仅供隔离测试或明确配置；发布前核对两进程配置路径。
- 不删除 `SENTRY_SCOPE_KEYWORDS`、`recordSentryScopeSql`、`recordMainPostEvidenceSql`，不改负面巡查和 AI 证据分析。新规则范围内显示 `not_applicable`，隐藏旧 AI 品牌证据提示。
- 派生 `triage_display_status/reason` 区分未准入、待处理、关注但不计待处理；不改存储状态。已复核/归档保持真实状态。详情优先最新归档值（含 null），不被旧同发摘要覆盖。概览待处理复用 ACTIVE_QUEUE_CONDITION。没有人工纳入按钮。

## 生产只读试算（2026-11-11 19:12）

安吉星最近 30 天，不加界线会多 747 条历史记录；加界线为 0；仅用户指定两条为 2。分平台为抖音 469、小红书 278；分关键词：抖音 ibuick 2、别克哨兵 251、别克壁纸 1、至境哨兵 215；小红书别克哨兵 220、至境哨兵 58。主关键词非哨兵的记录由历史观察关键词命中。

历史工作列表 10405 条，历史待处理 0 条。两条目标初始 manual_overrides 均为空，没有分诊行，AI 相关性分别为 relevant、uncertain。试算时间不是最终上线时间，正式执行必须以当次切换配置为准再核对。

## 精确生产写入与回滚

仅 d5ef58a6-8087-4149-9b4e-184dd5ce5481 和 ef9b52dc-469c-4a8a-a32c-cb92aa697132 设置现有 triage_admission included。事务内锁定两条记录、先备份原覆盖及全行非覆盖摘要、记录系统审计“哨兵准入规则调整，用户指定纳入”，再验证仅两条历史列表/待处理增加。相关性、分诊状态和分诊行不变。同发抖音状态不复制。精确回滚按审计前后值比较，拒绝覆盖后续人工修改，并另记回滚审计。

API、scheduler 顺序重启已获用户明确授权；ai-media 不重启。只发布 7 个服务端 JS、1 个激活配置和后台，静态资源先放、index 最后切换。禁止 19:30–23:00 发布；最后五分钟不启动新发布。完整线上结果见 output/sentry-admission 发布报告，不以本地测试代替上线证明。

## 本地验证

- 核心单元 18/18；准入及日报 PostgreSQL 7/7（包含 262 别名、12 边界、101 HTTP 夹具）；既有断言修改 0 条。
- 显示单元与契约 42/42；显示 PostgreSQL 3/3（12 条夹具）、同发回归 9/9；桌面 1440×1050 和移动 390×844 实际离线浏览器通过。
- 兼容性修复后前端辅助测试 11/11，TypeScript + Vite 构建通过。第一次 Object.hasOwn 不兼容既有编译目标，已改用 hasOwnProperty.call。
- 精确覆盖/回滚脚本在隔离 PostgreSQL 实测：纳入 2、审计 2、历史待处理 +2；回滚恢复 2，追加审计 2。生产尚未写入时不声称完成。
- 全量回归、lint 基线、CI 和发布实测结果另存本轮证据目录。普通受限环境本机监听 EPERM 的测试结果不算通过，以获准监听本机后的完整执行为准。

## 改动前引用清单（114 行）

```text
server/services/ai-labeler.js:46:  formatGmAliasesForPrompt, getRecordEvidenceSources, isSentryEvidenceScope, normalizeJudgmentConfidence, normalizeMonitoringEvidence, normalizePostIntent,
server/services/ai-labeler.js:131:${isSentryEvidenceScope({ keyword: intent.keyword }) ? `${formatGmAliasesForPrompt()}
server/services/ai-labeler.js:1313:    const scoped = isSentryEvidenceScope({ ...current, observed_keywords: observedKeywords });
tests/watched-content-patrol.test.mjs:72:    /AND \(\$\{recordTriageAdmissionSql\('r'\)\}\)\s+AND \(/u,
server/services/record-content-judgment.js:8:export const SENTRY_SCOPE_KEYWORDS = ['别克哨兵', '至境哨兵', '凯迪拉克哨兵', '雪佛兰哨兵', '通用哨兵'];
server/services/record-content-judgment.js:113:export function isSentryEvidenceScope(record = {}) {
server/services/record-content-judgment.js:117:    return SENTRY_SCOPE_KEYWORDS.some(term => keyword.includes(term));
server/services/record-triage-admission.js:4:  POST_HASHTAG_PATTERN, SENTRY_SCOPE_KEYWORDS, MONITORING_EVIDENCE_VERSION,
server/services/record-triage-admission.js:5:  findRecordMonitoringEvidence, isSentryEvidenceScope, normalizeMonitoringEvidence, normalizePostIntent, POST_INTENTS,
server/services/record-triage-admission.js:52:export function recordTriageAdmission(record = {}) {
server/services/record-triage-admission.js:53:  const scoped = isSentryEvidenceScope(record);
server/services/record-triage-admission.js:86:export function recordSentryScopeSql(alias = 'r') {
server/services/record-triage-admission.js:88:  const pattern = literal(SENTRY_SCOPE_KEYWORDS.join('|'));
server/services/record-triage-admission.js:120:export function recordMainPostEvidenceSql(alias = 'r') {
server/services/record-triage-admission.js:151:export function recordTriageAdmissionSql(alias = 'r') {
server/services/record-triage-admission.js:154:  return `(COALESCE(${manualRecordAdmissionSql(a)},false) OR NOT ${recordSentryScopeSql(a)} OR (${reviewRequested}) OR CASE WHEN ${manualRecordRelevanceSql(a)} IS NOT NULL THEN ${manualRecordRelevanceSql(a)} = 'relevant' ELSE COALESCE(${a}.ai_result->>'relevance' = 'relevant',false) AND ${recordMainPostEvidenceSql(a)} END)`;
server/services/record-triage-admission.js:157:export function recordAdmissionSelectSql(alias = 'r', { admitted = null } = {}) {
server/services/record-triage-admission.js:160:  const allowed = typeof admitted === 'boolean' ? String(admitted) : recordTriageAdmissionSql(alias);
server/services/record-triage-admission.js:161:  return `${recordSentryScopeSql(alias)} AS admission_scoped, ${allowed} AS admission_allowed`;
server/services/record-triage-admission.js:164:export function withRecordAdmissionFields(record = {}) {
server/services/record-triage-admission.js:169:  const computed = admission_scoped === undefined ? recordTriageAdmission(record) : {
server/services/record-triage-admission.js:197:  const value = withRecordAdmissionFields(record);
tests/record-triage-admission.test.mjs:3:import { appendRecordIntentFilter, recordJudgmentExportFields, recordTriageAdmission, withRecordAdmissionFields } from '../server/services/record-triage-admission.js';
tests/record-triage-admission.test.mjs:10:  assert.equal(recordTriageAdmission(uncertain).admitted, false, 'unrequested uncertain posts keep existing admission');
tests/record-triage-admission.test.mjs:11:  assert.deepEqual(recordTriageAdmission(requested), { admitted: true, scoped: true, relevance: 'uncertain', monitoring_evidence_status: 'needs_review' });
tests/record-triage-admission.test.mjs:13:    const projected = withRecordAdmissionFields(input);
tests/record-triage-admission.test.mjs:22:    assert.equal(recordTriageAdmission({ ...uncertain, manual_overrides: { triage_review } }).admitted, false);
tests/record-triage-admission.test.mjs:24:  assert.equal(recordTriageAdmission({ ...requested, ai_result: { relevance: 'irrelevant' } }).admitted, false, 'a later irrelevant judgment still excludes the post');
tests/record-triage-admission.test.mjs:25:  assert.equal(recordTriageAdmission({ ...requested, manual_overrides: { ...requested.manual_overrides, relevance: 'irrelevant' } }).admitted, false, 'human irrelevance takes priority');
tests/record-triage-admission.test.mjs:26:  assert.equal(recordTriageAdmission({ ...requested, manual_overrides: { triage_review: { value: 'canceled' } } }).admitted, false, 'the workflow request is reversible');
tests/record-triage-admission.test.mjs:30:  assert.equal(recordTriageAdmission(post).admitted, false);
tests/record-triage-admission.test.mjs:31:  assert.equal(recordTriageAdmission({ ...post, author_name: '别克车主', tags: ['别克'], content: '#别克哨兵 很方便' }).admitted, false);
tests/record-triage-admission.test.mjs:32:  assert.equal(recordTriageAdmission({ ...post, title: 'CT50的使用说明' }).admitted, true);
tests/record-triage-admission.test.mjs:33:  assert.equal(recordTriageAdmission({ ...post, title: '我的 CT5 哨兵功能' }).admitted, true);
tests/record-triage-admission.test.mjs:34:  assert.equal(recordTriageAdmission({
tests/record-triage-admission.test.mjs:39:  assert.equal(recordTriageAdmission({ ...post, keyword: '至境哨兵别克壁纸', title: 'CT5求救经历' }).admitted, true);
tests/record-triage-admission.test.mjs:40:  assert.equal(recordTriageAdmission({ ...post, keyword: '哨兵模式' }).admitted, true);
tests/record-triage-admission.test.mjs:41:  assert.equal(recordTriageAdmission({ ...post, keyword: '壁纸', observed_keywords: ['凯迪拉克哨兵'] }).admitted, false);
tests/record-triage-admission.test.mjs:42:  assert.equal(recordTriageAdmission({ ...post, manual_overrides: { relevance: { value: 'relevant' } } }).admitted, true);
tests/record-triage-admission.test.mjs:43:  assert.equal(recordTriageAdmission({ ...post, manual_overrides: { relevance: 'irrelevant' } }).admitted, false);
tests/record-triage-admission.test.mjs:44:  assert.equal(recordTriageAdmission({ ...post, manual_overrides: { relevance: 'uncertain' }, title: 'CT5体验' }).admitted, false);
tests/record-triage-admission.test.mjs:49:  assert.equal(recordTriageAdmission({ ...post, title: 'CT5车主', ai_result }).admitted, true);
tests/record-triage-admission.test.mjs:50:  assert.equal(recordTriageAdmission({ ...post, title: '别克车主', ai_result }).admitted, true);
tests/record-triage-admission.test.mjs:51:  assert.equal(recordTriageAdmission({ ...post, title: 'CT50的哨兵功能演示', ai_result: { relevance: 'relevant', monitoringEvidence: { status: 'confirmed', evidence: [{ source: 'title', quote: 'CT5' }] } } }).admitted, true, 'a cropped quote does not negate the vehicle clue in the complete post');
tests/record-triage-admission.test.mjs:52:  assert.equal(recordTriageAdmission({ ...post, title: 'CT5车主', ai_result: { ...ai_result, monitoringEvidence: { status: 'needs_review', evidence: [{ source: 'title', quote: 'CT5车主' }] } } }).admitted, true);
tests/record-triage-admission.test.mjs:53:  for (const title of ['L7哨兵模式怎么开', 'E5驻车监控异常']) assert.equal(recordTriageAdmission({ ...post, title }).admitted, true);
tests/record-triage-admission.test.mjs:54:  for (const relevance of ['uncertain','irrelevant']) assert.equal(recordTriageAdmission({ ...post, title: '理想L7哨兵模式', ai_result: { relevance } }).admitted, false);
tests/record-triage-admission.test.mjs:55:  assert.equal(recordTriageAdmission({ ...post, ai_result }).admitted, false, 'an old model quote alone cannot provide missing source evidence');
tests/record-triage-admission.test.mjs:57:  assert.equal(recordTriageAdmission(transcript).admitted, false);
tests/record-triage-admission.test.mjs:58:  assert.equal(recordTriageAdmission({ ...transcript, transcript_source_url: transcript.video_url }).admitted, true);
tests/record-triage-admission.test.mjs:67:  assert.equal(withRecordAdmissionFields({ intent: 'suggestion' }).intent_display, 'other');
tests/record-triage-admission.test.mjs:68:  for (const intent of ['', null, 'bogus']) assert.equal(withRecordAdmissionFields({ intent }).intent_display, null);
tests/record-triage-admission.test.mjs:69:  const projected = withRecordAdmissionFields(post);
tests/record-triage-admission.test.mjs:85:  assert.equal(withRecordAdmissionFields(source).intent_display, 'advertising');
tests/record-triage-admission.test.mjs:89:    assert.equal(withRecordAdmissionFields(legacy).intent_display, 'other');
tests/record-triage-admission.test.mjs:99:  const projected = withRecordAdmissionFields(original);
tests/record-triage-admission.test.mjs:105:  const mediaOnly = withRecordAdmissionFields({ ...post, admission_scoped: true, admission_allowed: true, ai_result: original.ai_result });
tests/record-triage-admission.test.mjs:113:    assert.equal(recordTriageAdmission({ ...post, title }).admitted, true, title);
tests/record-triage-admission.test.mjs:116:    assert.equal(recordTriageAdmission({ ...post, title }).admitted, false, title);
tests/record-triage-admission.test.mjs:119:  const evidence = withRecordAdmissionFields(original).ai_result.monitoringEvidence.evidence;
tests/record-triage-admission.test.mjs:131:  ]) assert.equal(recordTriageAdmission({ ...post, ...fields }).admitted, true, JSON.stringify(fields));
tests/record-triage-admission.test.mjs:141:  ]) assert.equal(recordTriageAdmission({ ...post, ...fields }).admitted, false, JSON.stringify(fields));
tests/record-triage-admission.test.mjs:148:  assert.equal(recordTriageAdmission({ ...post, title }).admitted, false, 'test model is intentionally absent from the local dictionary');
tests/record-triage-admission.test.mjs:149:  assert.equal(recordTriageAdmission(make()).admitted, true);
tests/record-triage-admission.test.mjs:150:  const projected = withRecordAdmissionFields(make());
tests/record-triage-admission.test.mjs:158:  ]) assert.equal(recordTriageAdmission(make(item)).admitted, false, JSON.stringify(item));
tests/record-triage-admission.test.mjs:159:  assert.equal(recordTriageAdmission(make(candidate, { title: '#星穹Z9 哨兵体验' })).admitted, false);
tests/record-triage-admission.test.mjs:162:    assert.equal(recordTriageAdmission(make({ ...candidate, quote: text, entity }, { title: text })).admitted, false, entity);
tests/record-triage-admission.test.mjs:165:    assert.equal(recordTriageAdmission(make({ ...candidate, quote: text, entity: 'ZX9' }, { title: text })).admitted, false, text);
tests/record-triage-admission.test.mjs:168:  assert.equal(recordTriageAdmission(make({ ...candidate, quote: repeated, entity: 'ZX9' }, { title: repeated })).admitted, true);
tests/record-triage-admission.test.mjs:171:    assert.equal(recordTriageAdmission(value).admitted, false);
tests/record-triage-admission-override.test.mjs:3:import {manualRecordAdmission, manualRecordAdmissionSql, recordTriageAdmission, recordTriageAdmissionSql, withRecordAdmissionFields} from '../server/services/record-triage-admission.js';
tests/record-triage-admission-override.test.mjs:9:  const excluded = recordTriageAdmission(sentryPost());
tests/record-triage-admission-override.test.mjs:12:  const included = recordTriageAdmission(sentryPost({triage_admission: {value: 'included', reason: '按 9 月日报对齐'}}));
tests/record-triage-admission-override.test.mjs:19:  assert.equal(recordTriageAdmission(sentryPost({triage_admission: {value: 'included'}, relevance: {value: 'relevant'}})).monitoring_evidence_status, 'manual_confirmed', 'a manual relevance decision still wins');
tests/record-triage-admission-override.test.mjs:24:  assert.ok(recordTriageAdmissionSql('r').startsWith(`(COALESCE(${manualRecordAdmissionSql('r')},false) OR NOT `));
tests/record-triage-admission-override.test.mjs:26:  const fromSql = withRecordAdmissionFields({...sentryPost({triage_admission: {value: 'included', reason: '按 9 月日报对齐'}}), admission_scoped: true, admission_allowed: true});
tests/record-triage-admission-override.test.mjs:32:  const computed = withRecordAdmissionFields(sentryPost({triage_admission: {value: 'included'}}));
tests/integration/postgres/record-triage-admission.integration.mjs:10:import { recordTriageAdmissionSql, recordTriageAdmission } from '../../../server/services/record-triage-admission.js';
tests/integration/postgres/record-triage-admission.integration.mjs:167:  const sqlRows = (await pool.query(`SELECT r.*, ${recordTriageAdmissionSql('r')} AS admitted FROM records r WHERE tenant_id=$1`, [tenant])).rows;
tests/integration/postgres/record-triage-admission.integration.mjs:169:    const js = recordTriageAdmission({ ...row, observed_keywords: fixtures.get(row.external_id).observed_keywords });
tests/integration/postgres/record-triage-admission.integration.mjs:202:  const parityRows = (await pool.query(`SELECT r.*,${recordTriageAdmissionSql('r')} AS admitted FROM jsonb_populate_recordset(NULL::records,$1::jsonb) r`, [JSON.stringify(parityInput)])).rows;
tests/integration/postgres/record-triage-admission.integration.mjs:205:    assert.equal(recordTriageAdmission(row).admitted, expected, `${row.external_id}: JS`);
tests/record-content-judgment.test.mjs:9:  isSentryEvidenceScope,
tests/record-content-judgment.test.mjs:99:    assert.equal(isSentryEvidenceScope({ keyword }), true, keyword);
tests/record-content-judgment.test.mjs:101:  assert.equal(isSentryEvidenceScope({ keyword: '别克壁纸', observed_keywords: ['其他', '至境哨兵'] }), true);
tests/record-content-judgment.test.mjs:102:  assert.equal(isSentryEvidenceScope({ keyword: '别克壁纸', title: '别克哨兵', content: '至境哨兵' }), false);
tests/record-content-judgment.test.mjs:104:    assert.equal(isSentryEvidenceScope({ keyword }), false, keyword);
server/services/customer-daily-triage-scope.js:1:import {recordTriageAdmissionSql, recordEffectiveRelevanceSql} from './record-triage-admission.js';
server/services/customer-daily-triage-scope.js:12:  AND r.business_visibility = 'eligible' AND (${recordTriageAdmissionSql('r')})
server/services/customer-daily-report-data.js:7:import {recordEffectiveRelevanceSql, recordTriageAdmissionSql} from './record-triage-admission.js';
server/services/customer-daily-report-data.js:254:      AND ${triageHandling ? CUSTOMER_ACTIVE_TRIAGE_SQL : `${POST_SQL} AND r.business_visibility = 'eligible' AND (${recordTriageAdmissionSql('r')})
server/routes/triage.js:31:  recordTriageAdmissionSql, recordEffectiveRelevanceSql,
server/routes/triage.js:32:  recordAdmissionSelectSql, withRecordAdmissionFields,
server/routes/triage.js:163:  AND (${recordTriageAdmissionSql('r')})
server/routes/triage.js:173:  AND (${recordTriageAdmissionSql('r')})
server/routes/triage.js:659:      where += ` AND (${recordTriageAdmissionSql('r')})`;
server/routes/triage.js:725:        ${recordAdmissionSelectSql('r', { admitted: true })},
server/routes/triage.js:819:    const publicRecords = records.map(({ matched_total: _matchedTotal, ...record }) => redactXhsRecordNavigation(withRecordAdmissionFields({
server/routes/triage.js:1453:      where += ` AND (${recordTriageAdmissionSql('r')})`;
server/routes/triage.js:1498:        ${recordAdmissionSelectSql('r', { admitted: true })},
server/routes/workspace.js:14:import { recordTriageAdmissionSql } from '../services/record-triage-admission.js';
server/routes/workspace.js:157:        AND (${recordTriageAdmissionSql('r')})
server/routes/workspace.js:189:      WHERE tenant_id = $1 AND business_visibility = 'eligible' AND (${recordTriageAdmissionSql('records')})
server/routes/workspace.js:223:        AND (${recordTriageAdmissionSql('r')})
server/routes/workspace.js:235:           AND (${recordTriageAdmissionSql('observed_record')})
server/routes/workspace.js:289:        AND (${recordTriageAdmissionSql('r')})
server/routes/workspace.js:304:      WHERE tenant_id = $1 AND business_visibility = 'eligible' AND (${recordTriageAdmissionSql('records')})
server/routes/workspace.js:314:      WHERE tenant_id = $1 AND business_visibility = 'eligible' AND (${recordTriageAdmissionSql('records')}) AND created_at >= $2
server/routes/workspace.js:323:      WHERE tenant_id = $1 AND business_visibility = 'eligible' AND (${recordTriageAdmissionSql('records')})
server/routes/workspace.js:379:        AND (${recordTriageAdmissionSql('r')})
server/routes/workspace.js:392:      WHERE tenant_id = $1 AND business_visibility = 'eligible' AND (${recordTriageAdmissionSql('records')})
server/routes/workspace.js:440:      WHERE tenant_id = $1 AND business_visibility = 'eligible' AND (${recordTriageAdmissionSql('records')})
server/routes/workspace.js:449:      WHERE tenant_id = $1 AND business_visibility = 'eligible' AND (${recordTriageAdmissionSql('records')})
```
