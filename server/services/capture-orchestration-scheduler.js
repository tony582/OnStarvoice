import crypto from 'node:crypto';
import {withTransaction} from '../db/query.js';
import {
  aggregateParentTaskItems,
  computeNextOrchestrationRunAt,
  hashOrchestrationRequest,
} from './capture-orchestration.js';
import {
  normalizeCaptureAgentPlatforms,
  normalizeRemoteTaskInput,
} from './capture-cloud.js';

export const SCHEDULE_OVERLAP_RUN_STATUSES = Object.freeze([
  'pending',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'resume_requested',
  'stop_requested',
]);
export const SCHEDULE_OVERLAP_ITEM_STATUSES = Object.freeze([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
]);
export const SCHEDULE_TERMINAL_RUN_STATUSES = Object.freeze([
  'completed',
  'completed_with_warnings',
  'completed_with_failures',
  'failed',
  'canceled',
  'skipped',
  'superseded',
]);

export function scheduleRunBlocksNextOccurrence({
  runStatus = '',
  childStatuses = [],
  itemStatuses = [],
} = {}) {
  if (SCHEDULE_TERMINAL_RUN_STATUSES.includes(String(runStatus))) return false;
  const childActive = childStatuses.some(status =>
    SCHEDULE_OVERLAP_RUN_STATUSES.includes(String(status))
  );
  const itemActive = itemStatuses.some(status =>
    SCHEDULE_OVERLAP_ITEM_STATUSES.includes(String(status))
  );
  if (childStatuses.length > 0 || itemStatuses.length > 0) {
    return childActive || itemActive;
  }
  return SCHEDULE_OVERLAP_RUN_STATUSES.includes(String(runStatus));
}

function text(value, limit = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function scheduleDefinition(schedule) {
  const customDateValues = Array.isArray(schedule.custom_date_texts)
    ? schedule.custom_date_texts
    : Array.isArray(schedule.custom_dates)
      ? schedule.custom_dates
      : [];
  return {
    mode: schedule.schedule_mode,
    startTime: schedule.start_time,
    randomOffsetMin: Number(schedule.random_offset_min || 0),
    // DATE is deliberately converted to text in SQL. Passing a local-midnight
    // Date through toISOString can shift an Asia/Shanghai date to the day before.
    customDates: customDateValues
      .map(value => String(value || '').slice(0, 10))
      .join('\n'),
    maxRounds: Number(schedule.plan_snapshot?.maxRounds || 1),
    roundGapMin: Number(schedule.plan_snapshot?.roundGapMin || 10),
  };
}

function nextRunAt(schedule, after) {
  return computeNextOrchestrationRunAt(scheduleDefinition(schedule), {
    after,
    seed: schedule.id,
  });
}

function occurrenceTitle(title, scheduledFor) {
  const display = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(scheduledFor));
  return `${title} · ${display}`;
}

function agentFailure(agent, platform, planSnapshot) {
  if (!agent) {
    return {code: 'scheduled_agent_missing', message: '计划中的执行节点已不存在'};
  }
  if (
    agent.tenant_status !== 'active' ||
    agent.status !== 'active' ||
    agent.auth_code_status !== 'active' ||
    !agent.active_auth_binding_id ||
    (
      agent.auth_code_expires_at &&
      new Date(agent.auth_code_expires_at) < new Date()
    )
  ) {
    return {code: 'scheduled_agent_unavailable', message: '计划中的执行节点授权失效或已暂停'};
  }
  const capabilities = object(agent.capabilities);
  if (capabilities.remoteTaskCreate !== true) {
    return {code: 'scheduled_agent_version_unsupported', message: '执行节点版本不支持云端任务'};
  }
  if (
    Object.hasOwn(planSnapshot, 'keywordMaxDetectedItems') &&
    capabilities.remoteTaskKeywordPostLimit !== true
  ) {
    return {code: 'scheduled_agent_keyword_limit_unsupported', message: '执行节点版本不支持任务级帖子上限'};
  }
  if (
    Object.keys(object(planSnapshot.captureSettings)).length > 0 &&
    capabilities.remoteTaskEnhancementOptions !== true
  ) {
    return {code: 'scheduled_agent_enhancement_unsupported', message: '执行节点版本不支持采集增强参数'};
  }
  const allowed = Array.isArray(agent.allowed_platforms)
    ? agent.allowed_platforms
    : [];
  if (allowed.length > 0 && !allowed.includes(platform)) {
    return {code: 'scheduled_agent_platform_mismatch', message: '执行节点未配置负责当前平台'};
  }
  const supported = normalizeCaptureAgentPlatforms(capabilities.supportedPlatforms);
  if (supported.length > 0 && !supported.includes(platform)) {
    return {code: 'scheduled_agent_platform_unsupported', message: '执行节点版本不支持当前平台'};
  }
  return null;
}

