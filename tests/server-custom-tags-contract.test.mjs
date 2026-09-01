import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_CUSTOM_TAG_BATCH_RECORDS,
  MAX_CUSTOM_TAG_NAME_LENGTH,
  MAX_CUSTOM_TAGS_PER_RECORD,
  applyRecordCustomTagBatch,
  appendCustomTagFilter,
  normalizeCustomTagId,
  normalizeCustomTagFilter,
  normalizeCustomTagName,
  planRecordCustomTagBatch,
  validateCustomTagBatch,
  validateCustomTagPatch,
} from '../server/services/record-custom-tags.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function source(path) {
  return readFile(resolve(repoRoot, path), 'utf8');
}

test('custom tag names normalize independently from platform hashtags', () => {
  assert.equal(MAX_CUSTOM_TAG_NAME_LENGTH, 24);
  assert.deepEqual(normalizeCustomTagName('  ## 重点　跟进  '), {
    ok: true,
    name: '重点 跟进',
    normalizedName: '重点 跟进',
  });
  assert.deepEqual(normalizeCustomTagName('  VIP User  '), {
    ok: true,
    name: 'VIP User',
    normalizedName: 'vip user',
  });
  assert.equal(normalizeCustomTagName('###').error, 'tag_name_required');
  assert.equal(normalizeCustomTagName('标'.repeat(25)).error, 'tag_name_too_long');
});

test('custom tag patch inputs are strict, deduplicated and UUID validated', () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const valid = validateCustomTagPatch({
    addTagIds: [first, first.toUpperCase()],
    addNames: ['重点跟进', '  重点跟进  '],
    removeTagIds: [second],
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.addTagIds, [first]);
  assert.deepEqual(valid.addNames, [{ name: '重点跟进', normalizedName: '重点跟进' }]);
  assert.deepEqual(valid.removeTagIds, [second]);

  assert.equal(validateCustomTagPatch({ addTagIds: ['bad-id'] }).error, 'invalid_tag_id');
  assert.equal(validateCustomTagPatch({ addNames: '重点跟进' }).error, 'invalid_request');
  assert.equal(validateCustomTagPatch({ tags: [] }).error, 'unsupported_fields');
  assert.equal(validateCustomTagPatch({ addTagIds: [first], removeTagIds: [first] }).error, 'tag_conflict');
  assert.equal(
    validateCustomTagPatch({ addNames: Array.from({ length: 21 }, (_, index) => `标签${index}`) }).error,
    'too_many_tag_operations',
  );
  assert.deepEqual(normalizeCustomTagId(first.toUpperCase()), { ok: true, value: first });
  assert.equal(normalizeCustomTagId('bad-id').error, 'invalid_tag_id');
});

test('batch custom tag input accepts separate add and remove operations for 1-100 records', () => {
  const firstRecord = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const secondRecord = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const tagId = '11111111-1111-4111-8111-111111111111';
  const secondTagId = '22222222-2222-4222-8222-222222222222';
  assert.equal(MAX_CUSTOM_TAG_BATCH_RECORDS, 100);
  assert.deepEqual(validateCustomTagBatch({
    ids: [firstRecord, firstRecord.toUpperCase(), secondRecord],
    addTagIds: [tagId],
    addNames: ['晨间重点'],
  }), {
    ok: true,
    ids: [firstRecord, secondRecord],
    operation: 'add',
    patch: {
      ok: true,
      addTagIds: [tagId],
      addNames: [{ name: '晨间重点', normalizedName: '晨间重点' }],
      removeTagIds: [],
    },
  });
  assert.deepEqual(validateCustomTagBatch({
    ids: [firstRecord, secondRecord],
    removeTagIds: [tagId],
  }), {
    ok: true,
    ids: [firstRecord, secondRecord],
    operation: 'remove',
    patch: {
      ok: true,
      addTagIds: [],
      addNames: [],
      removeTagIds: [tagId],
    },
  });
  assert.equal(validateCustomTagBatch({ ids: [], addNames: ['重点'] }).error, 'invalid_ids');
  assert.equal(validateCustomTagBatch({ ids: ['bad'], addNames: ['重点'] }).error, 'invalid_record_id');
  assert.equal(validateCustomTagBatch({ ids: [firstRecord] }).error, 'empty_update');
  assert.equal(validateCustomTagBatch({
    ids: [firstRecord],
    addTagIds: [tagId],
    removeTagIds: [secondTagId],
  }).error, 'mixed_batch_tag_operation');
});

