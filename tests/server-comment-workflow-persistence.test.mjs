import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [
  syncSource,
  workflowSource,
  recordStoreSource,
  leaseMigration,
  aiMediaRuntimeSource,
] = await Promise.all([
  readFile(resolve(repoRoot, "server/routes/sync.js"), "utf8"),
  readFile(resolve(repoRoot, "server/services/comment-workflow.js"), "utf8"),
  readFile(resolve(repoRoot, "server/services/record-store.js"), "utf8"),
  readFile(
    resolve(repoRoot, "server/db/migrations/080_comment_workflow_leases.sql"),
    "utf8",
  ),
  readFile(resolve(repoRoot, "server/runtime/ai-media-runtime.js"), "utf8"),
]);

test("sync wakes a bounded database-backed comment drain instead of retaining record closures", () => {
  assert.doesNotMatch(syncSource, /const commentWorkflowQueue = \[\]/u);
  assert.doesNotMatch(syncSource, /commentWorkflowQueue\.push/u);
  assert.match(
    recordStoreSource,
    /CASE WHEN \$9::integer > 0 THEN 'queued' ELSE 'not_required' END/u,
  );
  assert.match(
    syncSource,
    /COMMENT_WORKFLOW_DRAIN_LIMIT = 25[\s\S]*reprocessPendingCommentWorkflowReceipts\([\s\S]*queuedGraceSeconds: 0/u,
  );
  assert.doesNotMatch(syncSource, /do \{[\s\S]*reprocessPendingCommentWorkflowReceipts/u);
  assert.match(
    syncSource,
    /commentWorkflowScheduled[\s\S]*if \(commentWorkflowRunning \|\| commentWorkflowScheduled\) return/u,
  );
});

test("an unknown sync response reuses the exact capture-attempt observation", () => {
  assert.match(
    leaseMigration,
    /source_ingestion_key TEXT[\s\S]*CREATE UNIQUE INDEX IF NOT EXISTS idx_record_observations_source_ingestion_key/u,
  );
  assert.match(
    recordStoreSource,
    /capture-observation:[\s\S]*source_ingestion_key = \$2[\s\S]*reused: true/u,
  );
  assert.match(
    syncSource,
    /!result\.observationReused[\s\S]*!commentStats\.queued/u,
  );
});

test("comment workload capacity is reserved in the observation transaction", () => {
  assert.match(
    recordStoreSource,
    /FROM comment_workflow_capacity_budget[\s\S]*budget_key = 'global'[\s\S]*FOR UPDATE/u,
  );
  assert.match(
    recordStoreSource,
    /pendingCount \+ 1 > maxPending[\s\S]*pendingBytes \+ incomingBytes > maxPendingBytes/u,
  );
  assert.match(
    leaseMigration,
    /CREATE TABLE IF NOT EXISTS comment_workflow_capacity_budget[\s\S]*maintain_comment_workflow_capacity_budget[\s\S]*AFTER INSERT OR DELETE OR UPDATE OF comment_workflow_status, payload/u,
  );
  assert.match(
    syncSource,
    /err\?\.code === 'comment_workflow_capacity'[\s\S]*res\.status\(503\)[\s\S]*retryable: true/u,
  );
});

test("comment receipt recovery claims persisted payload with a stale-worker fence", () => {
  assert.match(
    workflowSource,
    /FROM record_observations observation[\s\S]*JOIN records record/u,
  );
  assert.match(
    workflowSource,
    /comment_workflow_status IN \('queued', 'running', 'failed'\)[\s\S]*comment_workflow_updated_at = \$3::timestamptz[\s\S]*RETURNING id, comment_workflow_claim_token/u,
  );
  assert.match(
    workflowSource,
    /observation\.payload->'items'->0->'commentsCleanedItems'/u,
  );
});

test("comment workers renew an attempt-fenced lease and stale workers cannot settle it", () => {
  assert.match(
    leaseMigration,
    /comment_workflow_claim_token UUID[\s\S]*comment_workflow_lease_expires_at TIMESTAMPTZ[\s\S]*comment_workflow_next_retry_at TIMESTAMPTZ/u,
  );
  assert.match(
    workflowSource,
    /comment_workflow_claim_token = gen_random_uuid\(\)[\s\S]*comment_workflow_lease_expires_at/u,
  );
  assert.match(
    workflowSource,
    /setInterval\([\s\S]*comment_workflow_claim_token = \$3::uuid/u,
  );
  assert.match(
    workflowSource,
    /comment_workflow_status = 'persisted'[\s\S]*comment_workflow_claim_token = \$4::uuid/u,
  );
  assert.match(
    leaseMigration,
    /CREATE TABLE IF NOT EXISTS comment_workflow_processor_leases/u,
  );
  assert.match(
    workflowSource,
    /INSERT INTO comment_workflow_processor_leases[\s\S]*ON CONFLICT \(lease_key\) DO UPDATE[\s\S]*lease_expires_at <= now\(\)/u,
  );
  assert.match(
    workflowSource,
    /COMMENT_WORKFLOW_RECEIPT_BATCH_LIMIT = 25[\s\S]*Math\.min\([\s\S]*COMMENT_WORKFLOW_RECEIPT_BATCH_LIMIT/u,
  );
});

test("legacy startup comment repair shares the global lease and drains gradually", () => {
  assert.match(
    workflowSource,
    /COMMENT_WORKFLOW_LEGACY_REPROCESS_BATCH_LIMIT = 25/u,
  );
  assert.match(
    workflowSource,
    /reprocessPendingCommentsUnderLease\([\s\S]*processorLease\.renew\(\)/u,
  );
  assert.match(
    workflowSource,
    /export async function reprocessPendingComments\(options = \{\}\)[\s\S]*withCommentWorkflowProcessorLease/u,
  );
  assert.match(
    aiMediaRuntimeSource,
    /reprocessPendingComments\(\{ limit: 25 \}\)/u,
  );
  assert.match(
    aiMediaRuntimeSource,
    /scheduleRecurring\([\s\S]*15_000,[\s\S]*60_000,[\s\S]*'Reprocess'/u,
  );
});
