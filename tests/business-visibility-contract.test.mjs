import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('0.4 migration keeps filtered and deferred records audit-visible but out of business views', () => {
  const migration = source('server/db/migrations/078_relevance_disposition_v2.sql');
  assert.match(migration, /business_visibility TEXT NOT NULL DEFAULT 'eligible'/u);
  assert.match(migration, /'eligible', 'filtered_out', 'deferred'/u);
  assert.match(migration, /parent_decision_id UUID/u);
  assert.match(migration, /execution_disposition = 'defer_enhancement'/u);
  assert.match(migration, /Only explicit legacy decisions are projected/u);
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+records/iu);
});

test('business-facing queues, dashboards, reports and AI workers require eligible records', () => {
  const triage = source('server/routes/triage.js');
  const workspace = source('server/routes/workspace.js');
  const negativePatrol = source('server/routes/negative-patrol.js');
  const leads = source('server/routes/leads.js');
  const report = source('server/services/report-generator.js');
  const aiLabeler = source('server/services/ai-labeler.js');
  const aiFailover = source('server/services/ai-failover.js');
  const alertEngine = source('server/services/alert-engine.js');
  const recordStore = source('server/services/record-store.js');

  assert.ok((triage.match(/business_visibility = 'eligible'/gu) || []).length >= 4);
  assert.ok((workspace.match(/business_visibility = 'eligible'/gu) || []).length >= 10);
  assert.ok((negativePatrol.match(/business_visibility = 'eligible'/gu) || []).length >= 2);
  assert.match(leads, /business_visibility <> 'eligible'/u);
  assert.match(report, /r\.business_visibility = 'eligible'/u);
  assert.match(report, /business_visibility = 'eligible'/u);
  assert.match(aiLabeler, /record\.business_visibility !== 'eligible'/u);
  assert.match(aiLabeler, /AND business_visibility = 'eligible'/u);
  assert.match(aiFailover, /AND business_visibility = 'eligible'/u);
  assert.match(alertEngine, /record\.business_visibility !== 'eligible'/u);
  assert.match(recordStore, /if \(__result\.businessVisibility === 'eligible'\)/u);
});