test('batch custom tag planning updates, preserves and skips records independently at the per-record limit', () => {
  const records = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ];
  const requested = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const existingRows = [
    { record_id: records[0], id: requested[0] },
    ...Array.from({ length: 9 }, (_, index) => ({
      record_id: records[0],
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      record_id: records[1],
      id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    })),
    { record_id: records[2], id: requested[0] },
    { record_id: records[2], id: requested[1] },
  ];
  assert.deepEqual(planRecordCustomTagBatch({
    recordIds: records,
    requestedTagIds: requested,
    existingRows,
  }), {
    updatedIds: [],
    unchangedIds: [records[2]],
    limitIds: [records[0], records[1]],
  });

  existingRows.splice(9, 1);
  assert.deepEqual(planRecordCustomTagBatch({
    recordIds: records,
    requestedTagIds: requested,
    existingRows,
  }), {
    updatedIds: [records[0]],
    unchangedIds: [records[2]],
    limitIds: [records[1]],
  });

  assert.deepEqual(planRecordCustomTagBatch({
    recordIds: records,
    requestedTagIds: requested,
    existingRows,
    operation: 'remove',
  }), {
    updatedIds: [records[0], records[2]],
    unchangedIds: [records[1]],
    limitIds: [],
  });
});

test('batch custom tag mutation adds only missing relationships and writes per-record history', async () => {
  const firstRecord = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const secondRecord = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const tagId = '11111111-1111-4111-8111-111111111111';
  const queryResults = [
    [{ record_id: secondRecord, id: tagId, name: '重点跟进' }],
    [{ id: tagId, name: '重点跟进' }],
    [{ record_id: firstRecord, id: tagId, name: '重点跟进' }],
  ];
  const executions = [];
  const tx = {
    queryAll: async () => queryResults.shift() || [],
    queryOne: async () => { throw new Error('no custom name should be created'); },
    execute: async (sql, params) => { executions.push({ sql, params }); },
  };
  const result = await applyRecordCustomTagBatch(tx, {
    tenantId: '99999999-9999-4999-8999-999999999999',
    recordIds: [firstRecord, secondRecord],
    patch: { addTagIds: [tagId], addNames: [], removeTagIds: [] },
    actorUserId: '88888888-8888-4888-8888-888888888888',
    actorName: '测试用户',
  });

  assert.deepEqual(result.updatedIds, [firstRecord]);
  assert.deepEqual(result.unchangedIds, [secondRecord]);
  assert.deepEqual(result.limitIds, []);
  assert.equal(result.operation, 'add');
  assert.deepEqual(result.tags, [{ id: tagId, name: '重点跟进' }]);
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0].removed_tags, []);
  assert.equal(executions.length, 4);
  assert.match(executions[0].sql, /INSERT INTO record_custom_tags/);
  assert.deepEqual(executions[0].params[1], [firstRecord]);
  assert.match(executions[2].sql, /INSERT INTO record_versions/);
  assert.match(executions[3].sql, /record\.custom_tags_updated/);
  assert.match(executions[3].sql, /'batch', true/);
});

test('batch custom tag mutation removes only existing relationships and audits removed tags', async () => {
  const firstRecord = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const secondRecord = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const tagId = '11111111-1111-4111-8111-111111111111';
  const tag = { id: tagId, name: '重点跟进' };
  const queryResults = [
    [{ record_id: firstRecord, ...tag }],
    [tag],
    [],
  ];
  const executions = [];
  const tx = {
    queryAll: async () => queryResults.shift() || [],
    queryOne: async () => { throw new Error('remove must not create a custom tag'); },
    execute: async (sql, params) => { executions.push({ sql, params }); },
  };
  const result = await applyRecordCustomTagBatch(tx, {
    tenantId: '99999999-9999-4999-8999-999999999999',
    recordIds: [firstRecord, secondRecord],
    patch: { addTagIds: [], addNames: [], removeTagIds: [tagId] },
    actorUserId: '88888888-8888-4888-8888-888888888888',
    actorName: '测试用户',
  });

  assert.equal(result.operation, 'remove');
  assert.deepEqual(result.updatedIds, [firstRecord]);
  assert.deepEqual(result.unchangedIds, [secondRecord]);
  assert.deepEqual(result.limitIds, []);
  assert.deepEqual(result.tags, [tag]);
  assert.deepEqual(result.changes[0].added_tags, []);
  assert.deepEqual(result.changes[0].removed_tags, [tag]);
  assert.equal(executions.length, 3);
  assert.match(executions[0].sql, /DELETE FROM record_custom_tags/);
  assert.deepEqual(executions[0].params[1], [firstRecord]);
  assert.match(executions[1].sql, /INSERT INTO record_versions/);
  assert.match(executions[2].sql, /'removed', change\.removed_tags/);
  assert.match(executions[2].sql, /record\.custom_tags_updated/);
});

