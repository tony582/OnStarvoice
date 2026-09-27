const SUCCESS_ITEM_STATUSES = new Set(['completed', 'completed_with_warnings']);
const SETTLED_ITEM_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'failed',
  'skipped',
  'canceled',
]);
const ACTIVE_ITEM_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'resume_requested',
]);
const FAILED_ITEM_STATUSES = new Set([
  'failed',
  'interrupted',
  'completed_with_failures',
]);

export function orchestrationItemStatusBucket(status) {
  const value = String(status || '');
  if (SUCCESS_ITEM_STATUSES.has(value)) return 'success';
  if (value === 'retryable') return 'automatic_recovery';
  if (value === 'needs_action') return 'manual';
  if (FAILED_ITEM_STATUSES.has(value)) return 'failed';
  if (ACTIVE_ITEM_STATUSES.has(value)) return 'active';
  return 'other';
}

export function summarizeOrchestrationItems(items = []) {
  const summary = {
    completed: 0,
    settled: 0,
    active: 0,
    automaticRecovery: 0,
    manual: 0,
    failed: 0,
  };
  for (const item of items) {
    const status = String(item?.status || '');
    const bucket = orchestrationItemStatusBucket(status);
    if (bucket === 'success') summary.completed += 1;
    if (bucket === 'active') summary.active += 1;
    if (bucket === 'automatic_recovery') summary.automaticRecovery += 1;
    if (bucket === 'manual') summary.manual += 1;
    if (bucket === 'failed') summary.failed += 1;
    if (SETTLED_ITEM_STATUSES.has(status)) summary.settled += 1;
  }
  return summary;
}

export function formatRecoveryCountdown({
  waitUntil,
  now,
  awaitingAgentReport = false,
} = {}) {
  const target = Number(waitUntil || 0);
  const current = Number(now || 0);
  const remainingSeconds = Math.max(0, Math.ceil((target - current) / 1000));
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  const clock = hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  if (target > current) return `${clock} 后检查`;
  return awaitingAgentReport
    ? '指令已下发，等待 Agent 回报'
    : '已到检查时间，等待服务端重新评估';
}

export function formatRecoveryState({
  commandStatus = '',
  waitUntil = 0,
  now = 0,
} = {}) {
  const normalizedCommandStatus = String(commandStatus || '').toLowerCase();
  if (normalizedCommandStatus === 'pending') {
    return '指令已下发 · 等待 Agent 领取';
  }
  if (normalizedCommandStatus === 'acknowledged') {
    return 'Agent 已领取 · 等待执行回报';
  }
  return Number(waitUntil || 0) > Number(now || 0)
    ? formatRecoveryCountdown({waitUntil, now})
    : '尚未下发 · 等待空闲 Agent';
}

export function formatRecoveryAttemptLabel({
  attemptCurrent = 0,
  attemptTotal = null,
} = {}) {
  const current = Math.max(1, Math.floor(Number(attemptCurrent) || 1));
  const total = Number(attemptTotal);
  return Number.isFinite(total) && total >= current && total > 0
    ? `${current}/${Math.floor(total)}`
    : `第 ${current} 次`;
}

export function activeRecoveryCommandStatus({
  id = '',
  status = '',
  expiresAt = '',
  now = Date.now(),
} = {}) {
  const normalizedId = String(id || '').trim();
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (
    !normalizedId ||
    !['pending', 'acknowledged'].includes(normalizedStatus)
  ) {
    return '';
  }
  const normalizedExpiresAt = String(expiresAt || '').trim();
  if (normalizedExpiresAt) {
    const expiresAtMs = Date.parse(normalizedExpiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Number(now || 0)) {
      return '';
    }
  }
  return normalizedStatus;
}

// F1 (docs/hotfix/20260927-stuck-retry-and-attention-cleanup.md): mirrors the
// server claim SQL so the recovery card can say which pool Agents the current
// round still waits for and when the round opens to Agents that already tried.
export const DEFAULT_ELASTIC_ROUND_RELAX_MS = 10 * 60 * 1000;
const MAX_ELASTIC_POOL_SIZE = 20;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ISO_TIMESTAMP_PATTERN =
  /^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-](0[0-9]|1[0-5])(:?[0-5][0-9])?)$/u;

function plainRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function wholeNumber(value) {
  const text = String(value ?? '').trim();
  return /^[0-9]+$/u.test(text) ? Number(text) : 0;
}

function anchorCandidateMs(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) return NaN;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return NaN;
  return Date.parse(value);
}

/**
 * The current handoff anchor: the latest of the main-projection anchor, the
 * active-keyword anchor and the "重试失败关键词" waiting start; updated_at only
 * when none is present. Same rule as the server's elasticRoundAnchorSql.
 */
export function elasticRoundAnchorMs(item = {}) {
  const metadata = plainRecord(item?.metadata);
  const error = plainRecord(item?.error);
  const candidates = [
    plainRecord(plainRecord(metadata.checkpoint).recovery).handoffReadyAt,
    plainRecord(error.recovery).handoffReadyAt,
    metadata.elasticRetryWaitingSince,
  ].map(anchorCandidateMs).filter(Number.isFinite);
  if (candidates.length > 0) return Math.max(...candidates);
  const updatedAt = Date.parse(String(item?.updated_at || item?.updatedAt || ''));
  return Number.isFinite(updatedAt) ? updatedAt : NaN;
}

function roundAgentName(agent) {
  if (!agent) return '未知节点';
  return String(
    agent.display_name ||
    `${agent.host_label || '未命名设备'} · ${agent.browser_name || '浏览器'}`,
  );
}

