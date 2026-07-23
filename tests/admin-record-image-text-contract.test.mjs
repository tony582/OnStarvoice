import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('record galleries expose explicit per-image extraction and copy without automatic OCR', async () => {
  const [gallery, recordDrawer, ticketDrawer] = await Promise.all([
    source('web/admin/src/components/shared/RecordImageGallery.tsx'),
    source('web/admin/src/components/shared/RecordDrawer.tsx'),
    source('web/admin/src/components/shared/TicketDrawer.tsx'),
  ]);

  assert.match(gallery, /recordId\?: string/);
  assert.match(gallery, /imageRefs\?: string\[\]/);
  assert.match(gallery, /'提取文字'/);
  assert.match(gallery, /const extractText = async \(imageIndex: number, refresh = false\)/);
  const extraction = gallery.slice(
    gallery.indexOf('const extractText = async'),
    gallery.indexOf('const copyResult = async'),
  );
  assert.match(extraction, /\/records\/\$\{recordId\}\/image-text/);
  assert.match(extraction, /\{ imageRef, refresh \}/);
  assert.doesNotMatch(extraction, /\bimageUrl\b|\bapiKey\b|\bmodel\b/);
  assert.match(gallery, /navigator\.clipboard\?\.writeText/);
  assert.match(gallery, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(gallery, /只处理这一张图片/);
  assert.match(gallery, /重新识别/);
  assert.match(gallery, /复制文字/);
  assert.match(gallery, /本次结果可能不完整/);
  assert.match(gallery, /aria-live="polite"/);
  assert.doesNotMatch(gallery, /dangerouslySetInnerHTML/);
  assert.match(recordDrawer, /recordId=\{String\(r\.id\)\}/);
  assert.match(recordDrawer, /imageRefs=\{imageEntries\.map\(item => item\.ref\)\}/);
  assert.match(ticketDrawer, /recordId=\{rec\?\.id \? String\(rec\.id\) : undefined\}/);
  assert.match(ticketDrawer, /imageRefs=\{imageEntries\.map\(item => item\.ref\)\}/);

  const lifecycle = gallery.slice(
    gallery.indexOf('useEffect(() => () =>'),
    gallery.indexOf('const extractText = async'),
  );
  assert.doesNotMatch(lifecycle, /image-text|extractText\(/);
});
