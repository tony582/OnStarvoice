const DAY_MS = 24 * 60 * 60 * 1000;
const PLATFORMS = new Set(['xiaohongshu', 'douyin']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE = new Set(['deleted', 'page_unavailable', 'unavailable', 'not_found']);
const EXCLUDED_TRIAGE = new Set(['reviewed_non_monitor', 'unavailable', 'false_positive']);
const TERMINAL_TASKS = [
  'completed', 'completed_with_warnings', 'completed_with_failures', 'failed',
  'canceled', 'skipped', 'superseded', 'interrupted', 'needs_action',
];

const text = value => String(value ?? '').trim();
const lower = value => text(value).toLowerCase();
const strings = values => [...new Set((Array.isArray(values) ? values : [])
  .map(text).filter(Boolean))];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const timestamp = value => value instanceof Date ? value.getTime() : Date.parse(value);

function instant(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || !Number.isFinite(date.getTime())) {
    throw Object.assign(new Error(`${name} must be a valid timestamp`), {
      code: 'invalid_negative_patrol_scope', status: 400,
    });
  }
  return date;
}

export function normalizeUnattendedNegativePatrolScope(input = {}) {
  const tenantId = text(input.tenantId);
  if (!UUID_RE.test(tenantId)) throw Object.assign(new Error('tenantId is required'), {
    code: 'invalid_negative_patrol_scope', status: 400,
  });
  const platforms = strings(input.platforms || (input.platform ? [input.platform] : []))
    .map(lower);
  if (!platforms.length || platforms.some(platform => !PLATFORMS.has(platform))) {
    throw Object.assign(new Error('negative patrol requires supported platforms'), {
      code: 'invalid_negative_patrol_scope', status: 400,
    });
  }
  const timezone = text(input.timezone) || 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en', {timeZone: timezone}).format(); }
  catch { throw Object.assign(new Error('invalid patrol timezone'), {
    code: 'invalid_negative_patrol_scope', status: 400,
  }); }
  const end = instant(input.runStartedAt || input.windowEnd, 'runStartedAt');
  const keywordIds = strings(input.keywordIds);
  if (keywordIds.some(id => !UUID_RE.test(id))) throw Object.assign(new Error('invalid keywordIds'), {
    code: 'invalid_negative_patrol_scope', status: 400,
  });
  return {
    tenantId, platforms: [...new Set(platforms)], keywords: strings(input.keywords),
    keywordIds, timezone, runStartedAt: end.toISOString(),
    windowStart: new Date(end.getTime() - 7 * DAY_MS).toISOString(),
    windowEnd: end.toISOString(), lookbackDays: 7,
  };
}

export function negativePatrolCalendarDate(value, timezone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant(value, 'date'));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function addCalendarDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function override(record, key) {
  const overrides = object(record.manual_overrides);
  const present = Object.hasOwn(overrides, key);
  const raw = overrides[key];
  return {present, value: lower(typeof raw === 'object' && raw !== null ? raw.value : raw)};
}

export function unattendedNegativePatrolTargetUrl(record = {}) {
  const platform = lower(record.platform);
  const externalId = text(record.external_id || record.externalId);
  if (!PLATFORMS.has(platform) || !/^[a-z0-9_-]{5,200}$/i.test(externalId)) return '';
  for (const raw of [record.url, record.canonical_url, record.canonicalUrl]) {
    try {
      const url = new URL(raw);
      const base = platform === 'douyin' ? 'douyin.com' : 'xiaohongshu.com';
      if (url.protocol !== 'https:' || url.username || url.password
        || (url.port && url.port !== '443')
        || !(url.hostname === base || url.hostname.endsWith(`.${base}`))) continue;
      const match = platform === 'douyin'
        ? url.pathname.match(/^\/(?:video|note)\/([a-z0-9_-]+)\/?$/i)
        : url.pathname.match(/^\/(?:explore|discovery\/item|note|video|search_result)\/([a-z0-9_-]+)\/?$/i)
          || url.pathname.match(/^\/user\/profile\/[a-z0-9_-]+\/([a-z0-9_-]+)\/?$/i);
      if (match?.[1] !== externalId) continue;
      if (platform === 'xiaohongshu' && url.searchParams.has('xsec_token')
        && !url.searchParams.has('xsec_source')) url.searchParams.set('xsec_source', 'pc_search');
      return url.toString();
    } catch { /* A valid platform identity can still produce a canonical URL. */ }
  }
  if (platform === 'xiaohongshu') return `https://www.xiaohongshu.com/explore/${encodeURIComponent(externalId)}`;
  return `https://www.douyin.com/${['image', 'images', 'note', '图文'].includes(lower(record.note_type)) ? 'note' : 'video'}/${encodeURIComponent(externalId)}`;
}