async function appendEvent(tx, {
  tenantId,
  taskId,
  agentId = null,
  eventType,
  actorType = 'system',
  actorId = '',
  actorName = '云端调度器',
  status = '',
  message = '',
  payload = {},
}) {
  await tx.execute(`
    INSERT INTO capture_task_events (
      tenant_id, task_id, agent_id, event_type,
      actor_type, actor_id, actor_name, status, message, payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
  `, [
    tenantId,
    taskId,
    agentId,
    eventType,
    text(actorType, 80),
    text(actorId, 240),
    text(actorName, 240),
    text(status, 80),
    text(message, 2000),
    JSON.stringify(object(payload)),
  ]);
}

async function advanceSchedule(tx, schedule, {
  after,
  lastRunStatus,
  lastRunTaskId = null,
  lastError = {},
  incrementRunCount = false,
  message,
}) {
  const next = nextRunAt(schedule, after);
  const finalStatus = next ? 'active' : 'completed';
  await tx.execute(`
    UPDATE capture_orchestration_schedules
    SET status = $1,
      next_run_at = $2,
      last_scheduled_for = $3,
      last_run_at = now(),
      last_run_task_id = $4,
      last_run_status = $5,
      last_error = $6::jsonb,
      run_count = run_count + $7,
      updated_at = now()
    WHERE id = $8 AND tenant_id = $9
  `, [
    finalStatus,
    next || null,
    schedule.next_run_at,
    lastRunTaskId,
    text(lastRunStatus, 80),
    JSON.stringify(object(lastError)),
    incrementRunCount ? 1 : 0,
    schedule.id,
    schedule.tenant_id,
  ]);
  await tx.execute(`
    UPDATE capture_tasks
    SET status = CASE WHEN $1 = 'completed' THEN 'completed' ELSE status END,
      message = $2,
      metadata = metadata || jsonb_build_object(
        'scheduleStatus', $1::text,
        'nextRunAt', COALESCE($3::timestamptz::text, ''),
        'lastScheduledFor', $4::timestamptz::text,
        'lastRunStatus', $5::text,
        'lastRunTaskId', COALESCE($6::uuid::text, '')
      ),
      finished_at = CASE WHEN $1 = 'completed' THEN now() ELSE NULL END,
      updated_at = now(),
      source_updated_at = now()
    WHERE id = $7 AND tenant_id = $8
  `, [
    finalStatus,
    message,
    next || null,
    schedule.next_run_at,
    text(lastRunStatus, 80),
    lastRunTaskId,
    schedule.template_task_id,
    schedule.tenant_id,
  ]);
  return {nextRunAt: next, scheduleStatus: finalStatus};
}