test('triage custom tag filters support repeated UUIDs and any/all modes', () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(normalizeCustomTagFilter([first, `${second},${first}`], 'all'), {
    ok: true,
    ids: [first, second],
    mode: 'all',
  });
  assert.deepEqual(normalizeCustomTagFilter(first), {
    ok: true,
    ids: [first],
    mode: 'any',
  });
  assert.equal(normalizeCustomTagFilter('bad-id').error, 'invalid_custom_tag');
  assert.equal(normalizeCustomTagFilter(first, 'none').error, 'invalid_custom_tag_mode');

  const anyParams = ['tenant'];
  const anyWhere = appendCustomTagFilter('WHERE r.tenant_id = $1', anyParams, {
    ids: [first, second],
    mode: 'any',
  });
  assert.match(anyWhere, /AND EXISTS/);
  assert.deepEqual(anyParams, ['tenant', [first, second]]);

  const allParams = ['tenant'];
  const allWhere = appendCustomTagFilter('WHERE r.tenant_id = $1', allParams, {
    ids: [first, second],
    mode: 'all',
  });
  assert.match(allWhere, /NOT EXISTS[\s\S]*unnest\(\$2::uuid\[\]\)[\s\S]*WHERE NOT EXISTS/);
  assert.deepEqual(allParams, ['tenant', [first, second]]);
});

test('backend contracts keep custom tags tenant-scoped, audited and recapture-safe', async () => {
  assert.equal(MAX_CUSTOM_TAGS_PER_RECORD, 10);
  const [
    migration,
    service,
    customTagRoute,
    records,
    triage,
    workspace,
    serverApp,
    recordStore,
  ] = await Promise.all([
    source('server/db/migrations/030_record_custom_tags.sql'),
    source('server/services/record-custom-tags.js'),
    source('server/routes/custom-tags.js'),
    source('server/routes/records.js'),
    source('server/routes/triage.js'),
    source('server/routes/workspace.js'),
    source('server/app.js'),
    source('server/services/record-store.js'),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS custom_tags/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS record_custom_tags/);
  assert.match(migration, /CHECK \(char_length\(btrim\(name\)\) BETWEEN 1 AND 24\)/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, record_id\)[\s\S]*REFERENCES records\(tenant_id, id\)/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, tag_id\)[\s\S]*REFERENCES custom_tags\(tenant_id, id\)/);
  assert.match(service, /MAX_CUSTOM_TAGS_PER_RECORD = 10/);
  assert.match(service, /ON CONFLICT \(tenant_id, normalized_name\)/);
  assert.match(customTagRoute, /router\.use\(requireTenantAccess, requireSessionUser\)/);
  assert.match(customTagRoute, /usageCount/);
  assert.match(customTagRoute, /router\.delete\('\/:id', requireTenantWriter/);
  assert.match(customTagRoute, /WHERE tenant_id = \$1 AND id = \$2[\s\S]*FOR UPDATE/);
  assert.match(customTagRoute, /DELETE FROM custom_tags[\s\S]*WHERE tenant_id = \$1 AND id = \$2/);
  assert.match(customTagRoute, /custom_tag\.deleted/);
  assert.match(customTagRoute, /affectedRecords/);
  assert.match(migration, /REFERENCES custom_tags\(tenant_id, id\)[\s\S]*ON DELETE CASCADE/);

  const routeStart = records.indexOf("router.patch('/:id/custom-tags'");
  const routeEnd = records.indexOf("router.patch('/:id/official-response'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const customTagRecordRoute = records.slice(routeStart, routeEnd);
  assert.match(customTagRecordRoute, /requireSessionUser, requireTenantWriter/);
  assert.match(customTagRecordRoute, /applyRecordCustomTagPatch/);
  assert.doesNotMatch(customTagRecordRoute, /DELETE FROM custom_tags/);
  assert.match(service, /DELETE FROM record_custom_tags[\s\S]*record_id = \$2[\s\S]*tag_id = ANY/);
  assert.match(customTagRecordRoute, /record_versions/);
  assert.match(customTagRecordRoute, /record\.custom_tags_updated/);
  assert.doesNotMatch(customTagRecordRoute, /insertRecordFeedback/);

  const batchRouteStart = records.indexOf("router.patch('/custom-tags/batch'");
  assert.ok(batchRouteStart >= 0 && batchRouteStart < routeStart);
  const batchRoute = records.slice(batchRouteStart, routeStart);
  assert.match(batchRoute, /requireSessionUser, requireTenantWriter/);
  assert.match(batchRoute, /validateCustomTagBatch/);
  assert.match(batchRoute, /getRecordLifecycles/);
  assert.match(batchRoute, /applyRecordCustomTagBatch/);
  assert.match(batchRoute, /reason: 'tag_limit'/);
  assert.match(batchRoute, /reason: 'archived'/);
  assert.match(service, /planRecordCustomTagBatch/);
  assert.match(service, /jsonb_to_recordset/);
  assert.match(service, /'batch', true/);
  assert.match(service, /record\.custom_tags_updated/);

  assert.match(triage, /req\.query\.customTag/);
  assert.match(triage, /appendCustomTagFilter/);
  assert.match(triage, /AS custom_tags/);
  assert.match(triage, /header: '自定义标签'/);
  assert.match(workspace, /customTagsSelectSql\('r'\)\} AS custom_tags/);
  assert.match(serverApp, /app\.use\('\/api\/custom-tags', customTagsRouter\)/);
  assert.doesNotMatch(recordStore, /record_custom_tags|customTags|custom_tags/);
});
