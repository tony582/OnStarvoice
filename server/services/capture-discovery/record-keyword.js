// A phone finds a post under a search keyword; a browser then opens that post
// by its link to read the detail. The browser's upload therefore carries no
// keyword. The keyword lives in the discovery ledger and is read from there.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DISCOVERED_POST_WORKFLOW = 'discovered_post_capture';

function text(value, limit = 200) {
  return String(value ?? '').trim().slice(0, limit);
}

/**
 * The keyword a detail capture of a phone-discovered post is stored under: the
 * one of the earliest discovery of that post, which is the discovery that put
 * it in the detail queue. '' for every other kind of capture task.
 */
export async function readDiscoveryCaptureKeyword(tx, {tenantId, captureTaskId} = {}) {
  if (!UUID.test(String(tenantId || '')) || !UUID.test(String(captureTaskId || ''))) return '';
  const task = await tx.queryOne(`
    SELECT metadata->>'workflow' AS workflow, metadata->>'candidateId' AS candidate_id
    FROM capture_tasks
    WHERE tenant_id = $1 AND id = $2
  `, [tenantId, captureTaskId]);
  if (task?.workflow !== DISCOVERED_POST_WORKFLOW || !UUID.test(String(task.candidate_id || ''))) return '';
  const event = await tx.queryOne(`
    SELECT keyword
    FROM capture_discovery_events
    WHERE tenant_id = $1 AND candidate_id = $2 AND BTRIM(keyword) <> ''
    ORDER BY discovered_at, received_at, id
    LIMIT 1
  `, [tenantId, task.candidate_id]);
  return text(event?.keyword);
}

/**
 * Every keyword phones found this post under, earliest discovery first. Used
 * to show the keyword of posts stored before it was written to the record.
 */
export async function listRecordDiscoveryKeywords(executor, {tenantId, recordId, limit = 10} = {}) {
  if (!UUID.test(String(tenantId || '')) || !UUID.test(String(recordId || ''))) return [];
  const rows = await executor.queryAll(`
    SELECT event.keyword
    FROM capture_discovery_candidates candidate
    JOIN capture_discovery_events event
      ON event.tenant_id = candidate.tenant_id AND event.candidate_id = candidate.id
    WHERE candidate.tenant_id = $1 AND candidate.record_id = $2 AND BTRIM(event.keyword) <> ''
    GROUP BY event.keyword
    ORDER BY MIN(event.discovered_at), event.keyword
    LIMIT $3
  `, [tenantId, recordId, Math.min(50, Math.max(1, Number(limit) || 10))]);
  return rows.map(row => text(row.keyword)).filter(Boolean);
}