export function unattendedNegativePatrolCadence(record = {}, state = {}) {
  if (['high', 'urgent'].includes(lower(record.triage_priority || record.priority))) return 1;
  const status = lower(record.triage_status || 'unhandled');
  if (['replied', 'negative_feishu', 'official_responded'].includes(status)) return 3;
  if (['reviewed', 'negative_cold'].includes(status)
    && Number(state.stable_success_count || 0) > 0) return 7;
  return 1;
}

export function negativePatrolEffectiveRotationState(state = {}, record = {}) {
  const formalAt = record.latest_formal_success_at;
  if (!formalAt || (state.last_success_at
    && timestamp(state.last_success_at) >= timestamp(formalAt))) return state;
  return {...state, last_success_at: formalAt,
    stable_success_count: record.latest_formal_stable === true ? 1 : 0,
    last_result_observation_id: record.latest_formal_observation_id || null};
}

export function evaluateUnattendedNegativePatrolRecord(record, scopeInput, state = {}, now) {
  const scope = normalizeUnattendedNegativePatrolScope(scopeInput);
  state = negativePatrolEffectiveRotationState(state, record);
  const checkedAt = instant(now || scope.runStartedAt, 'now');
  const fail = reason => ({eligible: false, due: false, reason});
  if (text(record.tenant_id) !== scope.tenantId) return fail('tenant_mismatch');
  if (!scope.platforms.includes(lower(record.platform))) return fail('platform_out_of_scope');
  if (!(timestamp(record.created_at) < timestamp(scope.windowEnd))) return fail('discovered_this_run');
  const sentiment = override(record, 'sentiment');
  if (sentiment.present && !['negative', 'neutral', 'positive'].includes(sentiment.value)) return fail('manual_sentiment_invalid');
  if ((sentiment.present ? sentiment.value : lower(record.sentiment)) !== 'negative') return fail('not_negative');
  const publishedAt = timestamp(record.published_ts);
  if (!text(record.publish_time) || !Number.isFinite(publishedAt)) return fail('publish_time_unknown');
  if (publishedAt < timestamp(scope.windowStart) || publishedAt >= timestamp(scope.windowEnd)) return fail('outside_window');
  if (['official_content', 'blogger_profile'].includes(record.record_type)) return fail('official_content');
  if (record.archived_at) return fail('archived');
  if (EXCLUDED_TRIAGE.has(lower(record.triage_status))) return fail(`triage_${lower(record.triage_status)}`);
  if (UNAVAILABLE.has(lower(record.content_availability_status))) return fail('content_unavailable');
  const relevance = override(record, 'relevance');
  if (relevance.present && !['relevant', 'irrelevant', 'uncertain'].includes(relevance.value)) return fail('manual_relevance_invalid');
  if (relevance.present && relevance.value === 'irrelevant') return fail('manual_irrelevant');
  // Explicit administrator corrections follow the existing negative-patrol
  // qualification rules; an exclusion triage state remains authoritative.
  const manuallyNegative = sentiment.present && sentiment.value === 'negative';
  const manuallyRelevant = relevance.present && ['relevant', 'uncertain'].includes(relevance.value);
  if (record.false_positive_pending && !manuallyNegative) return fail('false_positive_pending');
  if (!manuallyNegative && !manuallyRelevant && (record.business_visibility !== 'eligible'
    || lower(object(record.ai_result).relevance) === 'irrelevant')) return fail('business_ineligible');
  const url = unattendedNegativePatrolTargetUrl(record);
  if (!url) return fail('source_unresolvable');
  const cadenceDays = unattendedNegativePatrolCadence(record, state);
  const lastSuccessAt = state.last_success_at || null;
  const nextDueDate = lastSuccessAt
    ? addCalendarDays(negativePatrolCalendarDate(lastSuccessAt, scope.timezone), cadenceDays) : null;
  const currentDate = negativePatrolCalendarDate(checkedAt, scope.timezone);
  const dateDue = !nextDueDate || currentDate >= nextDueDate;
  const cooldown = state.cooldown_until && timestamp(state.cooldown_until) > checkedAt.getTime();
  const due = dateDue && !cooldown && !state.needs_action;
  return {
    eligible: true, due, url, cadenceDays, nextDueDate, lastSuccessAt,
    sharedResultObservationId: record.latest_formal_observation_id || null,
    reason: state.needs_action ? 'needs_action' : cooldown ? 'cooldown'
      : !dateDue ? 'not_due' : lastSuccessAt ? 'due' : 'first_patrol',
  };
}

