import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_CUSTOM_TAG_NAME_LENGTH,
  MAX_CUSTOM_TAGS_PER_RECORD,
  appendCustomTagFilter,
  normalizeCustomTagId,
  normalizeCustomTagFilter,
  normalizeCustomTagName,
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

  assert.match(triage, /req\.query\.customTag/);
  assert.match(triage, /appendCustomTagFilter/);
  assert.match(triage, /AS custom_tags/);
  assert.match(triage, /header: '自定义标签'/);
  assert.match(workspace, /customTagsSelectSql\('r'\)\} AS custom_tags/);
  assert.match(serverApp, /app\.use\('\/api\/custom-tags', customTagsRouter\)/);
  assert.doesNotMatch(recordStore, /record_custom_tags|customTags|custom_tags/);
});
