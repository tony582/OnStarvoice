export const MAX_CUSTOM_TAG_NAME_LENGTH = 24;
export const MAX_CUSTOM_TAGS_PER_RECORD = 10;
export const MAX_CUSTOM_TAG_FILTERS = 20;
export const MAX_CUSTOM_TAG_PATCH_ITEMS = 20;
export const MAX_CUSTOM_TAG_BATCH_RECORDS = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATCH_KEYS = new Set(['addTagIds', 'addNames', 'removeTagIds']);
const BATCH_KEYS = new Set(['ids', 'addTagIds', 'addNames', 'removeTagIds']);

function unique(values) {
  return [...new Set(values)];
}

function errorResult(error, message) {
  return { ok: false, error, message };
}

function normalizeUuidArray(value, field) {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return errorResult('invalid_request', `${field} 必须是数组`);
  const ids = unique(value.map(item => String(item || '').trim().toLowerCase()).filter(Boolean));
  if (ids.some(id => !UUID_RE.test(id))) return errorResult('invalid_tag_id', `${field} 包含无效标签ID`);
  return { ok: true, value: ids };
}

export function normalizeCustomTagId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) {
    return errorResult('invalid_tag_id', '标签ID无效');
  }
  return { ok: true, value: id };
}

export function normalizeCustomTagName(value) {
  let name = String(value ?? '').normalize('NFKC').trim();
  name = name.replace(/^#+\s*/u, '').replace(/\s+/gu, ' ').trim();
  if (!name) return errorResult('tag_name_required', '标签名称不能为空');
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    return errorResult('invalid_tag_name', '标签名称不能包含控制字符');
  }
  if ([...name].length > MAX_CUSTOM_TAG_NAME_LENGTH) {
    return errorResult('tag_name_too_long', `标签名称不能超过 ${MAX_CUSTOM_TAG_NAME_LENGTH} 个字`);
  }
  const normalizedName = name.toLowerCase();
  if ([...normalizedName].length > MAX_CUSTOM_TAG_NAME_LENGTH) {
    return errorResult('tag_name_too_long', `标签名称不能超过 ${MAX_CUSTOM_TAG_NAME_LENGTH} 个字`);
  }
  return { ok: true, name, normalizedName };
}

export function normalizeCustomTagKeyword(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/^#+\s*/u, '')
    .replace(/\s+/gu, ' ')
    .toLowerCase()
    .slice(0, 100);
}

export function validateCustomTagPatch(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResult('invalid_request', '请求内容无效');
  }
  const unknown = Object.keys(body).filter(key => !PATCH_KEYS.has(key));
  if (unknown.length) {
    return errorResult('unsupported_fields', `不支持字段: ${unknown.join(', ')}`);
  }

  const addTagIds = normalizeUuidArray(body.addTagIds, 'addTagIds');
  if (!addTagIds.ok) return addTagIds;
  const removeTagIds = normalizeUuidArray(body.removeTagIds, 'removeTagIds');
  if (!removeTagIds.ok) return removeTagIds;

  if (body.addNames !== undefined && !Array.isArray(body.addNames)) {
    return errorResult('invalid_request', 'addNames 必须是数组');
  }
  const namesByNormalized = new Map();
  for (const rawName of body.addNames || []) {
    const normalized = normalizeCustomTagName(rawName);
    if (!normalized.ok) return normalized;
    if (!namesByNormalized.has(normalized.normalizedName)) {
      namesByNormalized.set(normalized.normalizedName, normalized);
    }
  }

  if (!addTagIds.value.length && !removeTagIds.value.length && !namesByNormalized.size) {
    return errorResult('empty_update', '没有要更新的自定义标签');
  }
  if (addTagIds.value.length + removeTagIds.value.length + namesByNormalized.size > MAX_CUSTOM_TAG_PATCH_ITEMS) {
    return errorResult('too_many_tag_operations', `单次最多操作 ${MAX_CUSTOM_TAG_PATCH_ITEMS} 个自定义标签`);
  }

  const directConflicts = addTagIds.value.filter(id => removeTagIds.value.includes(id));
  if (directConflicts.length) {
    return errorResult('tag_conflict', '同一标签不能同时添加和删除');
  }

  return {
    ok: true,
    addTagIds: addTagIds.value,
    addNames: [...namesByNormalized.values()]
      .map(item => ({
        name: item.name,
        normalizedName: item.normalizedName,
      }))
      .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName)),
    removeTagIds: removeTagIds.value,
  };
}