const STATE_SELECT = `state.last_success_at, state.next_due_date,
  state.stable_success_count, state.cooldown_until,
  state.needs_action,
  state.failure_count, state.lease_item_id, state.lease_execution_task_id,
  state.lease_assignment_revision, state.first_eligible_at`;

const EFFECTIVE_NEGATIVE_SQL = `LOWER(BTRIM(COALESCE(CASE
  WHEN COALESCE(r.manual_overrides, '{}'::jsonb) ? 'sentiment' THEN
    CASE WHEN jsonb_typeof(r.manual_overrides->'sentiment') = 'object'
      THEN r.manual_overrides->'sentiment'->>'value'
      ELSE r.manual_overrides->>'sentiment' END
  ELSE r.sentiment END, ''))) = 'negative'`;

const KEYWORD_SCOPE_SQL = `(r.keyword = ANY($5::text[]) OR EXISTS (
  SELECT 1 FROM record_observations scope_observation
  WHERE scope_observation.tenant_id = r.tenant_id AND scope_observation.record_id = r.id
    AND scope_observation.keyword = ANY($5::text[]) AND scope_observation.captured_at < $3::timestamptz
))`;

function recordSelectSql({single = false} = {}) {
  return `SELECT r.*, COALESCE(triage.status, 'unhandled') AS triage_status,
    COALESCE(triage.priority, 'normal') AS triage_priority, triage.archived_at,
    ${STATE_SELECT},
    formal.latest_formal_success_at, formal.latest_formal_observation_id,
    formal.latest_formal_stable,
    EXISTS (SELECT 1 FROM record_feedback feedback
      WHERE feedback.tenant_id = r.tenant_id AND feedback.record_id = r.id
        AND feedback.feedback_type = 'false_positive'
        AND feedback.review_status = 'pending') AS false_positive_pending,
    baseline.id AS baseline_observation_id, baseline.captured_at AS baseline_captured_at,
    baseline.likes AS baseline_likes, baseline.comments_count AS baseline_comments,
    baseline.collects AS baseline_collects, baseline.shares AS baseline_shares
  FROM records r
  LEFT JOIN record_triage triage ON triage.tenant_id = r.tenant_id AND triage.record_id = r.id
  LEFT JOIN unattended_negative_patrol_state state ON state.tenant_id = r.tenant_id
    AND state.platform = r.platform AND state.external_id = r.external_id
  LEFT JOIN LATERAL (
    SELECT formal_observation.captured_at AS latest_formal_success_at,
      formal_observation.id AS latest_formal_observation_id,
      COALESCE(formal_baseline.id IS NOT NULL
        AND formal_baseline.captured_at < formal_observation.captured_at
        AND formal_baseline.likes = formal_observation.likes
        AND formal_baseline.comments_count = formal_observation.comments_count
        AND formal_baseline.collects = formal_observation.collects
        AND formal_baseline.shares = formal_observation.shares, false) AS latest_formal_stable
    FROM capture_task_items formal_item
    JOIN capture_tasks formal_execution ON formal_execution.tenant_id = formal_item.tenant_id
      AND formal_execution.id = formal_item.execution_task_id
      AND formal_execution.task_type IN ('negative_post_patrol', 'watched_content_patrol')
    JOIN record_observations formal_observation ON formal_observation.id = formal_item.result_observation_id
      AND formal_observation.tenant_id = formal_item.tenant_id AND formal_observation.record_id = formal_item.record_id
      AND formal_observation.capture_task_id = formal_item.execution_task_id
      AND formal_observation.capture_task_item_id = formal_item.id
    JOIN capture_task_item_attempts formal_attempt ON formal_attempt.id = formal_observation.capture_task_item_attempt_id
      AND formal_attempt.tenant_id = formal_item.tenant_id AND formal_attempt.item_id = formal_item.id
      AND formal_attempt.execution_task_id = formal_item.execution_task_id
      AND formal_attempt.assignment_revision = formal_item.assignment_revision
      AND formal_attempt.attempt_number = formal_item.attempt_count
      AND formal_attempt.status IN ('completed', 'completed_with_warnings')
    LEFT JOIN record_observations formal_baseline
      ON formal_baseline.id::text = formal_item.metadata#>>'{baseline,observationId}'
      AND formal_baseline.tenant_id = formal_item.tenant_id AND formal_baseline.record_id = formal_item.record_id
    WHERE formal_item.tenant_id = r.tenant_id AND formal_item.record_id = r.id
      AND formal_item.item_type IN ('negative_post', 'watched_content')
      AND formal_item.status IN ('completed', 'completed_with_warnings')
    ORDER BY latest_formal_success_at DESC, formal_item.id DESC LIMIT 1
  ) formal ON true
  LEFT JOIN LATERAL (SELECT observation.* FROM record_observations observation
    WHERE observation.tenant_id = r.tenant_id AND observation.record_id = r.id
      AND observation.captured_at < $3::timestamptz
    ORDER BY observation.captured_at DESC, observation.id DESC LIMIT 1) baseline ON true
  WHERE r.tenant_id = $1 AND r.platform = ANY($2::text[])
    AND r.created_at < $3::timestamptz
    AND ${KEYWORD_SCOPE_SQL}
    ${single ? 'AND r.id = $6::uuid AND $4::timestamptz IS NOT NULL' : `AND ${EFFECTIVE_NEGATIVE_SQL}
      AND r.published_ts IS NOT NULL AND NULLIF(BTRIM(r.publish_time), '') IS NOT NULL
      AND ((r.published_ts >= $4::timestamptz AND r.published_ts < $3::timestamptz)
        OR (state.first_eligible_at IS NOT NULL AND state.last_success_at IS NULL))`}
  ORDER BY r.platform, r.published_ts ASC NULLS LAST, r.id
  ${single ? 'FOR SHARE OF r' : ''}`;
}

