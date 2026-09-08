export const NEGATIVE_PATROL_PREVIEW_PAGE_SIZE = 50
export const NEGATIVE_PATROL_MAX_SELECTED = 100

export type NegativePatrolSubmissionStatus =
  | 'submitting'
  | 'unknown'
  | 'confirmed'
  | 'rejected_before_create'
  | 'conflict'

export type NegativePatrolSubmissionRecord = {
  version: 1
  userId: string
  tenantId: string
  requestKey: string
  input: Record<string, unknown>
  inputHash: string
  status: NegativePatrolSubmissionStatus
  createdAt: string
  updatedAt: string
  taskId?: string
  message?: string
  errorCode?: string
}

export type SubmissionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

const SUBMISSION_STATES = new Set<NegativePatrolSubmissionStatus>([
  'submitting',
  'unknown',
  'confirmed',
  'rejected_before_create',
  'conflict',
])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => item === undefined ? null : normalizeJsonValue(item))
  }
  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const nested = (value as Record<string, unknown>)[key]
      if (nested === undefined || typeof nested === 'function' || typeof nested === 'symbol') continue
      normalized[key] = normalizeJsonValue(nested)
    }
    return normalized
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}

function freezeTree<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value as Record<string, unknown>)) freezeTree(nested)
  return value
}

export function stableStringify(value: unknown) {
  return JSON.stringify(normalizeJsonValue(value))
}

export function submissionInputHash(input: unknown) {
  const source = stableStringify(input)
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function submissionStoragePrefix(userId: string, tenantId: string) {
  if (!userId || !tenantId) return ''
  return `osv:negative-patrol:submission:v1:${encodeURIComponent(userId)}:${encodeURIComponent(tenantId)}:`
}

export function submissionStorageKey(userId: string, tenantId: string, requestKey: string) {
  const prefix = submissionStoragePrefix(userId, tenantId)
  if (!prefix || !UUID_PATTERN.test(requestKey)) return ''
  return `${prefix}${requestKey.toLowerCase()}`
}

export function submissionScopeLockName(userId: string, tenantId: string) {
  if (!userId || !tenantId) return ''
  return `osv:negative-patrol:submission-lock:v1:${encodeURIComponent(userId)}:${encodeURIComponent(tenantId)}`
}

export function createSubmissionRecord({
  userId,
  tenantId,
  requestKey,
  input,
  now = new Date().toISOString(),
}: {
  userId: string
  tenantId: string
  requestKey: string
  input: Record<string, unknown>
  now?: string
}): NegativePatrolSubmissionRecord {
  const inputSnapshot = JSON.parse(stableStringify(input)) as Record<string, unknown>
  return freezeTree({
    version: 1,
    userId,
    tenantId,
    requestKey,
    input: inputSnapshot,
    inputHash: submissionInputHash(inputSnapshot),
    status: 'submitting',
    createdAt: now,
    updatedAt: now,
  })
}

export function updateSubmissionRecord(
  record: NegativePatrolSubmissionRecord,
  status: NegativePatrolSubmissionStatus,
  details: {
    now?: string
    taskId?: string
    message?: string
    errorCode?: string
  } = {},
): NegativePatrolSubmissionRecord {
  return freezeTree({
    ...record,
    status,
    updatedAt: details.now || new Date().toISOString(),
    ...(details.taskId ? {taskId: details.taskId} : {}),
    ...(details.message ? {message: details.message} : {}),
    ...(details.errorCode ? {errorCode: details.errorCode} : {}),
  })
}

export function readSubmissionRecord(
  storage: SubmissionStorage,
  key: string,
  userId: string,
  tenantId: string,
): NegativePatrolSubmissionRecord | null {
  if (!key || !userId || !tenantId) return null
  let parsed: unknown
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Partial<NegativePatrolSubmissionRecord>
  if (
    record.version !== 1
    || record.userId !== userId
    || record.tenantId !== tenantId
    || typeof record.requestKey !== 'string'
    || !UUID_PATTERN.test(record.requestKey)
    || !record.input
    || typeof record.input !== 'object'
    || Array.isArray(record.input)
    || typeof record.inputHash !== 'string'
    || submissionInputHash(record.input) !== record.inputHash
    || typeof record.status !== 'string'
    || !SUBMISSION_STATES.has(record.status as NegativePatrolSubmissionStatus)
    || typeof record.createdAt !== 'string'
    || typeof record.updatedAt !== 'string'
  ) {
    return null
  }
  return freezeTree(record as NegativePatrolSubmissionRecord)
}

export function listSubmissionRecords(
  storage: SubmissionStorage,
  userId: string,
  tenantId: string,
) {
  const prefix = submissionStoragePrefix(userId, tenantId)
  if (!prefix) return []
  const records: NegativePatrolSubmissionRecord[] = []
  const storageLength = storage.length
  for (let index = 0; index < storageLength; index += 1) {
    const key = storage.key(index)
    if (!key || !key.startsWith(prefix)) continue
    const raw = storage.getItem(key)
    if (!raw) continue
    const record = readSubmissionRecord(storage, key, userId, tenantId)
    if (!record || submissionStorageKey(userId, tenantId, record.requestKey) !== key) {
      throw new Error('invalid_submission_recovery_record')
    }
    records.push(record)
  }
  return records.sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.requestKey.localeCompare(right.requestKey)
  ))
}