async function materializeOccurrence(tx, schedule, {manual = false} = {}) {
  const scheduledFor = new Date(schedule.next_run_at);
  const scheduledForMs = scheduledFor.getTime();
  const schedulerNow = new Date(schedule.scheduler_now || Date.now());
  const graceMs = Number(schedule.late_start_grace_min || 360) * 60 * 1000;
  if (!manual && schedulerNow.getTime() > scheduledForMs + graceMs) {
    const advanced = await advanceSchedule(tx, schedule, {
      after: schedulerNow,
      lastRunStatus: 'skipped_late',
      lastError: {
        code: 'scheduled_occurrence_too_late',
        message: '服务恢复时已超过本轮允许的最晚启动时间',
      },
      message: '上一轮因超过最晚启动时间而跳过，计划将等待下一次运行',
    });
    await appendEvent(tx, {
      tenantId: schedule.tenant_id,
      taskId: schedule.template_task_id,
      eventType: 'orchestration_schedule_occurrence_skipped',
      status: advanced.scheduleStatus,
      message: '无人值守计划已跳过过期轮次',
      payload: {scheduledFor: schedule.next_run_at, reason: 'late_start'},
    });
    return {kind: 'skipped_late', scheduleId: schedule.id, ...advanced};
  }

  const overlapping = await tx.queryOne(`
    SELECT run.id
    FROM capture_tasks run
    WHERE run.tenant_id = $1
      AND run.orchestration_schedule_id = $2
      AND run.id <> $3
      AND run.task_type = 'capture_orchestration'
      -- A terminal parent is absorbing. Legacy child/item residue is audit
      -- debt, not proof that the completed occurrence is still executing.
      AND NOT (run.status = ANY($4::text[]))
      AND (
        EXISTS (
          SELECT 1
          FROM capture_tasks child
          WHERE child.parent_task_id = run.id
            AND child.tenant_id = run.tenant_id
            AND child.status = ANY($5::text[])
        )
        OR EXISTS (
          SELECT 1
          FROM capture_task_items item
          WHERE item.task_id = run.id
            AND item.tenant_id = run.tenant_id
            -- A retryable/needs-action result remains available for an
            -- operator retry but must not disable every future occurrence.
            AND item.status = ANY($6::text[])
        )
        OR (
          -- A legacy parent without a work graph can only expose its own
          -- status. Once children/items exist, their real execution state is
          -- authoritative and a stale parent projection cannot block forever.
          run.status = ANY($5::text[])
          AND NOT EXISTS (
            SELECT 1
            FROM capture_tasks any_child
            WHERE any_child.parent_task_id = run.id
              AND any_child.tenant_id = run.tenant_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM capture_task_items any_item
            WHERE any_item.task_id = run.id
              AND any_item.tenant_id = run.tenant_id
          )
        )
      )
    ORDER BY run.scheduled_for DESC, run.id
    LIMIT 1
  `, [
    schedule.tenant_id,
    schedule.id,
    schedule.template_task_id,
    SCHEDULE_TERMINAL_RUN_STATUSES,
    SCHEDULE_OVERLAP_RUN_STATUSES,
    SCHEDULE_OVERLAP_ITEM_STATUSES,
  ]);
  if (overlapping) {
    if (manual) {
      return {
        kind: 'blocked_overlap',
        scheduleId: schedule.id,
        activeRunTaskId: overlapping.id,
      };
    }
    const advanced = await advanceSchedule(tx, schedule, {
      after: scheduledFor,
      lastRunStatus: 'skipped_overlap',
      lastRunTaskId: overlapping.id,
      lastError: {
        code: 'previous_schedule_run_active',
        message: '上一轮仍在执行或等待设备，本轮已按不重叠策略跳过',
      },
      message: '上一轮仍未结束，本轮已跳过以避免同一计划重叠运行',
    });
    await appendEvent(tx, {
      tenantId: schedule.tenant_id,
      taskId: schedule.template_task_id,
      eventType: 'orchestration_schedule_occurrence_skipped',
      status: advanced.scheduleStatus,
      message: '无人值守计划因上一轮未结束而跳过本轮',
      payload: {
        scheduledFor: schedule.next_run_at,
        reason: 'overlap',
        activeRunTaskId: overlapping.id,
      },
    });
    return {kind: 'skipped_overlap', scheduleId: schedule.id, ...advanced};
  }

  const existingRun = await tx.queryOne(`
    SELECT id, status
    FROM capture_tasks
    WHERE tenant_id = $1
      AND orchestration_schedule_id = $2
      AND scheduled_for = $3
      AND task_type = 'capture_orchestration'
  `, [schedule.tenant_id, schedule.id, schedule.next_run_at]);
  if (existingRun) {
    const advanced = await advanceSchedule(tx, schedule, {
      after: scheduledFor,
      lastRunStatus: 'already_materialized',
      lastRunTaskId: existingRun.id,
      message: '本轮任务已经生成，计划将等待下一次运行',
    });
    return {
      kind: 'existing',
      scheduleId: schedule.id,
      runTaskId: existingRun.id,
      ...advanced,
    };
  }

  const templateItems = await tx.queryAll(`
    SELECT id, ordinal, keyword, assigned_agent_id
    FROM capture_task_items
    WHERE tenant_id = $1 AND task_id = $2
    ORDER BY ordinal, id
  `, [schedule.tenant_id, schedule.template_task_id]);
  if (
    templateItems.length === 0 ||
    templateItems.some(item => !item.assigned_agent_id)
  ) {
    const advanced = await advanceSchedule(tx, schedule, {
      after: scheduledFor,
      lastRunStatus: 'failed_template',
      lastError: {
        code: 'schedule_assignment_incomplete',
        message: '计划模板存在未分配关键词，无法生成本轮任务',
      },
      message: '无人值守计划分配不完整，本轮未生成任务',
    });
    return {kind: 'failed_template', scheduleId: schedule.id, ...advanced};
  }

  const planSnapshot = object(schedule.plan_snapshot);
  const agentIds = [...new Set(
    templateItems.map(item => String(item.assigned_agent_id)),
  )].sort((left, right) => left.localeCompare(right));
  const agents = await tx.queryAll(`
    SELECT ca.*,
      tenant.status AS tenant_status,
      ac.status AS auth_code_status,
      ac.expires_at AS auth_code_expires_at,
      ab.id AS active_auth_binding_id
    FROM capture_agents ca
    JOIN tenants tenant ON tenant.id = ca.tenant_id
    LEFT JOIN auth_codes ac
      ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
    LEFT JOIN auth_bindings ab
      ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
    WHERE ca.tenant_id = $1 AND ca.id = ANY($2::uuid[])
    ORDER BY ca.id
    FOR UPDATE OF ca
  `, [schedule.tenant_id, agentIds]);
  const agentsById = new Map(agents.map(agent => [String(agent.id), agent]));

  const runTaskId = crypto.randomUUID();
  const runTitle = occurrenceTitle(schedule.title, scheduledFor);
  const runMetadata = {
    allocationMode: schedule.allocation_mode,
    executionMode: 'one_time',
    planSnapshot,
    orchestrationScheduleRun: true,
    manualRunNow: manual,
    scheduleId: schedule.id,
    scheduleTemplateTaskId: schedule.template_task_id,
    scheduleRevision: Number(schedule.revision),
    scheduledFor: scheduledFor.toISOString(),
  };
  await tx.queryOne(`
    INSERT INTO capture_tasks (
      id, tenant_id, client_task_id, task_type, feature_key,
      title, platform, source, trigger_type, status,
      progress, checkpoint, counts, metadata, message,
      orchestration_revision, orchestration_schedule_id,
      scheduled_for, schedule_revision, source_updated_at
    ) VALUES (
      $1::uuid, $2, $1::uuid::text, 'capture_orchestration',
      'keyword_orchestration', $3, $4, 'cloud',
      'orchestration_schedule', 'pending',
      $5::jsonb, '{}'::jsonb, $6::jsonb, $7::jsonb,
      '无人值守计划已生成本轮任务，正在下发到执行节点',
      1, $8, $9, $10, now()
    )
  `, [
    runTaskId,
    schedule.tenant_id,
    runTitle,
    schedule.platform,
    JSON.stringify({current: 0, total: templateItems.length, phase: 'dispatched'}),
    JSON.stringify({
      total: templateItems.length,
      assigned: templateItems.length,
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    }),
    JSON.stringify(runMetadata),
    schedule.id,
    scheduledFor.toISOString(),
    Number(schedule.revision),
  ]);

  const runItems = [];
  for (const templateItem of templateItems) {
    const item = await tx.queryOne(`
      INSERT INTO capture_task_items (
        id, tenant_id, task_id, item_key, ordinal, keyword,
        platform, item_type, status, assigned_agent_id,
        assignment_revision, assigned_at, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, 'keyword', 'assigned', $8,
        1, now(), $9::jsonb
      )
      RETURNING *
    `, [
      crypto.randomUUID(),
      schedule.tenant_id,
      runTaskId,
      `keyword:${String(Number(templateItem.ordinal) + 1).padStart(4, '0')}:${crypto
        .createHash('sha256')
        .update(String(templateItem.keyword || ''))
        .digest('hex')
        .slice(0, 12)}`,
      Number(templateItem.ordinal),
      templateItem.keyword,
      schedule.platform,
      templateItem.assigned_agent_id,
      JSON.stringify({
        keyword: templateItem.keyword,
        ordinal: Number(templateItem.ordinal),
        scheduleTemplateItemId: templateItem.id,
      }),
    ]);
    runItems.push(item);
  }

  const itemsByAgent = new Map();
  for (const item of runItems) {
    const agentId = String(item.assigned_agent_id);
    if (!itemsByAgent.has(agentId)) itemsByAgent.set(agentId, []);
    itemsByAgent.get(agentId).push(item);
  }
  const commandExpiresAt = new Date(
    scheduledForMs + graceMs,
  ).toISOString();
  let executionCount = 0;
  for (const agentId of agentIds) {
    const groupItems = itemsByAgent.get(agentId) || [];
    const agent = agentsById.get(agentId);
    const failure = agentFailure(agent, schedule.platform, planSnapshot);
    if (failure) {
      for (const item of groupItems) {
        await tx.execute(`
          UPDATE capture_task_items
          SET status = 'needs_action',
            attempt_count = 1,
            error = $1::jsonb,
            started_at = now(),
            updated_at = now()
          WHERE id = $2 AND tenant_id = $3
        `, [JSON.stringify(failure), item.id, schedule.tenant_id]);
        await tx.execute(`
          INSERT INTO capture_task_item_attempts (
            id, tenant_id, item_id, parent_task_id, agent_id,
            attempt_number, assignment_revision, status, error,
            assigned_at, started_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            1, 1, 'needs_action', $6::jsonb,
            now(), now()
          )
        `, [
          crypto.randomUUID(),
          schedule.tenant_id,
          item.id,
          runTaskId,
          agentId,
          JSON.stringify(failure),
        ]);
      }
      await appendEvent(tx, {
        tenantId: schedule.tenant_id,
        taskId: runTaskId,
        agentId,
        eventType: 'orchestration_scheduled_agent_unavailable',
        status: 'needs_action',
        message: failure.message,
        payload: {code: failure.code, itemIds: groupItems.map(item => item.id)},
      });
      continue;
    }

    const childTaskId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const childTitle = agentIds.length === 1
      ? runTitle
      : `${runTitle} · ${executionCount + 1}/${agentIds.length}`;
    const childInput = normalizeRemoteTaskInput({
      clientTaskId: childTaskId,
      title: childTitle,
      executionMode: 'one_time',
      planSnapshot: {
        ...planSnapshot,
        enabled: true,
        platform: schedule.platform,
        keywords: groupItems.map(item => item.keyword),
        autoLoop: false,
        maxRounds: 1,
        roundGapMin: 10,
      },
    });
    const childPlan = childInput.planSnapshot;
    const requestHash = hashOrchestrationRequest({
      scheduleId: schedule.id,
      scheduledFor: scheduledFor.toISOString(),
      agentId,
      taskInput: childInput,
    });
    const total =
      childPlan.keywords.length * Math.max(1, Number(childPlan.maxRounds) || 1);
    const childMetadata = {
      remoteCreated: true,
      remoteRequestHash: requestHash,
      createCommandId: commandId,
      requestedByUserId: '',
      requestedByName: '云端调度器',
      executionMode: 'one_time',
      planSnapshot: childPlan,
      orchestrationChild: true,
      parentTaskId: runTaskId,
      orchestrationRevision: 1,
      itemIds: groupItems.map(item => item.id),
      scheduleId: schedule.id,
      scheduledFor: scheduledFor.toISOString(),
    };
    await tx.execute(`
      INSERT INTO capture_tasks (
        id, tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
        client_task_id, task_type, feature_key, title, platform,
        source, trigger_type, status, progress, checkpoint, counts,
        metadata, message, source_updated_at,
        orchestration_schedule_id, scheduled_for, schedule_revision
      ) VALUES (
        $1::uuid, $2, $3, $4, $4,
        $1::uuid::text, 'unattended_keyword_capture',
        'unattended_keyword_plan', $5, $6,
        'cloud', 'orchestration_schedule', 'pending',
        $7::jsonb, $8::jsonb, $9::jsonb,
        $10::jsonb, '无人值守编排子任务已创建，等待目标设备领取', now(),
        $11, $12, $13
      )
    `, [
      childTaskId,
      schedule.tenant_id,
      runTaskId,
      agentId,
      childInput.title,
      schedule.platform,
      JSON.stringify({current: 0, total, phase: 'queued'}),
      JSON.stringify({round: 1, keywordIndex: 0}),
      JSON.stringify({
        total,
        processed: 0,
        success: 0,
        failed: 0,
        skipped: 0,
      }),
      JSON.stringify(childMetadata),
      schedule.id,
      scheduledFor.toISOString(),
      Number(schedule.revision),
    ]);
    await tx.execute(`
      INSERT INTO capture_agent_commands (
        id, tenant_id, agent_id, task_id, command_type, payload,
        requested_by_name, expires_at
      ) VALUES (
        $1, $2, $3, $4, 'create', $5::jsonb,
        '云端调度器', $6
      )
    `, [
      commandId,
      schedule.tenant_id,
      agentId,
      childTaskId,
      JSON.stringify({
        taskId: childTaskId,
        clientTaskId: childTaskId,
        title: childInput.title,
        executionMode: 'one_time',
        platform: childPlan.platform,
        planSnapshot: childPlan,
        requestHash,
        authCodeId: agent.auth_code_id,
        authBindingId: agent.auth_binding_id,
        orchestration: {
          parentTaskId: runTaskId,
          revision: 1,
          itemIds: groupItems.map(item => item.id),
          scheduleId: schedule.id,
          scheduledFor: scheduledFor.toISOString(),
        },
      }),
      commandExpiresAt,
    ]);
    for (const item of groupItems) {
      await tx.execute(`
        UPDATE capture_task_items
        SET status = 'dispatched',
          attempt_count = 1,
          execution_task_id = $1,
          request_hash = $2,
          dispatched_at = now(),
          updated_at = now()
        WHERE id = $3 AND tenant_id = $4
      `, [childTaskId, requestHash, item.id, schedule.tenant_id]);
      await tx.execute(`
        INSERT INTO capture_task_item_attempts (
          id, tenant_id, item_id, parent_task_id, execution_task_id,
          agent_id, attempt_number, assignment_revision, status,
          request_hash, checkpoint, result, error, dispatched_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, 1, 1, 'dispatched',
          $7, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
        )
      `, [
        crypto.randomUUID(),
        schedule.tenant_id,
        item.id,
        runTaskId,
        childTaskId,
        agentId,
        requestHash,
      ]);
    }
    await appendEvent(tx, {
      tenantId: schedule.tenant_id,
      taskId: childTaskId,
      agentId,
      eventType: 'orchestration_child_dispatched',
      status: 'pending',
      message: '无人值守计划本轮子任务已向指定节点下发',
      payload: {
        parentTaskId: runTaskId,
        scheduleId: schedule.id,
        scheduledFor: scheduledFor.toISOString(),
        commandId,
        itemIds: groupItems.map(item => item.id),
        keywords: groupItems.map(item => item.keyword),
      },
    });
    executionCount += 1;
  }

  const finalItems = await tx.queryAll(`
    SELECT status
    FROM capture_task_items
    WHERE tenant_id = $1 AND task_id = $2
  `, [schedule.tenant_id, runTaskId]);
  const aggregate = aggregateParentTaskItems(finalItems);
  const parentMessage = aggregate.status === 'needs_action'
    ? '本轮部分关键词没有可用执行节点，需要处理'
    : '无人值守计划本轮任务已生成并下发';
  await tx.execute(`
    UPDATE capture_tasks
    SET status = $1,
      progress = $2::jsonb,
      counts = $3::jsonb,
      message = $4,
      finished_at = CASE WHEN $5 THEN now() ELSE NULL END,
      updated_at = now()
    WHERE id = $6 AND tenant_id = $7
  `, [
    aggregate.status,
    JSON.stringify(aggregate.progress),
    JSON.stringify(aggregate.counts),
    parentMessage,
    aggregate.terminal,
    runTaskId,
    schedule.tenant_id,
  ]);
  await appendEvent(tx, {
    tenantId: schedule.tenant_id,
    taskId: runTaskId,
    eventType: 'orchestration_schedule_run_created',
    status: aggregate.status,
    message: parentMessage,
    payload: {
      scheduleId: schedule.id,
      scheduledFor: scheduledFor.toISOString(),
      executionCount,
      itemCount: finalItems.length,
    },
  });
  const advanced = await advanceSchedule(tx, schedule, {
    after: scheduledFor,
    lastRunStatus: aggregate.status,
    lastRunTaskId: runTaskId,
    incrementRunCount: true,
    message: '无人值守计划已生成本轮任务，等待下一次运行',
  });
  await appendEvent(tx, {
    tenantId: schedule.tenant_id,
    taskId: schedule.template_task_id,
    eventType: 'orchestration_schedule_run_materialized',
    status: advanced.scheduleStatus,
    message: '无人值守计划已生成一轮多 Agent 任务',
    payload: {
      runTaskId,
      scheduledFor: scheduledFor.toISOString(),
      nextRunAt: advanced.nextRunAt,
      executionCount,
      itemCount: finalItems.length,
    },
  });
  return {
    kind: 'created',
    scheduleId: schedule.id,
    runTaskId,
    executionCount,
    itemCount: finalItems.length,
    ...advanced,
  };
}

