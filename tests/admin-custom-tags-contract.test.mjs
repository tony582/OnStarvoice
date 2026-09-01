import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function source(path) {
  return readFile(resolve(repoRoot, path), 'utf8');
}

test('React admin exposes reusable custom tag editing, batch add/remove and filtering', async () => {
  const [tagModel, tagUi, batchTagUi, drawer, triage, multiSelect] = await Promise.all([
    source('web/admin/src/lib/custom-tags.ts'),
    source('web/admin/src/components/shared/RecordLabels.tsx'),
    source('web/admin/src/components/shared/BatchCustomTagDialog.tsx'),
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

  assert.match(batchTagUi, /批量添加自定义标签/);
  assert.match(batchTagUi, /批量移除自定义标签/);
  assert.match(batchTagUi, /原有标签不会被移除/);
  assert.match(batchTagUi, /标签选项和其他内容不受影响/);
  assert.match(batchTagUi, /只解除已存在的关联；没有该标签的内容保持不变/);
  assert.match(batchTagUi, /新建并添加“\{queryName\}”/);
  assert.match(batchTagUi, /addTagIds/);
  assert.match(batchTagUi, /addNames/);
  assert.match(batchTagUi, /removeTagIds/);
  assert.match(batchTagUi, /超过 \$\{MAX_CUSTOM_TAGS\} 个标签，该条会跳过/);
  assert.match(batchTagUi, /所选内容暂无可移除标签/);
  assert.match(batchTagUi, /mode === 'remove' \? 'destructive' : 'default'/);

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
  assert.match(triage, /api\.patch<BatchCustomTagsMutationResponse>\('\/records\/custom-tags\/batch'/);
  assert.match(triage, /removeTagIds: values\.removeTagIds/);
  assert.match(triage, /key: 'custom_tags_add', label: '添加标签', icon: Tags/);
  assert.match(triage, /key: 'custom_tags_remove', label: '移除标签', icon: Tags, tone: 'danger'/);
  assert.match(triage, /batchRemovalCatalog/);
  assert.match(triage, /mode=\{batchTagMode\}/);
  assert.match(triage, /<BatchCustomTagDialog/);
  assert.match(triage, /reason === 'tag_limit'/);
  assert.match(triage, /达到标签上限/);

  assert.match(multiSelect, /searchable = false/);
  assert.match(multiSelect, /onSearch\?: \(query: string\) => void/);
  assert.match(multiSelect, /\.normalize\('NFKC'\)/);
  assert.match(multiSelect, /replace\(\/\^#\+\\s\*\/u/);
  assert.match(multiSelect, /max-w-\[calc\(100vw-24px\)\]/);
});
