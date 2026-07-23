import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('record image OCR is tenant scoped, session-only, stable-reference addressed, and cached', async () => {
  const [route, service, migration] = await Promise.all([
    source('server/routes/records.js'),
    source('server/services/image-text-extraction.js'),
    source('server/db/migrations/042_record_image_ocr.sql'),
  ]);

  const start = route.indexOf("router.post('/:id/image-text'");
  const end = route.indexOf('/** 逐字稿状态查询', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const imageTextRoute = route.slice(start, end);

  assert.match(imageTextRoute, /requireTenantAccess, requireSessionUser/);
  assert.match(imageTextRoute, /validateImageTextRequest\(req\.body\)/);
  assert.match(imageTextRoute, /tenantId: req\.tenantId/);
  assert.match(imageTextRoute, /recordId: req\.params\.id/);
  assert.match(imageTextRoute, /imageRef: input\.imageRef/);
  assert.match(imageTextRoute, /input\.refresh && !isTenantWriter\(req\)/);
  assert.match(imageTextRoute, /actorUserId: req\.user\?\.id/);
  assert.doesNotMatch(imageTextRoute, /req\.body\.(?:imageUrl|apiKey|model)/);

  assert.match(service, /WHERE id = \$1 AND tenant_id = \$2/);
  assert.match(service, /images\.find\(item => item\.ref === imageRef\)/);
  assert.match(service, /publicLocalPath\(candidate\.url\)/);
  assert.match(service, /redirect: 'manual'/);
  assert.match(service, /isAllowedMediaHost\(current\)/);
  assert.match(service, /MAX_IMAGE_BYTES = 7 \* 1024 \* 1024/);
  assert.match(service, /createHash\('sha256'\)\.update\(bytes\)/);
  assert.match(service, /INFLIGHT\.has\(inflightKey\)/);
  assert.match(service, /ACTIVE_BY_TENANT/);
  assert.match(service, /detectedImageMime\(bytes\)/);
  assert.doesNotMatch(service, /dangerouslySetInnerHTML/);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS record_image_ocr/);
  assert.match(
    migration,
    /UNIQUE \(tenant_id, record_id, image_hash, model, prompt_version\)/,
  );
  assert.match(migration, /CHECK \(status IN \('processing', 'done', 'failed'\)\)/);
  assert.match(migration, /is_truncated BOOLEAN NOT NULL DEFAULT false/);
});
