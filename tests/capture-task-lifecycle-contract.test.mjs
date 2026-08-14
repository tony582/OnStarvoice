import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('keyword report exposes Agent and real per-keyword execution stages', () => {
  const source = read('web/admin/src/pages/dispatch/cloud-tasks/KeywordExecutionReport.tsx');
  assert.match(source, /关键词执行情况/u);
  assert.match(source, /搜索结果/u);
  assert.match(source, /已增强/u);
  assert.match(source, /已保存/u);
  assert.match(source, /批次位置/u);
  assert.match(source, /词内位置/u);
  assert.match(source, /detailSuccessCount/u);
  assert.match(source, /syncSuccessCount/u);
});

test('plan archive is reversible and preserves active runs and audit', () => {
  const route = read('server/routes/capture-orchestrations.js');
  const migration = read('server/db/migrations/062_capture_task_lifecycle.sql');
  assert.match(route, /schedule\/archive/u);
  assert.match(route, /schedule\/restore/u);
  assert.match(route, /activeRunsUnaffected: true/u);
  assert.match(route, /orchestration_schedule_archived/u);
  assert.match(route, /orchestration_schedule_restored/u);
  assert.match(migration, /archived_previous_status/u);
  assert.match(migration, /agent_display_name/u);
});

test('history uses an independent paginated server query', () => {
  const server = read('server/routes/capture-cloud.js');
  const client = read('web/admin/src/pages/dispatch/cloud-tasks/HistoryView.tsx');
  assert.match(server, /router\.get\('\/history'/u);
  assert.match(server, /pageSize.*50/u);
  assert.match(server, /COUNT\(\*\)::integer AS total/u);
  assert.match(server, /LIMIT \$\$\{listParams\.length - 1\} OFFSET \$\$\{listParams\.length\}/u);
  assert.match(client, /默认近 30 天/u);
  assert.match(client, /搜索任务名称/u);
  assert.match(client, /历史分页/u);
});

test('retention compacts only raw snapshots and protects durable evidence', () => {
  const retention = read('server/services/capture-task-retention.js');
  assert.match(retention, /DELETE FROM capture_task_snapshots/u);
  assert.doesNotMatch(retention, /DELETE FROM (?:records|record_observations|capture_tasks|capture_task_items|capture_task_events|capture_task_attempts|capture_task_item_attempts)/u);
  assert.match(retention, /row_number\(\) OVER/u);
  assert.match(retention, /WITH RECURSIVE task_tree/u);
  assert.match(retention, /technical_compacted_at/u);
});
