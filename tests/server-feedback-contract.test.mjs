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
  ] = await Promise.all([
    source("server/db/migrations/029_record_feedback_manual_overrides.sql"),
    source("server/routes/triage.js"),
    source("server/routes/feedback.js"),
    source("server/services/ai-labeler.js"),
    source("server/services/record-store.js"),
    source("server/routes/workspace.js"),
    source("server/index.js"),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS record_feedback/);
  assert.match(
    migration,
    /feedback_type <> 'false_positive' OR char_length\(btrim\(reason\)\) > 0/,
  );
  assert.match(migration, /uniq_record_feedback_pending_false_positive/);
  assert.match(triage, /false_positive_batch_not_allowed/);
  assert.match(triage, /误报仅允许后台登录用户提交/);
  assert.match(triage, /pending_feedback_exists/);
  assert.match(feedbackRoute, /router\.use\(requireTenantAccess, requireSessionUser\)/);
  assert.match(feedbackRoute, /summary_note_required/);
  assert.match(feedbackRoute, /identityLabel\(/);
  assert.match(aiLabeler, /manual_overrides, '\{\}'::jsonb\) \? 'sentiment'/);
  assert.match(aiLabeler, /manual_overrides, '\{\}'::jsonb\) \? 'category'/);
  assert.match(aiLabeler, /manual_overrides, '\{\}'::jsonb\) \? 'publish_time'/);
  assert.match(recordStore, /manual_overrides, '\{\}'::jsonb\) \? 'publish_time'/);
  assert.match(workspace, /feedbackPending/);
  assert.match(serverIndex, /app\.use\('\/api\/feedback', feedbackRouter\)/);
});

test("React admin exposes drawer-only reporting and a review queue", async () => {
  const [triage, drawer, notePrompt, feedbackQueue, sidebar] =
    await Promise.all([
      source("web/admin/src/pages/workbench/TriageQueue.tsx"),
      source("web/admin/src/components/shared/RecordDrawer.tsx"),
      source("web/admin/src/components/shared/NotePrompt.tsx"),
      source("web/admin/src/pages/workbench/MisjudgmentQueue.tsx"),
      source("web/admin/src/components/layout/Sidebar.tsx"),
    ]);

  assert.doesNotMatch(triage, /MenuBtn icon=\{Ban\}/);
  assert.doesNotMatch(
    triage,
    /\{ key: 'false_positive', label: '误报'/,
  );
  assert.match(triage, /required: true/);
  assert.match(drawer, /onFalsePositive/);
  assert.match(drawer, /误报\s*<\/Button>/);
  assert.match(drawer, /编辑判断/);
  assert.match(notePrompt, /请填写原因后再确认/);
  assert.match(feedbackQueue, /反馈不会直接触发模型自动学习/);
  assert.match(feedbackQueue, /已纳入总结/);
  assert.match(feedbackQueue, /required: nextStatus === 'summarized'/);
  assert.match(triage, /drawerRecord\.triage_status === 'false_positive'/);
  assert.match(sidebar, /misjudgments.*误判反馈/);
});