export function validateCustomTagBatch(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResult('invalid_request', '请求内容无效');
  }
  const unknown = Object.keys(body).filter(key => !BATCH_KEYS.has(key));
  if (unknown.length) {
    return errorResult('unsupported_fields', `不支持字段: ${unknown.join(', ')}`);
  }
  if (!Array.isArray(body.ids)) {
    return errorResult('invalid_ids', `ids 需为 1-${MAX_CUSTOM_TAG_BATCH_RECORDS} 个内容ID`);
  }
  const ids = unique(body.ids
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean));
  if (!ids.length || ids.length > MAX_CUSTOM_TAG_BATCH_RECORDS) {
    return errorResult('invalid_ids', `ids 需为 1-${MAX_CUSTOM_TAG_BATCH_RECORDS} 个内容ID`);
  }
  if (ids.some(id => !UUID_RE.test(id))) {
    return errorResult('invalid_record_id', 'ids 包含无效内容ID');
  }

  const patch = validateCustomTagPatch({
    addTagIds: body.addTagIds,
    addNames: body.addNames,
    removeTagIds: body.removeTagIds,
  });
  if (!patch.ok) return patch;
  const hasAdditions = patch.addTagIds.length > 0 || patch.addNames.length > 0;
  const hasRemovals = patch.removeTagIds.length > 0;
  if (hasAdditions && hasRemovals) {
    return errorResult('mixed_batch_tag_operation', '批量操作需分别执行添加标签或移除标签');
  }
  return { ok: true, ids, operation: hasRemovals ? 'remove' : 'add', patch };
}

export function planRecordCustomTagBatch({
  recordIds = [],
  requestedTagIds = [],
  existingRows = [],
  operation = 'add',
} = {}) {
  const normalizedRecordIds = unique(recordIds.map(id => String(id).toLowerCase()));
  const normalizedTagIds = unique(requestedTagIds.map(id => String(id).toLowerCase()));
  const existingByRecord = new Map(normalizedRecordIds.map(id => [id, new Set()]));
  for (const row of existingRows) {
    const recordId = String(row.record_id || row.recordId || '').toLowerCase();
    const tagId = String(row.id || row.tag_id || row.tagId || '').toLowerCase();
    if (existingByRecord.has(recordId) && tagId) existingByRecord.get(recordId).add(tagId);
  }

  const updatedIds = [];
  const unchangedIds = [];
  const limitIds = [];
  for (const recordId of normalizedRecordIds) {
    const existing = existingByRecord.get(recordId);
    if (operation === 'remove') {
      if (normalizedTagIds.some(id => existing.has(id))) updatedIds.push(recordId);
      else unchangedIds.push(recordId);
      continue;
    }
    const missingCount = normalizedTagIds.filter(id => !existing.has(id)).length;
    if (missingCount === 0) unchangedIds.push(recordId);
    else if (existing.size + missingCount > MAX_CUSTOM_TAGS_PER_RECORD) limitIds.push(recordId);
    else updatedIds.push(recordId);
  }
  return { updatedIds, unchangedIds, limitIds };
}

export function normalizeCustomTagFilter(value, modeValue = '') {
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap(item => String(item || '').split(','))
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
  const ids = unique(parts);
  if (ids.some(id => !UUID_RE.test(id))) {
    return errorResult('invalid_custom_tag', 'customTag 包含无效标签ID');
  }
  if (ids.length > MAX_CUSTOM_TAG_FILTERS) {
    return errorResult('too_many_custom_tags', `customTag 最多选择 ${MAX_CUSTOM_TAG_FILTERS} 个`);
  }
  const rawMode = String(modeValue || '').trim().toLowerCase();
  const mode = rawMode || 'any';
  if (!['any', 'all'].includes(mode)) {
    return errorResult('invalid_custom_tag_mode', 'customTagMode 仅支持 any 或 all');
  }
  return { ok: true, ids, mode };
}

