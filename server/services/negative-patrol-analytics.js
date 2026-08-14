import {queryAll, queryOne} from '../db/init.js';

const UNAVAILABLE_STATUSES = new Set([
  'deleted',
  'page_unavailable',
  'unavailable',
  'not_found',
]);

const NEGATIVE_PATROL_TASK_SQL = alias => `(
  ${alias}.task_type = 'negative_post_patrol'
  OR ${alias}.feature_key = 'negative_post_patrol'
  OR ${alias}.metadata->>'workflow' = 'negative_post_patrol'
  OR ${alias}.metadata->>'taskKind' = 'negative_post_patrol'
  OR ${alias}.metadata->>'businessTaskType' = 'negative_post_patrol'
)`;

const WATCHED_CONTENT_PATROL_TASK_SQL = alias => `(
  ${alias}.task_type = 'watched_content_patrol'
  OR ${alias}.feature_key = 'watched_content_patrol'
  OR ${alias}.metadata->>'workflow' = 'watched_content_patrol'
  OR ${alias}.metadata->>'taskKind' = 'watched_content_patrol'
  OR ${alias}.metadata->>'businessTaskType' = 'watched_content_patrol'
)`;

const CONTENT_PATROL_TASK_SQL = alias => `(
  ${NEGATIVE_PATROL_TASK_SQL(alias)}
  OR ${WATCHED_CONTENT_PATROL_TASK_SQL(alias)}
)`;

const JSON_NUMBER_RE = "'^-?[0-9]+([.][0-9]+)?$'";