export function writeSubmissionRecord(
  storage: SubmissionStorage,
  key: string,
  record: NegativePatrolSubmissionRecord,
) {
  if (!key) return
  storage.setItem(key, JSON.stringify(record))
}

export function removeSubmissionRecord(storage: SubmissionStorage, key: string) {
  if (key) storage.removeItem(key)
}

export function confirmedSubmissionTaskId(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const response = value as {ok?: unknown; task?: unknown}
  if (response.ok !== true || !response.task || typeof response.task !== 'object' || Array.isArray(response.task)) {
    return ''
  }
  return String((response.task as {id?: unknown}).id || '').trim()
}

export function recoverInterruptedSubmission(record: NegativePatrolSubmissionRecord) {
  if (record.status !== 'submitting') return record
  return updateSubmissionRecord(record, 'unknown', {
    message: '页面在提交结果返回前关闭，需要使用原请求确认结果。',
  })
}

export function classifySubmissionFailure({
  httpStatus,
  code,
  submissionState,
  created,
}: {
  httpStatus?: number
  code?: string
  submissionState?: string
  created?: boolean
}): 'rejected_before_create' | 'conflict' | 'unknown' {
  if (
    submissionState === 'conflict'
    || httpStatus === 401
    || httpStatus === 403
    || code === 'idempotency_key_conflict'
  ) return 'conflict'
  if (submissionState === 'rejected_before_create' || created === false) {
    return 'rejected_before_create'
  }
  return 'unknown'
}

export function isCurrentPreviewRequest({
  activeGeneration,
  responseGeneration,
  activeCriteriaKey,
  responseCriteriaKey,
}: {
  activeGeneration: number
  responseGeneration: number
  activeCriteriaKey: string
  responseCriteriaKey: string
}) {
  return activeGeneration === responseGeneration && activeCriteriaKey === responseCriteriaKey
}

export function updatePageSelection(
  current: ReadonlySet<string>,
  pageIds: string[],
  shouldSelect: boolean,
  maximum = NEGATIVE_PATROL_MAX_SELECTED,
) {
  const next = new Set(current)
  if (!shouldSelect) {
    for (const id of pageIds) next.delete(id)
    return {selected: next, overflow: 0}
  }
  let overflow = 0
  for (const id of pageIds) {
    if (next.has(id)) continue
    if (next.size >= maximum) {
      overflow += 1
      continue
    }
    next.add(id)
  }
  return {selected: next, overflow}
}
