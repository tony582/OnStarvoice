import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('captured body images are persisted while platform links are still valid', () => {
  const migration = source('server/db/migrations/040_record_local_images.sql');
  const mediaStore = source('server/services/media-store.js');
  const recordStore = source('server/services/record-store.js');
  const server = source('server/index.js');

  assert.match(migration, /image_local_urls JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
  assert.match(mediaStore, /const IMAGES_DIR = join\(MEDIA_DIR, 'images'\)/);
  assert.match(mediaStore, /source_url: url, source_hash: sourceHash, url: localUrl/);
  assert.match(mediaStore, /export function queueRecordImagesLocalization/);
  assert.match(mediaStore, /export async function backfillRecentImages/);
  assert.match(recordStore, /queueRecordImagesLocalization\(__result\.id, imageUrls, record\.platform\)/);
  assert.match(server, /Promise\.all\(\[backfillRecentCovers\(\), backfillRecentImages\(\)\]\)/);
});

test('triage and ticket details expose local body image paths', () => {
  const triage = source('server/routes/triage.js');
  const tickets = source('server/routes/tickets.js');
  const recordStore = source('server/services/record-store.js');

  assert.match(triage, /r\.image_urls, r\.image_local_urls/);
  assert.match(tickets, /image_urls, image_local_urls/);
  assert.match(recordStore, /image_local_urls: typeof row\.image_local_urls/);
});

test('both detail drawers share a graceful image fallback', () => {
  const gallery = source('web/admin/src/components/shared/RecordImageGallery.tsx');
  const imageSources = source('web/admin/src/components/shared/record-images.ts');
  const recordDrawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const ticketDrawer = source('web/admin/src/components/shared/TicketDrawer.tsx');

  assert.match(imageSources, /record\.image_local_urls/);
  assert.match(imageSources, /record\.cover_local \|\| record\.cover_url/);
  assert.match(imageSources, /function imageSourceIdentity/);
  assert.match(imageSources, /const seenSourceIdentities = new Set<string>\(\)/);
  assert.match(imageSources, /imageSourceIdentity\(item\.ref \|\| item\.url\)/);
  assert.match(gallery, /onError=\{\(\) => setFailed/);
  assert.match(gallery, /平台原图已失效/);
  assert.match(recordDrawer, /<RecordImageGallery/);
  assert.match(ticketDrawer, /<RecordImageGallery/);
});