function jsonNumberSql(expression) {
  return `CASE
    WHEN (${expression}) ~ ${JSON_NUMBER_RE}
      THEN (${expression})::numeric
    ELSE NULL
  END`;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function metricSnapshot(row, prefix) {
  const id = row?.[`${prefix}_id`];
  if (!id) return null;
  const capturedAt = row[`${prefix}_captured_at`] || null;
  const likes = numberOrNull(row[`${prefix}_likes`]) ?? 0;
  const comments = numberOrNull(row[`${prefix}_comments`]) ?? 0;
  const collects = numberOrNull(row[`${prefix}_collects`]) ?? 0;
  const shares = numberOrNull(row[`${prefix}_shares`]) ?? 0;
  const interactionTotal =
    numberOrNull(row[`${prefix}_interaction_total`])
    ?? (likes + comments + collects + shares);
  return {
    id,
    observationId: id,
    captured_at: capturedAt,
    capturedAt,
    likes,
    comments_count: comments,
    comments,
    collects,
    shares,
    interaction_total: interactionTotal,
    interactionTotal,
  };
}

export function calculateNegativePatrolDelta(baseline, endpoint) {
  if (!baseline || !endpoint) return null;
  const delta = {
    likes: Number(endpoint.likes || 0) - Number(baseline.likes || 0),
    comments:
      Number(endpoint.comments ?? endpoint.comments_count ?? 0)
      - Number(baseline.comments ?? baseline.comments_count ?? 0),
    collects: Number(endpoint.collects || 0) - Number(baseline.collects || 0),
    shares: Number(endpoint.shares || 0) - Number(baseline.shares || 0),
    interactionTotal:
      Number(endpoint.interactionTotal ?? endpoint.interaction_total ?? 0)
      - Number(baseline.interactionTotal ?? baseline.interaction_total ?? 0),
  };
  return {
    ...delta,
    comments_count: delta.comments,
    interaction_total: delta.interactionTotal,
  };
}

function addDelta(sum, delta) {
  if (!delta) return sum;
  return {
    likes: sum.likes + delta.likes,
    comments: sum.comments + delta.comments,
    collects: sum.collects + delta.collects,
    shares: sum.shares + delta.shares,
    interactionTotal: sum.interactionTotal + delta.interactionTotal,
  };
}

function exposeDelta(delta) {
  if (!delta) return null;
  return {
    ...delta,
    comments_count: delta.comments,
    interaction_total: delta.interactionTotal,
  };
}

function negativePatrolStatus(row) {
  const availabilityStatus = String(
    row.availability_status || row.availabilityStatus || 'unknown',
  ).toLowerCase();
  if (UNAVAILABLE_STATUSES.has(availabilityStatus)) return 'unavailable';
  return row.measured ? 'available' : 'baseline_pending';
}

function sumMeasuredDeltas(rows) {
  const measured = rows.filter(row => row.delta);
  if (!measured.length) return null;
  return exposeDelta(measured.reduce(
    (sum, row) => addDelta(sum, row.delta),
    {likes: 0, comments: 0, collects: 0, shares: 0, interactionTotal: 0},
  ));
}

export function summarizeNegativePatrolRows(rows = []) {
  const normalized = rows.map(row => {
    const baseline = row.baseline || metricSnapshot(row, 'baseline');
    const endpoint = row.endpoint || metricSnapshot(row, 'endpoint');
    const normalizedRow = {
      ...row,
      baseline,
      endpoint,
      measured: Boolean(baseline && endpoint),
      delta: calculateNegativePatrolDelta(baseline, endpoint),
    };
    const patrolStatus = negativePatrolStatus(normalizedRow);
    return {
      ...normalizedRow,
      patrolStatus,
      patrol_status: patrolStatus,
    };
  });
  const availability = {};
  for (const row of normalized) {
    const status = row.availability_status || row.availabilityStatus || 'unknown';
    availability[status] = (availability[status] || 0) + 1;
  }
  return {
    rows: normalized,
    summary: {
      negativePostVolume: normalized.length,
      measuredPosts: normalized.filter(row => row.measured).length,
      unmeasuredPosts: normalized.filter(row => !row.measured).length,
      interactionDelta: sumMeasuredDeltas(normalized),
      availability,
    },
  };
}

function mapAnalyticsRow(row) {
  const baseline = metricSnapshot(row, 'baseline');
  const endpoint = metricSnapshot(row, 'endpoint');
  const activityAt = row.activity_at || null;
  const availabilityStatus = row.availability_status || 'unknown';
  const availabilityReason = row.availability_reason || '';
  return {
    recordId: row.record_id,
    record_id: row.record_id,
    title: row.title || '',
    platform: row.platform || 'unknown',
    keyword: row.keyword || '',
    category: row.category || 'other',
    url: row.url || '',
    activityAt,
    activity_at: activityAt,
    availabilityStatus,
    availability_status: availabilityStatus,
    availabilityReason,
    availability_reason: availabilityReason,
    baseline,
    endpoint,
    measured: Boolean(baseline && endpoint),
    delta: calculateNegativePatrolDelta(baseline, endpoint),
  };
}

function aggregateBy(rows, key, labelKey) {
  const map = new Map();
  for (const row of rows) {
    const label = row[key] || 'unknown';
    const current = map.get(label) || {
      [labelKey]: label,
      negativePostVolume: 0,
      measuredPosts: 0,
      unmeasuredPosts: 0,
      __delta: null,
    };
    current.negativePostVolume += 1;
    if (row.measured) {
      current.measuredPosts += 1;
    } else {
      current.unmeasuredPosts += 1;
    }
    if (row.delta) {
      current.__delta = addDelta(
        current.__delta || {
          likes: 0,
          comments: 0,
          collects: 0,
          shares: 0,
          interactionTotal: 0,
        },
        row.delta,
      );
    }
    current.interactionDelta = exposeDelta(current.__delta);
    map.set(label, current);
  }
  return [...map.values()]
    .map(({__delta, ...row}) => row)
    .sort((a, b) => b.negativePostVolume - a.negativePostVolume);
}

function activityTimestamp(row) {
  const timestamp = Date.parse(row.activityAt || row.activity_at || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function latestRowsByRecord(rows = []) {
  const rowsByRecord = new Map();
  const rowsWithoutRecord = [];
  for (const row of rows) {
    const recordId = row.recordId || row.record_id || '';
    if (!recordId) {
      rowsWithoutRecord.push(row);
      continue;
    }
    const current = rowsByRecord.get(recordId);
    if (!current || activityTimestamp(row) >= activityTimestamp(current)) {
      rowsByRecord.set(recordId, row);
    }
  }
  return [...rowsByRecord.values(), ...rowsWithoutRecord];
}

function baselineSelectSql(alias) {
  return `
    NULLIF(${alias}.metadata->'baseline'->>'observationId', '') AS baseline_id,
    COALESCE(
      baseline.captured_at::text,
      NULLIF(${alias}.metadata->'baseline'->>'capturedAt', '')
    ) AS baseline_captured_at,
    COALESCE(
      baseline.likes,
      ${jsonNumberSql(`${alias}.metadata#>>'{baseline,metrics,likes}'`)}
    ) AS baseline_likes,
    COALESCE(
      baseline.comments_count,
      ${jsonNumberSql(`${alias}.metadata#>>'{baseline,metrics,comments}'`)}
    ) AS baseline_comments,
    COALESCE(
      baseline.collects,
      ${jsonNumberSql(`${alias}.metadata#>>'{baseline,metrics,collects}'`)}
    ) AS baseline_collects,
    COALESCE(
      baseline.shares,
      ${jsonNumberSql(`${alias}.metadata#>>'{baseline,metrics,shares}'`)}
    ) AS baseline_shares,
    COALESCE(
      baseline.interaction_total,
      COALESCE(${jsonNumberSql(`${alias}.metadata#>>'{baseline,metrics,likes}'`)}, 0)
        + COALESCE(${jsonNumberSql(`${alias}.metadata#>>'{baseline,metrics,comments}'`)}, 0)
        + COALESCE(${jsonNumberSql(`${alias}.metadata#>>'{baseline,metrics,collects}'`)}, 0)
        + COALESCE(${jsonNumberSql(`${alias}.metadata#>>'{baseline,metrics,shares}'`)}, 0)
    ) AS baseline_interaction_total`;
}

function endpointSelectSql() {
  return `
    endpoint.id AS endpoint_id,
    endpoint.captured_at AS endpoint_captured_at,
    endpoint.likes AS endpoint_likes,
    endpoint.comments_count AS endpoint_comments,
    endpoint.collects AS endpoint_collects,
    endpoint.shares AS endpoint_shares,
    endpoint.interaction_total AS endpoint_interaction_total`;
}

function baselineJoinSql(alias, recordExpression) {
  return `
    LEFT JOIN record_observations baseline
      ON baseline.id::text = NULLIF(${alias}.metadata->'baseline'->>'observationId', '')
     AND baseline.tenant_id = ${alias}.tenant_id
     AND baseline.record_id = ${recordExpression}`;
}

export async function getNegativePatrolAnalytics({
  tenantId,
  periodStart,
  periodEnd,
  keywords = [],
  platform = '',
  status = '',
  db = {queryAll},
}) {
  const rows = await db.queryAll(`
    WITH scoped_items AS (
      SELECT
        item.*,
        COALESCE(item.result_record_id, item.record_id) AS scoped_record_id,
        COALESCE(item.finished_at, item.started_at, item.updated_at, item.created_at) AS activity_at
      FROM capture_task_items item
      JOIN capture_tasks parent_task
        ON parent_task.id = item.task_id
       AND parent_task.tenant_id = item.tenant_id
      LEFT JOIN capture_tasks execution_task
        ON execution_task.id = item.execution_task_id
       AND execution_task.tenant_id = item.tenant_id
      WHERE item.tenant_id = $1
        AND COALESCE(item.result_record_id, item.record_id) IS NOT NULL
        AND COALESCE(item.finished_at, item.started_at, item.updated_at, item.created_at) >= $2
        AND COALESCE(item.finished_at, item.started_at, item.updated_at, item.created_at) < $3
        AND (${NEGATIVE_PATROL_TASK_SQL('parent_task')}
          OR ${NEGATIVE_PATROL_TASK_SQL('execution_task')})
    ),
    latest_items AS (
      SELECT DISTINCT ON (scoped_record_id)
        *
      FROM scoped_items
      ORDER BY scoped_record_id, activity_at DESC, updated_at DESC, id DESC
    )
    SELECT
      record.id AS record_id,
      record.title,
      record.platform,
      record.keyword,
      record.category,
      record.url,
      latest.activity_at,
      COALESCE(
        NULLIF(latest.metadata->'targetResult'->>'availabilityStatus', ''),
        record.content_availability_status,
        'unknown'
      ) AS availability_status,
      COALESCE(
        NULLIF(latest.metadata->'targetResult'->>'availabilityReason', ''),
        record.content_availability_reason,
        ''
      ) AS availability_reason,
      ${baselineSelectSql('latest')},
      ${endpointSelectSql()}
    FROM latest_items latest
    JOIN records record
      ON record.id = latest.scoped_record_id
     AND record.tenant_id = latest.tenant_id
    ${baselineJoinSql('latest', 'latest.scoped_record_id')}
    LEFT JOIN record_observations endpoint
      ON endpoint.id = latest.result_observation_id
     AND endpoint.tenant_id = latest.tenant_id
     AND endpoint.record_id = latest.scoped_record_id
    WHERE (cardinality($4::text[]) = 0 OR record.keyword = ANY($4::text[]))
      AND ($5::text = '' OR record.platform = $5)
    ORDER BY latest.activity_at DESC, record.id
  `, [
    tenantId,
    periodStart.toISOString(),
    periodEnd.toISOString(),
    keywords,
    platform,
  ]);
  const normalized = summarizeNegativePatrolRows(
    latestRowsByRecord(rows.map(mapAnalyticsRow)),
  ).rows;
  const platformRows = platform
    ? normalized.filter(row => row.platform === platform)
    : normalized;
  const filteredRows = status
    ? platformRows.filter(row => row.patrolStatus === status)
    : platformRows;
  const summarized = summarizeNegativePatrolRows(filteredRows);
  const statusCounts = ['available', 'unavailable', 'baseline_pending'].map(
    patrolStatus => ({
      status: patrolStatus,
      count: filteredRows.filter(row => row.patrolStatus === patrolStatus).length,
    }),
  );
  const trend = aggregateBy(
    filteredRows.map(row => ({
      ...row,
      day: String(row.activityAt || '').slice(0, 10),
    })),
    'day',
    'date',
  ).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    keywords,
    filters: {
      platform,
      status,
      keywords,
    },
    summary: {
      ...summarized.summary,
      unavailableCurrent: filteredRows.filter(
        row => row.patrolStatus === 'unavailable',
      ).length,
      unavailable_current: filteredRows.filter(
        row => row.patrolStatus === 'unavailable',
      ).length,
      baselinePending: filteredRows.filter(
        row => row.patrolStatus === 'baseline_pending',
      ).length,
      baseline_pending: filteredRows.filter(
        row => row.patrolStatus === 'baseline_pending',
      ).length,
      // No reliable, normalized risk-level field exists for patrol items yet.
      highRisk: null,
      high_risk: null,
    },
    trend,
    status: statusCounts,
    platforms: aggregateBy(filteredRows, 'platform', 'platform'),
    topics: aggregateBy(filteredRows, 'keyword', 'keyword'),
    risingRecords: filteredRows
      .sort((a, b) => {
        if (a.measured !== b.measured) return a.measured ? -1 : 1;
        const deltaDiff =
          Number(b.delta?.interactionTotal || 0)
          - Number(a.delta?.interactionTotal || 0);
        if (deltaDiff) return deltaDiff;
        return new Date(b.activityAt || 0) - new Date(a.activityAt || 0);
      })
      .slice(0, 20),
  };
}

function mapTimelineRun(row) {
  const baseline = metricSnapshot(row, 'baseline');
  const endpoint = metricSnapshot(row, 'endpoint');
  const id = row.item_id;
  const agentName = row.agent_name || '';
  const startedAt = row.started_at || null;
  const finishedAt = row.finished_at || null;
  const availabilityStatus = row.availability_status || 'unknown';
  const availabilityReason = row.availability_reason || '';
  const errorMessage = row.error_message || null;
  const workflow = row.workflow || 'negative_post_patrol';
  return {
    id,
    itemId: id,
    item_id: id,
    taskId: row.task_id,
    task_id: row.task_id,
    executionTaskId: row.execution_task_id,
    execution_task_id: row.execution_task_id,
    agentId: row.agent_id || null,
    agent_id: row.agent_id || null,
    agentName,
    agent_name: agentName,
    status: row.status,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    startedAt,
    started_at: startedAt,
    finishedAt,
    finished_at: finishedAt,
    availabilityStatus,
    availability_status: availabilityStatus,
    availabilityReason,
    availability_reason: availabilityReason,
    errorMessage,
    error_message: errorMessage,
    workflow,
    workflowLabel: workflow === 'watched_content_patrol'
      ? '关注内容巡查'
      : '负面帖子巡查',
    baseline,
    endpoint,
    measured: Boolean(baseline && endpoint),
    delta: calculateNegativePatrolDelta(baseline, endpoint),
  };
}

export function summarizeNegativePatrolTimeline(runs = [], snapshots = []) {
  const latestComparableRun = runs.find(run => run.measured) || null;
  const firstPatrolledAt = [...runs]
    .reverse()
    .find(run => run.started_at || run.created_at)?.started_at
    || [...runs].reverse().find(run => run.created_at)?.created_at
    || null;
  const lastRun = runs[0] || null;
  const availabilityStatus =
    lastRun?.availability_status
    || lastRun?.availabilityStatus
    || 'unknown';
  return {
    patrolCount: runs.length,
    runCount: runs.length,
    snapshotCount: snapshots.length,
    measuredRuns: runs.filter(run => run.measured).length,
    unmeasuredRuns: runs.filter(run => !run.measured).length,
    firstPatrolledAt,
    lastPatrolledAt:
      lastRun?.finished_at
      || lastRun?.updated_at
      || lastRun?.started_at
      || lastRun?.created_at
      || null,
    latestStatus: lastRun?.status || null,
    availabilityStatus,
    latestComparableRunId: latestComparableRun?.id || null,
    delta: latestComparableRun?.delta || null,
  };
}

async function getPatrolPostTimeline({
  tenantId,
  recordId,
  db = {queryAll, queryOne},
  includeWatched = false,
}) {
  const record = await db.queryOne(`
    SELECT
      id, title, platform, keyword, category, url,
      content_availability_status, content_availability_checked_at,
      content_availability_reason
    FROM records
    WHERE tenant_id = $1 AND id = $2
  `, [tenantId, recordId]);
  if (!record) return null;

  const rows = await db.queryAll(`
    SELECT
      item.id AS item_id,
      item.task_id,
      item.execution_task_id,
      item.assigned_agent_id AS agent_id,
      COALESCE(
        NULLIF(agent.display_name, ''),
        NULLIF(agent.client_label, ''),
        agent.id::text,
        ''
      ) AS agent_name,
      item.status,
      item.created_at,
      item.updated_at,
      item.started_at,
      item.finished_at,
      CASE
        WHEN ${WATCHED_CONTENT_PATROL_TASK_SQL('parent_task')}
          OR ${WATCHED_CONTENT_PATROL_TASK_SQL('execution_task')}
        THEN 'watched_content_patrol'
        ELSE 'negative_post_patrol'
      END AS workflow,
      COALESCE(
        NULLIF(item.error->>'message', ''),
        NULLIF(item.error->>'error', ''),
        NULLIF(item.error#>>'{details,message}', ''),
        NULLIF(item.metadata->>'errorMessage', ''),
        NULLIF(execution_task.error->>'message', ''),
        NULLIF(execution_task.message, ''),
        NULLIF(parent_task.error->>'message', ''),
        NULLIF(parent_task.message, '')
      ) AS error_message,
      COALESCE(
        NULLIF(item.metadata->'targetResult'->>'availabilityStatus', ''),
        record.content_availability_status,
        'unknown'
      ) AS availability_status,
      COALESCE(
        NULLIF(item.metadata->'targetResult'->>'availabilityReason', ''),
        record.content_availability_reason,
        ''
      ) AS availability_reason,
      ${baselineSelectSql('item')},
      ${endpointSelectSql()}
    FROM capture_task_items item
    JOIN capture_tasks parent_task
      ON parent_task.id = item.task_id
     AND parent_task.tenant_id = item.tenant_id
    LEFT JOIN capture_tasks execution_task
      ON execution_task.id = item.execution_task_id
     AND execution_task.tenant_id = item.tenant_id
    LEFT JOIN capture_agents agent
      ON agent.id = item.assigned_agent_id
     AND agent.tenant_id = item.tenant_id
    JOIN records record
      ON record.id = COALESCE(item.result_record_id, item.record_id)
     AND record.tenant_id = item.tenant_id
    ${baselineJoinSql('item', 'record.id')}
    LEFT JOIN record_observations endpoint
      ON endpoint.id = item.result_observation_id
     AND endpoint.tenant_id = item.tenant_id
     AND endpoint.record_id = record.id
    WHERE item.tenant_id = $1
      AND COALESCE(item.result_record_id, item.record_id) = $2
      AND (${includeWatched ? CONTENT_PATROL_TASK_SQL('parent_task') : NEGATIVE_PATROL_TASK_SQL('parent_task')}
        OR ${includeWatched ? CONTENT_PATROL_TASK_SQL('execution_task') : NEGATIVE_PATROL_TASK_SQL('execution_task')})
    ORDER BY COALESCE(item.finished_at, item.updated_at, item.created_at) DESC, item.id DESC
  `, [tenantId, recordId]);
  const runs = rows.map(mapTimelineRun);
  const snapshots = [];
  const seen = new Set();
  for (const run of runs) {
    for (const snapshot of [run.baseline, run.endpoint]) {
      if (!snapshot || seen.has(snapshot.id)) continue;
      seen.add(snapshot.id);
      snapshots.push(snapshot);
    }
  }
  snapshots.sort(
    (a, b) =>
      new Date(a.captured_at || a.capturedAt || 0)
      - new Date(b.captured_at || b.capturedAt || 0),
  );
  const availabilityStatus = record.content_availability_status || 'unknown';
  const availabilityCheckedAt =
    record.content_availability_checked_at || null;
  const availabilityReason = record.content_availability_reason || '';
  return {
    record: {
      id: record.id,
      title: record.title || '',
      platform: record.platform || 'unknown',
      keyword: record.keyword || '',
      category: record.category || 'other',
      url: record.url || '',
      availabilityStatus,
      availability_status: availabilityStatus,
      availabilityCheckedAt,
      availability_checked_at: availabilityCheckedAt,
      availabilityReason,
      availability_reason: availabilityReason,
    },
    summary: summarizeNegativePatrolTimeline(runs, snapshots),
    snapshots,
    runs,
  };
}

export function getNegativePatrolPostTimeline(options) {
  return getPatrolPostTimeline({...options, includeWatched: false});
}

export function getContentPatrolPostTimeline(options) {
  return getPatrolPostTimeline({...options, includeWatched: true});
}

export const __negativePatrolAnalyticsInternals = {
  NEGATIVE_PATROL_TASK_SQL,
  WATCHED_CONTENT_PATROL_TASK_SQL,
  CONTENT_PATROL_TASK_SQL,
  UNAVAILABLE_STATUSES,
  latestRowsByRecord,
  negativePatrolStatus,
  numberOrNull,
  jsonNumberSql,
};
