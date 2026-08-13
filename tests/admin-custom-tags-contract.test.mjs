import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function source(path) {
  return readFile(resolve(repoRoot, path), 'utf8');
}

test('React admin exposes reusable custom tag editing and filtering', async () => {
  const [tagModel, tagUi, drawer, triage, multiSelect] = await Promise.all([
    source('web/admin/src/lib/custom-tags.ts'),
    source('web/admin/src/components/shared/RecordLabels.tsx'),
    source('web/admin/src/components/shared/RecordDrawer.tsx'),
    source('web/admin/src/pages/workbench/TriageQueue.tsx'),
    source('web/admin/src/components/shared/MultiSelect.tsx'),
  ]);

  assert.match(tagModel, /MAX_CUSTOM_TAGS = 10/);
  assert.match(tagModel, /MAX_CUSTOM_TAG_NAME = 24/);
  assert.match(tagModel, /row\.customTags \?\? row\.custom_tags/);

  assert.match(tagUi, /管理自定义标签/);
  assert.match(tagUi, /创建“\{query\.trim\(\)\}”/);
  assert.match(tagUi, /addTagIds/);
  assert.match(tagUi, /removeTagIds/);
  assert.match(tagUi, /保存标签/);
  assert.match(tagUi, /onSave\(\{ addTagIds: \[\], addNames: \[\], removeTagIds: \[tag\.id\] \}\)/);
  assert.match(tagUi, /只解除当前内容的关联/);
  assert.match(tagUi, /标签选项仍会保留，其他内容不受影响/);
  assert.match(tagUi, /上方 × 只从当前内容移除；下方垃圾桶删除整个标签选项/);
  assert.match(tagUi, /onDeleteCatalogTag/);
  assert.match(tagUi, /window\.confirm/);
  assert.match(tagUi, /删除整个标签选项/);
  assert.match(tagUi, /Trash2/);

  assert.match(drawer, /onUpdateCustomTags/);
  assert.match(drawer, /RecordLabelEditor/);
  assert.match(drawer, /RecordLabelsHeading/);
  assert.match(drawer, /onDeleteCustomTag/);

  assert.match(triage, /api\.get<\{ tags\?: unknown \}>\('\/custom-tags\?' \+ params\)/);
  assert.match(triage, /api\.patch<CustomTagsMutationResponse>\('\/records\/' \+ recordId \+ '\/custom-tags'/);
  assert.match(triage, /params\.append\('customTag', id\)/);
  assert.match(triage, /RecordLabelChips tags=\{customTags\} limit=\{2\}/);
  assert.match(triage, /customTagIds\.length[\s\S]*await load/);
  assert.match(triage, /stillMatches[\s\S]*current\.filter\(record => record\.id !== recordId\)/);
  assert.match(triage, /onSearch=\{loadCustomTagCatalog\}/);
  assert.match(triage, /api\.delete<DeleteCustomTagResponse>\('\/custom-tags\/'/);
  assert.match(triage, /setCustomTagCatalog\(current => current\.filter/);
  assert.match(triage, /tagsFromRecord\(record\)\.filter/);
  assert.match(triage, /并已从 \$\{affectedRecords\.toLocaleString\('zh-CN'\)\} 条内容中移除/);

  assert.match(multiSelect, /searchable = false/);
  assert.match(multiSelect, /onSearch\?: \(query: string\) => void/);
  assert.match(multiSelect, /\.normalize\('NFKC'\)/);
  assert.match(multiSelect, /replace\(\/\^#\+\\s\*\/u/);
  assert.match(multiSelect, /max-w-\[calc\(100vw-24px\)\]/);
});