export function appendCustomTagFilter(where, params, filter, recordAlias = 'r') {
  if (!filter?.ids?.length) return where;
  params.push(filter.ids);
  const parameter = `$${params.length}::uuid[]`;
  if (filter.mode === 'all') {
    return `${where} AND NOT EXISTS (
      SELECT 1
      FROM unnest(${parameter}) AS wanted(tag_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM record_custom_tags rct_filter
        WHERE rct_filter.tenant_id = ${recordAlias}.tenant_id
          AND rct_filter.record_id = ${recordAlias}.id
          AND rct_filter.tag_id = wanted.tag_id
      )
    )`;
  }
  return `${where} AND EXISTS (
    SELECT 1
    FROM record_custom_tags rct_filter
    WHERE rct_filter.tenant_id = ${recordAlias}.tenant_id
      AND rct_filter.record_id = ${recordAlias}.id
      AND rct_filter.tag_id = ANY(${parameter})
  )`;
}

export function customTagsSelectSql(recordAlias = 'r') {
  return `COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object('id', ct.id, 'name', ct.name)
      ORDER BY ct.name ASC, ct.id ASC
    )
    FROM record_custom_tags rct_tags
    JOIN custom_tags ct
      ON ct.tenant_id = rct_tags.tenant_id
      AND ct.id = rct_tags.tag_id
    WHERE rct_tags.tenant_id = ${recordAlias}.tenant_id
      AND rct_tags.record_id = ${recordAlias}.id
  ), '[]'::jsonb)`;
}

export async function listRecordCustomTags(db, tenantId, recordId) {
  return await db.queryAll(`
    SELECT ct.id, ct.name
    FROM record_custom_tags rct
    JOIN custom_tags ct
      ON ct.tenant_id = rct.tenant_id
      AND ct.id = rct.tag_id
    WHERE rct.tenant_id = $1 AND rct.record_id = $2
    ORDER BY ct.name ASC, ct.id ASC
  `, [tenantId, recordId]);
}

function customTagError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export async function applyRecordCustomTagPatch(tx, {
  tenantId,
  recordId,
  patch,
  actorUserId = null,
  actorName = '',
}) {
  const before = await listRecordCustomTags(tx, tenantId, recordId);
  const beforeById = new Map(before.map(tag => [String(tag.id), tag]));
  const resolvedById = new Map();

  if (patch.addTagIds.length) {
    const existing = await tx.queryAll(`
      SELECT id, name
      FROM custom_tags
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
    `, [tenantId, patch.addTagIds]);
    existing.forEach(tag => resolvedById.set(String(tag.id), tag));
    if (existing.length !== patch.addTagIds.length) {
      throw customTagError('tag_not_found', '包含不存在或不属于当前租户的标签', 404);
    }
  }

  for (const item of patch.addNames) {
    const tag = await tx.queryOne(`
      INSERT INTO custom_tags (
        tenant_id, name, normalized_name, created_by_user_id, created_by_name
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tenant_id, normalized_name)
      DO UPDATE SET updated_at = custom_tags.updated_at
      RETURNING id, name
    `, [tenantId, item.name, item.normalizedName, actorUserId, actorName]);
    resolvedById.set(String(tag.id), tag);
  }

  const addIds = unique([...patch.addTagIds, ...resolvedById.keys()]);
  const removeIds = patch.removeTagIds;
  const conflicts = addIds.filter(id => removeIds.includes(id));
  if (conflicts.length) {
    throw customTagError('tag_conflict', '同一标签不能同时添加和删除');
  }

  const finalIds = new Set(beforeById.keys());
  removeIds.forEach(id => finalIds.delete(id));
  addIds.forEach(id => finalIds.add(id));
  if (finalIds.size > MAX_CUSTOM_TAGS_PER_RECORD) {
    throw customTagError(
      'too_many_custom_tags',
      `每条内容最多添加 ${MAX_CUSTOM_TAGS_PER_RECORD} 个自定义标签`,
    );
  }

  const actualRemoved = removeIds.filter(id => beforeById.has(id));
  const actualAdded = addIds.filter(id => !beforeById.has(id));
  if (!actualAdded.length && !actualRemoved.length) {
    return { before, after: before, added: [], removed: [], unchanged: true };
  }

  if (actualRemoved.length) {
    await tx.execute(`
      DELETE FROM record_custom_tags
      WHERE tenant_id = $1 AND record_id = $2 AND tag_id = ANY($3::uuid[])
    `, [tenantId, recordId, actualRemoved]);
  }

  if (actualAdded.length) {
    await tx.execute(`
      INSERT INTO record_custom_tags (
        tenant_id, record_id, tag_id, added_by_user_id, added_by_name
      )
      SELECT $1, $2, added.tag_id, $4, $5
      FROM unnest($3::uuid[]) AS added(tag_id)
      ON CONFLICT (tenant_id, record_id, tag_id) DO NOTHING
    `, [tenantId, recordId, actualAdded, actorUserId, actorName]);
    await tx.execute(`
      UPDATE custom_tags
      SET last_used_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
    `, [tenantId, actualAdded]);
  }

  const after = await listRecordCustomTags(tx, tenantId, recordId);
  const afterById = new Map(after.map(tag => [String(tag.id), tag]));
  return {
    before,
    after,
    added: actualAdded.map(id => afterById.get(id)).filter(Boolean),
    removed: actualRemoved.map(id => beforeById.get(id)).filter(Boolean),
    unchanged: false,
  };
}

