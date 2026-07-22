import { queryAll, queryOne } from '../db/init.js';

export const RECORD_ARCHIVED_ERROR = 'record_archived';
export const RECORD_ARCHIVED_MESSAGE = '内容已归档，请先取消归档后再处理';

export async function getRecordLifecycle({ tenantId, recordId, tx = null, lock = false }) {
  const getOne = tx?.queryOne || queryOne;
  return getOne(`
    SELECT r.id, rt.archived_at
    FROM records r
    LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
    WHERE r.tenant_id = $1 AND r.id = $2
    ${lock ? 'FOR UPDATE OF r' : ''}
  `, [tenantId, recordId]);
}

export async function getRecordLifecycles({ tenantId, recordIds, tx = null, lock = false }) {
  const getAll = tx?.queryAll || queryAll;
  return getAll(`
    SELECT r.id, rt.archived_at
    FROM records r
    LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
    WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])
    ORDER BY r.id
    ${lock ? 'FOR UPDATE OF r' : ''}
  `, [tenantId, recordIds]);
}

export function sendRecordArchived(res, recordIds = []) {
  return res.status(409).json({
    ok: false,
    error: RECORD_ARCHIVED_ERROR,
    message: RECORD_ARCHIVED_MESSAGE,
    recordIds,
  });
}