function untriedAgentReason(agent, {fenced, platform}) {
  if (fenced) return '待确认停止';
  if (!agent) return '节点不可用';
  if (agent.status === 'paused') return '已暂停';
  if (agent.status && agent.status !== 'active') return '已停用';
  if (agent.online === false) return '离线';
  const allowed = Array.isArray(agent.allowed_platforms) ? agent.allowed_platforms : [];
  if (platform && allowed.length > 0 && !allowed.includes(platform)) return '不负责该平台';
  if (Number(agent.active_task_count || 0) > 0) return '忙碌';
  return '';
}

function clockLabel(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Explains why a retryable elastic keyword is still waiting. Returns null for
 * items the round rule does not govern (not retryable, pinned, pool unknown
 * or smaller than two Agents).
 */
export function summarizeElasticRoundWait({
  item,
  attempts = [],
  poolAgentIds = [],
  agents = [],
  fencedAgentIds = [],
  relaxAfterMs = DEFAULT_ELASTIC_ROUND_RELAX_MS,
  now = Date.now(),
} = {}) {
  if (!item || String(item.status || '') !== 'retryable') return null;
  const metadata = plainRecord(item.metadata);
  if (UUID_PATTERN.test(String(metadata.pinnedAgentId || ''))) return null;
  const pool = Array.from(new Set(
    (Array.isArray(poolAgentIds) ? poolAgentIds : [])
      .map(value => String(value || '').trim().toLowerCase())
      .filter(value => UUID_PATTERN.test(value)),
  ));
  const poolSize = Math.min(MAX_ELASTIC_POOL_SIZE, pool.length);
  if (poolSize < 2) return null;
  const base = wholeNumber(metadata.manualRetryBaseAttemptCount);
  // SQL MOD keeps the dividend's sign; a negative window excludes nobody.
  const window = Math.max(0, (wholeNumber(item.attempt_count) - base) % poolSize);
  const itemId = String(item.id || '');
  const attemptAgent = attempt => String(attempt?.agentId || attempt?.agent_id || '').toLowerCase();
  const ordered = (Array.isArray(attempts) ? attempts : [])
    .filter(attempt => String(attempt?.itemId || attempt?.item_id || '') === itemId)
    .filter(attempt => attemptAgent(attempt))
    .sort((left, right) => (
      Number(right?.attempt_number || 0) - Number(left?.attempt_number || 0) ||
      String(right?.created_at || '').localeCompare(String(left?.created_at || '')) ||
      String(right?.id || '').localeCompare(String(left?.id || ''))
    ));
  const triedAgentIds = new Set(ordered.slice(0, window).map(attemptAgent));
  const sourceAgentId = String(item.assigned_agent_id || '').toLowerCase();
  const agentById = new Map(
    (Array.isArray(agents) ? agents : [])
      .filter(agent => agent && agent.id)
      .map(agent => [String(agent.id).toLowerCase(), agent]),
  );
  const fenced = new Set(
    Array.from(fencedAgentIds || []).map(value => String(value || '').toLowerCase()),
  );
  const platform = String(item.platform || '');
  const untried = pool
    .filter(agentId => !triedAgentIds.has(agentId) && agentId !== sourceAgentId)
    .map(agentId => {
      const agent = agentById.get(agentId);
      return {
        id: agentId,
        name: roundAgentName(agent),
        reason: untriedAgentReason(agent, {fenced: fenced.has(agentId), platform}),
      };
    });
  const anchorMs = elasticRoundAnchorMs(item);
  const normalizedRelaxMs = Number(relaxAfterMs) > 0
    ? Number(relaxAfterMs)
    : DEFAULT_ELASTIC_ROUND_RELAX_MS;
  const relaxAtMs = Number.isFinite(anchorMs) ? anchorMs + normalizedRelaxMs : NaN;
  const relaxed = window > 0 && Number.isFinite(relaxAtMs) && relaxAtMs <= Number(now);
  const sourceLabel = sourceAgentId
    ? `原节点${roundAgentName(agentById.get(sourceAgentId))}`
    : '原节点';
  const minutes = Math.max(1, Math.round(normalizedRelaxMs / 60000));
  let message;
  if (window === 0) {
    message = '本轮池内节点都已尝试，已进入下一轮：除原节点外的节点都可领取';
  } else if (relaxed) {
    const waited = untried.length > 0
      ? `本轮未尝试的节点（${untried.map(entry => (entry.reason ? `${entry.name}：${entry.reason}` : entry.name)).join('、')}）`
      : '本轮池内节点';
    message = `${waited}超过 ${minutes} 分钟未领取，已开放给除${sourceLabel}外的其他节点，等待空闲节点领取`;
  } else {
    const waiting = untried.length > 0
      ? `本轮未尝试的节点：${untried.map(entry => (entry.reason ? `${entry.name}（${entry.reason}）` : entry.name)).join('、')}`
      : '本轮池内其他节点都已尝试';
    const at = Number.isFinite(relaxAtMs) ? `约 ${clockLabel(relaxAtMs)} 起，` : '';
    message = `${waiting}；超过 ${minutes} 分钟未领取将开放给其他节点（${at}${sourceLabel}除外）`;
  }
  return {
    window,
    poolSize,
    triedAgentIds: Array.from(triedAgentIds),
    untried,
    sourceAgentId,
    anchorMs,
    relaxAtMs,
    relaxed,
    message,
  };
}