export async function runCaptureOrchestrationScheduleNow({
  tenantId,
  scheduleId,
  requestKey,
  actorId = '',
  actorName = '',
} = {}) {
  return withTransaction(async tx => {
    await tx.execute(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [String(tenantId || ''), String(requestKey || '')],
    );
    const replay = await tx.queryOne(`
      SELECT payload->>'runTaskId' AS run_task_id,
        payload->>'scheduleId' AS schedule_id
      FROM capture_task_events
      WHERE tenant_id = $1
        AND event_type = 'orchestration_schedule_manual_run_requested'
        AND payload->>'requestKey' = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `, [tenantId, requestKey]);
    if (replay?.run_task_id) {
      if (String(replay.schedule_id || '') !== String(scheduleId || '')) {
        return {kind: 'idempotency_conflict'};
      }
      return {
        kind: 'existing',
        scheduleId,
        runTaskId: replay.run_task_id,
        idempotent: true,
      };
    }
    const schedule = await tx.queryOne(`
      SELECT schedule.*,
        now() AS scheduler_now,
        ARRAY(
          SELECT scheduled_date::text
          FROM unnest(schedule.custom_dates) AS scheduled_date
          ORDER BY scheduled_date
        ) AS custom_date_texts
      FROM capture_orchestration_schedules schedule
      WHERE schedule.id = $1
        AND schedule.tenant_id = $2
      FOR UPDATE
    `, [scheduleId, tenantId]);
    if (!schedule) return {kind: 'not_found'};
    if (!['active', 'completed'].includes(schedule.status)) {
      return {kind: 'inactive', status: schedule.status};
    }
    const now = new Date(schedule.scheduler_now || Date.now());
    const result = await materializeOccurrence(tx, {
      ...schedule,
      next_run_at: now.toISOString(),
      scheduler_now: now.toISOString(),
    }, {manual: true});
    if (result.kind === 'created') {
      await appendEvent(tx, {
        tenantId: schedule.tenant_id,
        taskId: schedule.template_task_id,
        eventType: 'orchestration_schedule_manual_run_requested',
        actorType: 'user',
        actorId,
        actorName,
        status: result.scheduleStatus,
        message: '用户从云端立即启动了一轮无人值守任务',
        payload: {
          requestKey,
          scheduleId: schedule.id,
          runTaskId: result.runTaskId,
          scheduledFor: now.toISOString(),
        },
      });
    }
    return result;
  });
}

