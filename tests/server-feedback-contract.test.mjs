import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {
  buildAiSnapshot,
  normalizeFeedbackReason,
  normalizeReviewStatus,
} from "../server/services/record-feedback.js";
import {
  manualFieldsRecordResponse,
  publishTimestampFromDate,
  validateManualFields,
} from "../server/routes/records.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function source(path) {
  return readFile(resolve(repoRoot, path), "utf8");
}

test("false-positive feedback requires a non-blank bounded reason", () => {
  assert.equal(
    normalizeFeedbackReason("   ", {required: true}).error,
    "reason_required",
  );
  assert.equal(
    normalizeFeedbackReason("x".repeat(2001), {required: true}).error,
    "reason_too_long",
  );
  assert.deepEqual(
    normalizeFeedbackReason("  AI 把无关内容判成相关  ", {required: true}),
    {ok: true, value: "AI 把无关内容判成相关"},
  );
});

test("manual record fields use a strict whitelist and validated values", () => {
  const valid = validateManualFields({
    sentiment: "neutral",
    category: "brand_image",
    identityOverride: "user",
    publishTime: "2026-07-03",
    reason: "人工复核",
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.providedFields, [
    "sentiment",
    "category",
    "identityOverride",
    "publishTime",
  ]);

  const withoutReason = validateManualFields({sentiment: "positive"});
  assert.equal(withoutReason.ok, true);
  assert.equal(withoutReason.reason, "");

  assert.equal(
    validateManualFields({publishTime: "2026-02-30"}).error,
    "invalid_publish_time",
  );
  assert.equal(
    validateManualFields({sentiment: "mixed"}).error,
    "invalid_sentiment",
  );
  assert.equal(
    validateManualFields({tenantId: "must-not-come-from-body"}).error,
    "unsupported_fields",
  );
});

test("manual publish dates are normalized to Shanghai midnight", () => {
  assert.equal(
    publishTimestampFromDate("2026-07-03"),
    "2026-07-02T16:00:00.000Z",
  );
  assert.equal(publishTimestampFromDate(""), null);
});

test("manual field mutations return a lightweight record projection", () => {
  const record = manualFieldsRecordResponse({
    id: "record-1",
    sentiment: "neutral",
    category: "renewal_billing",
    identity_override: "koe",
    publish_time: "2026-08-03",
    published_ts: "2026-08-02T16:00:00.000Z",
    created_at: "2026-08-03T08:00:00.000Z",
    manual_updated_name: "复核人员",
    manual_updated_at: "2026-08-04T05:15:00.851Z",
    updated_at: "2026-08-04T05:15:00.851Z",
    payload: {raw: "x".repeat(80_000)},
    ai_result: {summary: "y".repeat(20_000)},
    image_urls: ["https://example.com/large-image"],
    manual_overrides: {sentiment: {reason: "large internal metadata"}},
  });

  assert.equal(record.sentiment, "neutral");
  assert.equal(record.publish_display, "2026-08-03");
  assert.equal(Object.hasOwn(record, "payload"), false);
  assert.equal(Object.hasOwn(record, "ai_result"), false);
  assert.equal(Object.hasOwn(record, "image_urls"), false);
  assert.equal(Object.hasOwn(record, "manual_overrides"), false);
  assert.ok(Buffer.byteLength(JSON.stringify({ok: true, record})) < 1_024);
});

test("feedback review statuses cover the human review lifecycle", () => {
  for (const status of ["pending", "reviewed", "summarized", "dismissed"]) {
    assert.equal(normalizeReviewStatus(status), status);
  }
  assert.equal(normalizeReviewStatus("auto_learned"), "");
});

test("AI snapshots keep the original model judgment after manual overrides", () => {
  const snapshot = buildAiSnapshot({
    ai_result: {
      sentiment: "negative",
      category: "app_issue",
      sourceType: "pgc",
      summary: "原始 AI 判断",
      confidence: 0.88,
    },
    sentiment: "positive",
    category: "brand_image",
    source_type: "ugc",
    ai_summary: "人工后的展示值",
  });
  assert.equal(snapshot.sentiment, "negative");
  assert.equal(snapshot.category, "app_issue");
  assert.equal(snapshot.source_type, "pgc");
  assert.equal(snapshot.ai_summary, "原始 AI 判断");
});

test("backend contracts persist feedback and protect manual overrides", async () => {
  const [
    migration,
    triage,
    feedbackRoute,
    aiLabeler,
    recordStore,
    workspace,
    serverIndex,
    recordsRoute,
    drawer,
    feedbackOnlyMigration,
  ] = await Promise.all([
    source("server/db/migrations/029_record_feedback_manual_overrides.sql"),
    source("server/routes/triage.js"),
    source("server/routes/feedback.js"),
    source("server/services/ai-labeler.js"),
    source("server/services/record-store.js"),
    source("server/routes/workspace.js"),
    source("server/index.js"),
    source("server/routes/records.js"),
    source("web/admin/src/components/shared/RecordDrawer.tsx"),
    source("server/db/migrations/038_false_positive_feedback_only.sql"),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS record_feedback/);
  assert.match(
    migration,
    /feedback_type <> 'false_positive' OR char_length\(btrim\(reason\)\) > 0/,
  );
  assert.match(migration, /uniq_record_feedback_pending_false_positive/);
  assert.match(triage, /false_positive_is_feedback_only/);
  assert.doesNotMatch(triage, /insertRecordFeedback/);
  assert.match(feedbackRoute, /router\.use\(requireTenantAccess, requireSessionUser\)/);
  assert.match(feedbackRoute, /router\.post\('\/false-positive', requireTenantWriter/);
  assert.match(feedbackRoute, /correctedValues: originalValues/);
  assert.match(feedbackRoute, /record\.false_positive_reported/);
  assert.match(feedbackRoute, /flowUnchanged: true/);
  assert.match(feedbackRoute, /router\.use\(requirePlatformAdmin\)/);
  assert.match(feedbackRoute, /pending_feedback_exists/);
  assert.match(feedbackRoute, /ELSE \$5::uuid END/);
  assert.match(feedbackRoute, /只表示“已保存复核记录”，不会调用或投喂任何 AI/);
  const reviewRoute = feedbackRoute.slice(
    feedbackRoute.indexOf("router.patch('/:id'"),
    feedbackRoute.indexOf('export default router'),
  );
  assert.match(reviewRoute, /UPDATE record_feedback/);
  assert.match(reviewRoute, /INSERT INTO audit_logs/);
  assert.doesNotMatch(reviewRoute, /fetch\s*\(|labelRecord\s*\(|labelPendingRecords\s*\(|openai|deepseek/i);
  assert.match(feedbackRoute, /summary_note_required/);
  assert.match(feedbackRoute, /identityLabel\(/);
  assert.match(aiLabeler, /manual_overrides, '\{\}'::jsonb\) \? 'sentiment'/);
  assert.match(aiLabeler, /manual_overrides, '\{\}'::jsonb\) \? 'category'/);
  assert.match(aiLabeler, /manual_overrides, '\{\}'::jsonb\) \? 'publish_time'/);
  assert.match(recordStore, /manual_overrides, '\{\}'::jsonb\) \? 'publish_time'/);
  assert.doesNotMatch(recordStore, /sentiment\s*=/);
  assert.doesNotMatch(recordStore, /category\s*=/);
  assert.doesNotMatch(recordStore, /identity_override\s*=/);
  assert.match(recordsRoute, /router\.get\('\/:id\/manual-history'/);
  assert.match(recordsRoute, /router\.get\('\/:id\/manual-fields'/);
  assert.match(recordsRoute, /feedback_type = 'manual_correction'/);
  assert.match(recordsRoute, /record: manualFieldsRecordResponse\(result\.record\)/);
  assert.match(recordsRoute, /router\.get\('\/:id\/activity'/);
  assert.match(drawer, /\/activity/);
  assert.match(workspace, /feedbackPending/);
  assert.match(workspace, /global_role === 'platform_admin'/);
  assert.match(serverIndex, /app\.use\('\/api\/feedback', feedbackRouter\)/);
  assert.match(feedbackOnlyMigration, /WHERE status = 'false_positive'/);
  assert.match(feedbackOnlyMigration, /original_values->>'triage_status'/);
  assert.doesNotMatch(
    feedbackOnlyMigration.match(/ADD CONSTRAINT record_triage_status_check[\s\S]*$/)?.[0] || '',
    /false_positive/,
  );
});

test("React admin exposes drawer-only reporting and a review queue", async () => {
  const [triage, drawer, notePrompt, feedbackQueue, sidebar, workbench, mobile, apiClient] =
    await Promise.all([
      source("web/admin/src/pages/workbench/TriageQueue.tsx"),
      source("web/admin/src/components/shared/RecordDrawer.tsx"),
      source("web/admin/src/components/shared/NotePrompt.tsx"),
      source("web/admin/src/pages/workbench/MisjudgmentQueue.tsx"),
      source("web/admin/src/components/layout/Sidebar.tsx"),
      source("web/admin/src/pages/WorkbenchPage.tsx"),
      source("web/admin/src/mobile/MobileApp.tsx"),
      source("web/admin/src/lib/api.ts"),
    ]);

  assert.doesNotMatch(triage, /MenuBtn icon=\{Ban\}/);
  assert.doesNotMatch(
    triage,
    /\{ key: 'false_positive', label: '误报'/,
  );
  assert.match(triage, /required: true/);
  assert.match(triage, /api\.post\('\/feedback\/false-positive', \{ recordId, reason \}\)/);
  assert.doesNotMatch(triage, /status: 'false_positive'/);
  const submitAction = triage.slice(
    triage.indexOf('const markFalsePositive'),
    triage.indexOf('const updateManualFields'),
  );
  assert.match(submitAction, /false_positive_pending: true/);
  assert.match(submitAction, /refreshBadges\(\)/);
  assert.doesNotMatch(submitAction, /reloadAfterMutation|setDrawerRecord\(null\)/);
  assert.match(drawer, /onFalsePositive/);
  assert.match(drawer, /falsePositivePending/);
  assert.match(drawer, /误报已提交，等待平台管理员复核/);
  assert.match(drawer, /aria-label=\{falsePositivePending \? '误报已提交' : '提交误报'\}/);
  assert.match(drawer, /record\.false_positive_reported/);
  assert.match(drawer, /编辑判断/);
  assert.match(drawer, /处理记录/);
  assert.doesNotMatch(drawer, /修改说明/);
  assert.match(drawer, /document\.addEventListener\('mousedown'/);
  assert.match(drawer, /panelRef\.current\?\.contains\(target\)/);
  assert.match(drawer, /data-record-detail-trigger/);
  assert.match(drawer, /loadedRecordId !== r\.id/);
  assert.match(triage, /data-record-detail-trigger/);
  const manualUpdateAction = triage.slice(
    triage.indexOf('const updateManualFields'),
    triage.indexOf('const updateCustomTags'),
  );
  assert.match(manualUpdateAction, /isApiNetworkError/);
  assert.match(manualUpdateAction, /verifyManualFieldsSaved/);
  assert.match(manualUpdateAction, /void reloadAfterMutation\(\)/);
  assert.doesNotMatch(manualUpdateAction, /await reloadAfterMutation\(\)/);
  assert.match(apiClient, /class ApiNetworkError extends Error/);
  assert.match(apiClient, /网络连接中断，请检查网络后重试/);
  assert.doesNotMatch(triage, /<RecordDrawer key=/);
  assert.match(notePrompt, /请填写原因后再确认/);
  assert.match(feedbackQueue, /仅作为内部记录，不会发送给 AI/);
  assert.match(feedbackQueue, /已记录/);
  assert.match(feedbackQueue, /保存记录/);
  assert.doesNotMatch(feedbackQueue, /纳入总结|提供给 AI|直接触发模型自动学习/);
  assert.match(feedbackQueue, /required: nextStatus === 'summarized'/);
  assert.doesNotMatch(triage, /drawerRecord\.triage_status === 'false_positive'/);
  assert.match(sidebar, /misjudgments.*误判反馈.*platformAdmin: true/);
  assert.match(workbench, /requestedQueue === 'misjudgments' && !isPlatformAdmin\(\)/);
  assert.match(mobile, /isPlatformAdmin\(\) \? badges\.feedbackPending : 0/);
});