export async function applyRecordCustomTagBatch(tx, {
  tenantId,
  recordIds,
  patch,
  actorUserId = null,
  actorName = '',
}) {
  const operation = patch.removeTagIds.length ? 'remove' : 'add';
  const existingRows = await tx.queryAll(`
    SELECT rct.record_id, ct.id, ct.name
    FROM record_custom_tags rct
    JOIN custom_tags ct
      ON ct.tenant_id = rct.tenant_id
      AND ct.id = rct.tag_id
    WHERE rct.tenant_id = $1 AND rct.record_id = ANY($2::uuid[])
    ORDER BY rct.record_id, ct.name ASC, ct.id ASC
  `, [tenantId, recordIds]);

  const resolvedById = new Map();
  const requestedExistingIds = operation === 'remove' ? patch.removeTagIds : patch.addTagIds;
  if (requestedExistingIds.length) {
    const existingTags = await tx.queryAll(`
      SELECT id, name
      FROM custom_tags
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
      FOR KEY SHARE
    `, [tenantId, requestedExistingIds]);
    existingTags.forEach(tag => resolvedById.set(String(tag.id).toLowerCase(), tag));
    if (existingTags.length !== requestedExistingIds.length) {
      throw customTagError('tag_not_found', '包含不存在或不属于当前租户的标签', 404);
    }
  }

  if (operation === 'add') {
    for (const item of patch.addNames) {
      const tag = await tx.queryOne(`
        INSERT INTO custom_tags (
          tenant_id, name, normalized_name, created_by_user_id, created_by_name
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, normalized_name)
        DO UPDATE SET updated_at = custom_tags.updated_at
        RETURNING id, name
      `, [tenantId, item.name, item.normalizedName, actorUserId, actorName]);
      resolvedById.set(String(tag.id).toLowerCase(), tag);
    }
  }

  const requestedTagIds = unique([
    ...(operation === 'remove' ? patch.removeTagIds : patch.addTagIds),
    ...resolvedById.keys(),
  ]);
  const tags = requestedTagIds
    .map(id => resolvedById.get(id))
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
  const plan = planRecordCustomTagBatch({ recordIds, requestedTagIds, existingRows, operation });

  // 新建标签但没有任何记录可接收时回滚事务，避免留下未使用的目录项。
  if (operation === 'add' && !plan.updatedIds.length && plan.limitIds.length) {
    const error = customTagError(
      'too_many_custom_tags',
      `所选内容添加后会超过每条 ${MAX_CUSTOM_TAGS_PER_RECORD} 个标签的上限`,
      409,
    );
    error.recordIds = plan.limitIds;
    throw error;
  }

  if (!plan.updatedIds.length) {
    return { ...plan, operation, tags, changes: [] };
  }

  if (operation === 'remove') {
    await tx.execute(`
      DELETE FROM record_custom_tags
      WHERE tenant_id = $1
        AND record_id = ANY($2::uuid[])
        AND tag_id = ANY($3::uuid[])
    `, [tenantId, plan.updatedIds, requestedTagIds]);
  } else {
    await tx.execute(`
      INSERT INTO record_custom_tags (
        tenant_id, record_id, tag_id, added_by_user_id, added_by_name
      )
      SELECT $1, selected_records.record_id, selected_tags.tag_id, $4, $5
      FROM unnest($2::uuid[]) AS selected_records(record_id)
      CROSS JOIN unnest($3::uuid[]) AS selected_tags(tag_id)
      ON CONFLICT (tenant_id, record_id, tag_id) DO NOTHING
    `, [tenantId, plan.updatedIds, requestedTagIds, actorUserId, actorName]);
    await tx.execute(`
      UPDATE custom_tags
      SET last_used_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
    `, [tenantId, requestedTagIds]);
  }

  const afterRows = await tx.queryAll(`
    SELECT rct.record_id, ct.id, ct.name
    FROM record_custom_tags rct
    JOIN custom_tags ct
      ON ct.tenant_id = rct.tenant_id
      AND ct.id = rct.tag_id
    WHERE rct.tenant_id = $1 AND rct.record_id = ANY($2::uuid[])
    ORDER BY rct.record_id, ct.name ASC, ct.id ASC
  `, [tenantId, plan.updatedIds]);
  const beforeByRecord = groupCustomTagsByRecord(recordIds, existingRows);
  const afterByRecord = groupCustomTagsByRecord(plan.updatedIds, afterRows);
  const changes = plan.updatedIds.map(recordId => {
    const before = beforeByRecord.get(recordId) || [];
    const after = afterByRecord.get(recordId) || [];
    const beforeIds = new Set(before.map(tag => String(tag.id).toLowerCase()));
    const afterIds = new Set(after.map(tag => String(tag.id).toLowerCase()));
    return {
      record_id: recordId,
      before_tags: before,
      after_tags: after,
      added_tags: after.filter(tag => !beforeIds.has(String(tag.id).toLowerCase())),
      removed_tags: before.filter(tag => !afterIds.has(String(tag.id).toLowerCase())),
    };
  });
  const serializedChanges = JSON.stringify(changes);

  await tx.execute(`
    INSERT INTO record_versions (
      tenant_id, record_id, changed_fields, before_data, after_data
    )
    SELECT
      $1, change.record_id, ARRAY['custom_tags']::text[],
      jsonb_build_object('custom_tags', change.before_tags),
      jsonb_build_object('custom_tags', change.after_tags)
    FROM jsonb_to_recordset($2::jsonb) AS change(
      record_id uuid, before_tags jsonb, after_tags jsonb,
      added_tags jsonb, removed_tags jsonb
    )
  `, [tenantId, serializedChanges]);
  await tx.execute(`
    INSERT INTO audit_logs (
      tenant_id, actor_type, actor_id, actor_user_id,
      action, target_type, target_id, metadata
    )
    SELECT
      $1, 'user', $2, $3,
      'record.custom_tags_updated', 'record', change.record_id,
      jsonb_build_object(
        'batch', true,
        'added', change.added_tags,
        'removed', change.removed_tags,
        'before', change.before_tags,
        'after', change.after_tags
      )
    FROM jsonb_to_recordset($4::jsonb) AS change(
      record_id uuid, before_tags jsonb, after_tags jsonb,
      added_tags jsonb, removed_tags jsonb
    )
  `, [tenantId, actorUserId || '', actorUserId, serializedChanges]);

  return { ...plan, operation, tags, changes };
}

function groupCustomTagsByRecord(recordIds, rows) {
  const grouped = new Map(recordIds.map(id => [String(id).toLowerCase(), []]));
  for (const row of rows) {
    const recordId = String(row.record_id || row.recordId || '').toLowerCase();
    if (!grouped.has(recordId)) continue;
    grouped.get(recordId).push({ id: row.id, name: row.name });
  }
  return grouped;
}