export async function enqueueDueCaptureOrchestrations(limit = 10) {
  const results = [];
  const maximum = Math.min(50, Math.max(1, Number(limit) || 10));
  for (let index = 0; index < maximum; index += 1) {
    let claimedSchedule = null;
    try {
      const result = await withTransaction(async tx => {
        const schedule = await tx.queryOne(`
        SELECT schedule.*,
          now() AS scheduler_now,
          ARRAY(
            SELECT scheduled_date::text
            FROM unnest(schedule.custom_dates) AS scheduled_date
            ORDER BY scheduled_date
          ) AS custom_date_texts
        FROM capture_orchestration_schedules schedule
        WHERE status = 'active'
          AND next_run_at IS NOT NULL
          AND next_run_at <= now()
        ORDER BY next_run_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
        if (!schedule) return null;
        claimedSchedule = {
          id: schedule.id,
          tenantId: schedule.tenant_id,
          nextRunAt: schedule.next_run_at,
          templateTaskId: schedule.template_task_id,
        };
        return materializeOccurrence(tx, schedule);
      });
      if (!result) break;
      results.push(result);
    } catch (error) {
      if (!claimedSchedule) throw error;
      const failure = {
        code: text(error?.code, 120) || 'schedule_materialization_failed',
        message: text(error?.message, 1000) || '云端调度器生成本轮任务失败',
      };
      const paused = await withTransaction(async tx => {
        const schedule = await tx.queryOne(`
          SELECT id, tenant_id, template_task_id, status, next_run_at
          FROM capture_orchestration_schedules
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE
        `, [claimedSchedule.id, claimedSchedule.tenantId]);
        if (
          !schedule ||
          schedule.status !== 'active' ||
          new Date(schedule.next_run_at).getTime() !==
            new Date(claimedSchedule.nextRunAt).getTime()
        ) {
          return false;
        }
        await tx.execute(`
          UPDATE capture_orchestration_schedules
          SET status = 'paused',
            last_run_at = now(),
            last_run_status = 'scheduler_error',
            last_error = $1::jsonb,
            revision = revision + 1,
            updated_at = now()
          WHERE id = $2 AND tenant_id = $3
        `, [JSON.stringify(failure), schedule.id, schedule.tenant_id]);
        await tx.execute(`
          UPDATE capture_tasks
          SET status = 'needs_action',
            attention_dismissed_at = NULL,
            attention_dismissed_by_user_id = NULL,
            attention_dismissed_by_name = '',
            metadata = metadata || jsonb_build_object(
              'scheduleStatus', 'paused',
              'lastRunStatus', 'scheduler_error'
            ),
            message = '无人值守计划生成任务失败，已自动暂停，请查看运行详情',
            updated_at = now(),
            source_updated_at = now()
          WHERE id = $1 AND tenant_id = $2
        `, [schedule.template_task_id, schedule.tenant_id]);
        await appendEvent(tx, {
          tenantId: schedule.tenant_id,
          taskId: schedule.template_task_id,
          eventType: 'orchestration_schedule_paused_after_error',
          status: 'paused',
          message: '无人值守计划因调度错误自动暂停',
          payload: failure,
        });
        return true;
      });
      results.push({
        kind: paused ? 'failed_paused' : 'failed_superseded',
        scheduleId: claimedSchedule.id,
        error: failure,
      });
    }
  }
  return results;
}