async function resolveScopeKeywords(tx, scope) {
  if (!scope.keywordIds.length) return scope.keywords;
  const rows = await tx.queryAll(`SELECT keyword FROM monitor_subscriptions
    WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [scope.tenantId, scope.keywordIds]);
  return strings([...scope.keywords, ...rows.map(row => row.keyword)]);
}

function publicCandidate(row, qualification) {
  return {
    id: row.id, recordId: row.id, platform: row.platform, externalId: row.external_id,
    url: qualification.url, title: row.title, publishedAt: row.published_ts,
    noteType: row.note_type, keyword: row.keyword, dueReason: qualification.reason,
    cadenceDays: qualification.cadenceDays, nextDueDate: qualification.nextDueDate,
    lastSuccessAt: qualification.lastSuccessAt,
    sharedResultObservationId: qualification.sharedResultObservationId,
    baseline: {observationId: row.baseline_observation_id || null,
      capturedAt: row.baseline_captured_at || null,
      metrics: {likes: row.baseline_likes ?? row.likes ?? 0,
        comments: row.baseline_comments ?? row.comments_count ?? 0,
        collects: row.baseline_collects ?? row.collects ?? 0,
        shares: row.baseline_shares ?? row.shares ?? 0}},
    sourceRecord: {title: row.title || '', content: text(row.content).slice(0, 1000),
      authorName: row.author_name || '', publishedAt: row.published_ts,
      publishTime: row.publish_time, keyword: row.keyword, noteType: row.note_type},
  };
}

async function ensureState(tx, scope, record) {
  await tx.execute(`INSERT INTO unattended_negative_patrol_state (
      tenant_id, platform, external_id, record_id, first_eligible_at, last_eligible_at
    ) VALUES ($1, $2, $3, $4, $5, $5)
    ON CONFLICT (tenant_id, platform, external_id) DO UPDATE
      SET last_eligible_at = GREATEST(unattended_negative_patrol_state.last_eligible_at, EXCLUDED.last_eligible_at),
        record_id = EXCLUDED.record_id, updated_at = now()`,
  [scope.tenantId, record.platform, record.external_id, record.id, scope.runStartedAt]);
}

export async function loadUnattendedNegativePatrolCandidates(tx, input = {}) {
  const scope = normalizeUnattendedNegativePatrolScope(input);
  const keywords = await resolveScopeKeywords(tx, scope);
  const summary = {eligible: 0, firstPending: 0, due: 0, notDue: 0,
    coolingDown: 0, needsAction: 0, excluded: 0, unknownPublishTime: 0,
    expiringUncovered: 0, outOfWindowUncovered: 0, platforms: {}, exclusionReasons: {}};
  const candidates = [];
  if (!keywords.length) return {...scope, candidates, summary};
  // Unknown publication dates cannot be assigned to the seven-day window.
  // Count them separately without materializing historical payloads or running
  // per-record baseline/formal-result joins on that unbounded history.
  const unknown = await tx.queryOne(`SELECT COUNT(*) AS total FROM records r
    WHERE r.tenant_id = $1 AND r.platform = ANY($2::text[])
      AND r.created_at < $3::timestamptz AND $4::timestamptz IS NOT NULL
      AND ${EFFECTIVE_NEGATIVE_SQL} AND ${KEYWORD_SCOPE_SQL}
      AND (r.published_ts IS NULL OR NULLIF(BTRIM(r.publish_time), '') IS NULL)`,
  [scope.tenantId, scope.platforms, scope.windowEnd, scope.windowStart, keywords]);
  summary.unknownPublishTime = Number(unknown?.total || 0);
  if (summary.unknownPublishTime) summary.exclusionReasons.publish_time_unknown = summary.unknownPublishTime;
  const rows = await tx.queryAll(recordSelectSql(), [scope.tenantId, scope.platforms,
    scope.windowEnd, scope.windowStart, keywords]);
  for (const row of rows) {
    const rotationState = negativePatrolEffectiveRotationState(row, row);
    const result = evaluateUnattendedNegativePatrolRecord(row, scope, rotationState);
    if (!result.eligible) {
      if (result.reason === 'not_negative') continue;
      if (result.reason === 'outside_window' && row.first_eligible_at && !rotationState.last_success_at) {
        summary.outOfWindowUncovered++;
        if (input.persistCandidates === true) await tx.execute(`UPDATE unattended_negative_patrol_state
          SET last_withdrawal_reason = 'window_expired_uncovered', last_withdrawal_at = $4, updated_at = now()
          WHERE tenant_id = $1 AND platform = $2 AND external_id = $3`,
        [scope.tenantId, row.platform, row.external_id, scope.runStartedAt]);
      } else if (result.reason === 'publish_time_unknown') summary.unknownPublishTime++;
      else summary.excluded++;
      summary.exclusionReasons[result.reason] = (summary.exclusionReasons[result.reason] || 0) + 1;
      continue;
    }
    summary.eligible++;
    summary.platforms[row.platform] = (summary.platforms[row.platform] || 0) + 1;
    if (!rotationState.last_success_at && timestamp(row.published_ts) < timestamp(scope.windowStart) + DAY_MS) summary.expiringUncovered++;
    if (result.reason === 'not_due') summary.notDue++;
    else if (result.reason === 'cooldown') summary.coolingDown++;
    else if (result.reason === 'needs_action') summary.needsAction++;
    else if (result.reason === 'first_patrol') summary.firstPending++;
    else if (result.reason === 'due') summary.due++;
    if (input.persistCandidates === true) await ensureState(tx, scope, row);
    if (result.due) candidates.push(publicCandidate(row, result));
  }
  candidates.sort((a, b) => a.platform.localeCompare(b.platform)
    || Number(Boolean(a.lastSuccessAt)) - Number(Boolean(b.lastSuccessAt))
    || timestamp(a.lastSuccessAt || a.publishedAt) - timestamp(b.lastSuccessAt || b.publishedAt)
    || a.recordId.localeCompare(b.recordId));
  return {...scope, candidates, summary};
}

function leaseMatches(state, input) {
  return state?.lease_item_id === input.itemId
    && state.lease_execution_task_id === input.executionTaskId
    && Number(state.lease_assignment_revision) === Number(input.assignmentRevision);
}

export async function claimUnattendedNegativePatrolItem(tx, input = {}) {
  const scope = normalizeUnattendedNegativePatrolScope(input);
  const now = instant(input.now || new Date(), 'now');
  const keywords = await resolveScopeKeywords(tx, scope);
  if (!keywords.length) return {claimed: false, reason: 'keyword_scope_empty'};
  const row = await tx.queryOne(recordSelectSql({single: true}), [scope.tenantId,
    scope.platforms, scope.windowEnd, scope.windowStart, keywords, input.recordId]);
  if (!row) return {claimed: false, reason: 'record_out_of_scope'};
  const lock = await tx.queryOne('SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS locked',
    [scope.tenantId, `${row.platform}:${row.external_id}`]);
  if (lock?.locked !== true) return {claimed: false, reason: 'record_busy'};
  await ensureState(tx, scope, row);
  const state = await tx.queryOne(`SELECT * FROM unattended_negative_patrol_state
    WHERE tenant_id = $1 AND platform = $2 AND external_id = $3 FOR UPDATE`,
  [scope.tenantId, row.platform, row.external_id]);
  if (leaseMatches(state, input)) return {claimed: true, existing: true,
    candidate: publicCandidate(row, evaluateUnattendedNegativePatrolRecord(row, scope, state, now))};
  const qualification = evaluateUnattendedNegativePatrolRecord(row, scope, state, now);
  if (!qualification.eligible || !qualification.due) {
    if (!qualification.eligible) await tx.execute(`UPDATE unattended_negative_patrol_state
      SET last_withdrawal_reason = $4, last_withdrawal_at = $5, updated_at = now()
      WHERE tenant_id = $1 AND platform = $2 AND external_id = $3`,
    [scope.tenantId, row.platform, row.external_id, qualification.reason, now.toISOString()]);
    return {claimed: false, reason: qualification.reason,
      sharedResultObservationId: qualification.sharedResultObservationId || null,
      lastSuccessAt: qualification.lastSuccessAt || null,
      nextDueDate: qualification.nextDueDate || null};
  }
  if (state.lease_execution_task_id) {
    const owner = await tx.queryOne(`SELECT execution.status, item.status AS item_status,
      (execution.metadata->>'stopPending' = 'true'
        OR execution.metadata->>'legacyPackStopPending' = 'true'
        OR execution.metadata->>'stopIdentityUnavailable' = 'true') AS stop_pending,
      EXISTS (SELECT 1 FROM capture_agent_commands command
        WHERE command.tenant_id = execution.tenant_id AND command.task_id = execution.id
          AND command.command_type = 'create' AND command.status IN ('pending', 'acknowledged')) AS active_command
      FROM capture_tasks execution LEFT JOIN capture_task_items item
        ON item.tenant_id = execution.tenant_id AND item.id = $3::uuid
          AND item.execution_task_id = execution.id AND item.assignment_revision = $4
      WHERE execution.tenant_id = $1 AND execution.id = $2`,
    [scope.tenantId, state.lease_execution_task_id, state.lease_item_id, state.lease_assignment_revision]);
    if (!owner || owner.stop_pending || owner.active_command || (!TERMINAL_TASKS.includes(owner.status)
      && !['canceled', 'skipped', 'failed', 'needs_action'].includes(owner.item_status))) {
      return {claimed: false, reason: 'already_claimed'};
    }
  }
  // The parent claim transaction owns this state lock before inserting its
  // child/attempt. Existing watched/manual patrol executions also block reuse.
  const active = await tx.queryOne(`SELECT item.id FROM capture_task_items item
    JOIN capture_tasks execution ON execution.tenant_id = item.tenant_id AND execution.id = item.execution_task_id
    WHERE item.tenant_id = $1 AND item.platform = $2
      AND (item.record_id = $3 OR item.external_id = $4)
      AND item.item_type IN ('negative_post', 'watched_content')
      AND item.execution_task_id IS NOT NULL
      AND (NOT (execution.status = ANY($5::text[]))
        OR execution.metadata->>'stopPending' = 'true'
        OR execution.metadata->>'legacyPackStopPending' = 'true'
        OR execution.metadata->>'stopIdentityUnavailable' = 'true'
        OR EXISTS (
        SELECT 1 FROM capture_agent_commands command WHERE command.tenant_id = execution.tenant_id
          AND command.task_id = execution.id AND command.command_type = 'create'
          AND command.status IN ('pending', 'acknowledged')))
      AND item.id <> $6::uuid LIMIT 1`,
  [scope.tenantId, row.platform, row.id, row.external_id, TERMINAL_TASKS, input.itemId]);
  if (active) return {claimed: false, reason: 'content_execution_active'};
  // A watched patrol may finish after the first eligibility read. Checking
  // active work first and then refreshing exact successful evidence closes
  // that transition; the shared identity lock prevents a new peer claim.
  const freshRow = await tx.queryOne(recordSelectSql({single: true}), [scope.tenantId,
    scope.platforms, scope.windowEnd, scope.windowStart, keywords, input.recordId]);
  const freshQualification = freshRow
    ? evaluateUnattendedNegativePatrolRecord(freshRow, scope, state, now) : null;
  if (!freshQualification?.eligible || !freshQualification.due) return {
    claimed: false, reason: freshQualification?.reason || 'record_out_of_scope',
    sharedResultObservationId: freshQualification?.sharedResultObservationId || null,
    lastSuccessAt: freshQualification?.lastSuccessAt || null,
    nextDueDate: freshQualification?.nextDueDate || null,
  };
  await tx.execute(`UPDATE unattended_negative_patrol_state SET lease_item_id = $4,
    lease_execution_task_id = $5, lease_assignment_revision = $6, lease_started_at = $7,
    last_withdrawal_reason = '', updated_at = now()
    WHERE tenant_id = $1 AND platform = $2 AND external_id = $3`,
  [scope.tenantId, row.platform, row.external_id, input.itemId, input.executionTaskId,
    input.assignmentRevision, now.toISOString()]);
  return {claimed: true, candidate: publicCandidate(freshRow, freshQualification)};
}

export function negativePatrolStableEvidence(baseline, endpoint) {
  if (!baseline?.id || !endpoint?.id || baseline.id === endpoint.id) return false;
  const values = ['likes', 'comments_count', 'collects', 'shares'];
  if (values.some(key => baseline[key] == null || endpoint[key] == null
    || !Number.isFinite(Number(baseline[key])) || !Number.isFinite(Number(endpoint[key])))) return false;
  // Only a measured unchanged snapshot establishes stability. A decline may be
  // platform counter correction, and growth must not silently lower frequency.
  return values.every(key => Number(endpoint[key]) === Number(baseline[key]));
}

export async function completeUnattendedNegativePatrolItem(tx, input = {}) {
  if (!input.resultObservationId) return {updated: false, reason: 'durable_result_missing'};
  const result = await tx.queryOne(`SELECT item.record_id, item.platform, item.external_id,
      observation.id AS observation_id, observation.captured_at AS observed_at,
      observation.likes, observation.comments_count, observation.collects, observation.shares,
      baseline.id AS baseline_id, baseline.likes AS baseline_likes,
      baseline.comments_count AS baseline_comments_count, baseline.collects AS baseline_collects,
      baseline.shares AS baseline_shares, COALESCE(triage.status, 'unhandled') AS triage_status,
      COALESCE(triage.priority, 'normal') AS triage_priority
    FROM capture_task_items item
    JOIN record_observations observation ON observation.id = item.result_observation_id
      AND observation.tenant_id = item.tenant_id AND observation.record_id = item.record_id
      AND observation.capture_task_id = item.execution_task_id
      AND observation.capture_task_item_id = item.id
    JOIN capture_task_item_attempts attempt ON attempt.id = observation.capture_task_item_attempt_id
      AND attempt.tenant_id = item.tenant_id AND attempt.item_id = item.id
      AND attempt.execution_task_id = item.execution_task_id
      AND attempt.assignment_revision = item.assignment_revision
      AND attempt.attempt_number = item.attempt_count
    LEFT JOIN record_observations baseline ON baseline.id::text = item.metadata#>>'{baseline,observationId}'
      AND baseline.tenant_id = item.tenant_id AND baseline.record_id = item.record_id
      AND baseline.captured_at < observation.captured_at
    LEFT JOIN record_triage triage ON triage.tenant_id = item.tenant_id AND triage.record_id = item.record_id
    WHERE item.tenant_id = $1 AND item.id = $2 AND item.execution_task_id = $3
      AND item.assignment_revision = $4 AND item.result_observation_id = $5
      AND item.status IN ('completed', 'completed_with_warnings')`,
  [input.tenantId, input.itemId, input.executionTaskId, input.assignmentRevision, input.resultObservationId]);
  if (!result) return {updated: false, reason: 'durable_result_missing'};
  const state = await tx.queryOne(`SELECT * FROM unattended_negative_patrol_state
    WHERE tenant_id = $1 AND platform = $2 AND external_id = $3 FOR UPDATE`,
  [input.tenantId, result.platform, result.external_id]);
  if (!leaseMatches(state, input)) return {updated: false, reason: 'stale_execution'};
  // record-store writes this with database now() once and reuses it on ingest
  // replay. Client clocks and later receipt times must never move the cursor.
  const succeededAt = instant(result.observed_at, 'observed_at');
  if (state.last_success_at && timestamp(state.last_success_at) > succeededAt.getTime()) return {updated: false, reason: 'stale_result'};
  const stable = negativePatrolStableEvidence({id: result.baseline_id,
    likes: result.baseline_likes, comments_count: result.baseline_comments_count,
    collects: result.baseline_collects, shares: result.baseline_shares},
  {id: result.observation_id, likes: result.likes, comments_count: result.comments_count,
    collects: result.collects, shares: result.shares});
  const stableSuccessCount = stable ? Number(state.stable_success_count || 0) + 1 : 0;
  const cadenceDays = unattendedNegativePatrolCadence(result, {stable_success_count: stableSuccessCount});
  const nextDueDate = addCalendarDays(negativePatrolCalendarDate(succeededAt, input.timezone), cadenceDays);
  await tx.execute(`UPDATE unattended_negative_patrol_state SET last_success_at = $4,
    last_success_item_id = $5, last_result_observation_id = $6, next_due_date = $7,
    cadence_days = $8, stable_success_count = $9, failure_count = 0, cooldown_until = NULL,
    needs_action = false, lease_item_id = NULL, lease_execution_task_id = NULL,
    lease_assignment_revision = NULL, lease_started_at = NULL, updated_at = now()
    WHERE tenant_id = $1 AND platform = $2 AND external_id = $3`,
  [input.tenantId, result.platform, result.external_id, succeededAt.toISOString(),
    input.itemId, input.resultObservationId, nextDueDate, cadenceDays, stableSuccessCount]);
  return {updated: true, nextDueDate, cadenceDays, stable};
}

export async function failUnattendedNegativePatrolItem(tx, input = {}) {
  const state = await tx.queryOne(`SELECT * FROM unattended_negative_patrol_state
    WHERE tenant_id = $1 AND lease_item_id = $2 AND lease_execution_task_id = $3
      AND lease_assignment_revision = $4 FOR UPDATE`,
  [input.tenantId, input.itemId, input.executionTaskId, input.assignmentRevision]);
  if (!state || !leaseMatches(state, input)) return {updated: false, reason: 'stale_execution'};
  const failureCount = Number(state.failure_count || 0) + 1;
  const cooldownMs = Math.min(6 * 60 * 60 * 1000, 15 * 60 * 1000 * 2 ** Math.min(5, failureCount - 1));
  const cooldownUntil = new Date(instant(input.now || new Date(), 'now').getTime() + cooldownMs).toISOString();
  await tx.execute(`UPDATE unattended_negative_patrol_state SET failure_count = $4,
    cooldown_until = $5, needs_action = $6, last_failure_item_id = $7,
    last_failure_execution_task_id = $8, lease_item_id = NULL,
    lease_execution_task_id = NULL, lease_assignment_revision = NULL, lease_started_at = NULL,
    updated_at = now() WHERE tenant_id = $1 AND platform = $2 AND external_id = $3`,
  [input.tenantId, state.platform, state.external_id, failureCount, cooldownUntil,
    input.needsAction === true, input.itemId, input.executionTaskId]);
  return {updated: true, cooldownUntil, needsAction: input.needsAction === true};
}
