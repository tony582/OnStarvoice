import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifySubmissionFailure,
  confirmedSubmissionTaskId,
  createSubmissionRecord,
  isCurrentPreviewRequest,
  listSubmissionRecords,
  readSubmissionRecord,
  removeSubmissionRecord,
  recoverInterruptedSubmission,
  stableStringify,
  submissionScopeLockName,
  submissionStorageKey,
  updatePageSelection,
  updateSubmissionRecord,
  writeSubmissionRecord,
} from './negativePatrolSubmission.ts'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    key: index => Array.from(values.keys())[index] ?? null,
    get length() { return values.size },
  }
}

test('canonical input keeps one fingerprint across object key order', () => {
  assert.equal(
    stableStringify({recordIds: ['b', 'a'], filter: {to: '2026-09-07', from: '2026-09-01'}}),
    stableStringify({filter: {from: '2026-09-01', to: '2026-09-07'}, recordIds: ['b', 'a']}),
  )
})

test('submission survives refresh in the same user and tenant only', () => {
  const storage = memoryStorage()
  const key = submissionStorageKey('user-a', 'tenant-a', '11111111-1111-4111-8111-111111111111')
  const record = createSubmissionRecord({
    userId: 'user-a',
    tenantId: 'tenant-a',
    requestKey: '11111111-1111-4111-8111-111111111111',
    input: {recordIds: ['record-a'], title: '负面巡查'},
    now: '2026-09-07T00:00:00.000Z',
  })
  writeSubmissionRecord(storage, key, record)

  assert.equal(readSubmissionRecord(storage, key, 'user-a', 'tenant-a')?.requestKey, record.requestKey)
  assert.equal(readSubmissionRecord(storage, key, 'user-b', 'tenant-a'), null)
  assert.equal(readSubmissionRecord(storage, key, 'user-a', 'tenant-b'), null)
})

test('tampered submission snapshot is rejected instead of being replayed', () => {
  const storage = memoryStorage()
  const key = submissionStorageKey('user-a', 'tenant-a', '33333333-3333-4333-8333-333333333333')
  const record = createSubmissionRecord({
    userId: 'user-a',
    tenantId: 'tenant-a',
    requestKey: '33333333-3333-4333-8333-333333333333',
    input: {recordIds: ['record-a']},
  })
  storage.setItem(key, JSON.stringify({...record, input: {recordIds: ['record-b']}}))

  assert.equal(readSubmissionRecord(storage, key, 'user-a', 'tenant-a'), null)
})

test('interrupted and retried submissions retain the immutable key and input', () => {
  const original = createSubmissionRecord({
    userId: 'user-a',
    tenantId: 'tenant-a',
    requestKey: '22222222-2222-4222-8222-222222222222',
    input: {recordIds: ['record-a'], captureSettings: {includeComments: true}},
    now: '2026-09-07T00:00:00.000Z',
  })
  const unknown = recoverInterruptedSubmission(original)
  const confirmed = updateSubmissionRecord(unknown, 'confirmed', {
    taskId: 'task-a',
    now: '2026-09-07T00:01:00.000Z',
  })

  assert.equal(unknown.status, 'unknown')
  assert.equal(confirmed.requestKey, original.requestKey)
  assert.equal(confirmed.inputHash, original.inputHash)
  assert.deepEqual(confirmed.input, original.input)
  assert.equal(Object.isFrozen(confirmed.input), true)
})

test('per-request recovery records cannot overwrite or delete another tab submission', () => {
  const storage = memoryStorage()
  const first = createSubmissionRecord({
    userId: 'user-a',
    tenantId: 'tenant-a',
    requestKey: '44444444-4444-4444-8444-444444444444',
    input: {recordIds: ['record-a']},
    now: '2026-09-07T00:00:00.000Z',
  })
  const second = createSubmissionRecord({
    userId: 'user-a',
    tenantId: 'tenant-a',
    requestKey: '55555555-5555-4555-8555-555555555555',
    input: {recordIds: ['record-b']},
    now: '2026-09-07T00:00:01.000Z',
  })
  const firstKey = submissionStorageKey(first.userId, first.tenantId, first.requestKey)
  const secondKey = submissionStorageKey(second.userId, second.tenantId, second.requestKey)
  writeSubmissionRecord(storage, firstKey, first)
  writeSubmissionRecord(storage, secondKey, second)

  removeSubmissionRecord(storage, firstKey)

  assert.equal(readSubmissionRecord(storage, secondKey, 'user-a', 'tenant-a')?.requestKey, second.requestKey)
  assert.deepEqual(listSubmissionRecords(storage, 'user-a', 'tenant-a').map(item => item.requestKey), [second.requestKey])
})

test('serialized scope claim reuses the existing request instead of creating a second one', () => {
  const storage = memoryStorage()
  const claim = proposed => {
    const existing = listSubmissionRecords(storage, proposed.userId, proposed.tenantId)[0]
    if (existing) return existing
    writeSubmissionRecord(
      storage,
      submissionStorageKey(proposed.userId, proposed.tenantId, proposed.requestKey),
      proposed,
    )
    return proposed
  }
  const first = createSubmissionRecord({
    userId: 'user-a', tenantId: 'tenant-a',
    requestKey: '66666666-6666-4666-8666-666666666666', input: {recordIds: ['record-a']},
  })
  const second = createSubmissionRecord({
    userId: 'user-a', tenantId: 'tenant-a',
    requestKey: '77777777-7777-4777-8777-777777777777', input: {recordIds: ['record-b']},
  })

  assert.equal(claim(first).requestKey, first.requestKey)
  assert.equal(claim(second).requestKey, first.requestKey)
  assert.equal(listSubmissionRecords(storage, 'user-a', 'tenant-a').length, 1)
  assert.notEqual(submissionScopeLockName('user-a', 'tenant-a'), submissionScopeLockName('user-a', 'tenant-b'))
})

test('only an explicit pre-create rejection unlocks the draft', () => {
  assert.equal(classifySubmissionFailure({httpStatus: 500}), 'unknown')
  assert.equal(classifySubmissionFailure({created: false}), 'rejected_before_create')
  assert.equal(classifySubmissionFailure({
    code: 'idempotency_key_conflict',
    created: false,
    submissionState: 'rejected_before_create',
  }), 'conflict')
})

test('only an explicit successful response with a task identity confirms creation', () => {
  assert.equal(confirmedSubmissionTaskId({ok: true, task: {id: 'task-a'}}), 'task-a')
  assert.equal(confirmedSubmissionTaskId({ok: true}), '')
  assert.equal(confirmedSubmissionTaskId({ok: false, task: {id: 'task-a'}}), '')
  assert.equal(confirmedSubmissionTaskId({taskId: 'request-key-fallback'}), '')
})

test('stale preview response cannot replace a newer criteria generation', () => {
  assert.equal(isCurrentPreviewRequest({
    activeGeneration: 3,
    responseGeneration: 2,
    activeCriteriaKey: 'new-filter',
    responseCriteriaKey: 'old-filter',
  }), false)
  assert.equal(isCurrentPreviewRequest({
    activeGeneration: 3,
    responseGeneration: 3,
    activeCriteriaKey: 'new-filter',
    responseCriteriaKey: 'new-filter',
  }), true)
})

test('page selection preserves earlier pages and never exceeds 100', () => {
  const firstPage = new Set(Array.from({length: 50}, (_, index) => `first-${index}`))
  const secondPage = Array.from({length: 60}, (_, index) => `second-${index}`)
  const result = updatePageSelection(firstPage, secondPage, true)

  assert.equal(result.selected.size, 100)
  assert.equal(result.overflow, 10)
  assert.equal(result.selected.has('first-0'), true)
  assert.equal(result.selected.has('second-49'), true)
  assert.equal(result.selected.has('second-50'), false)

  const cleared = updatePageSelection(result.selected, secondPage, false)
  assert.equal(cleared.selected.size, 50)
  assert.equal(cleared.selected.has('first-0'), true)
})
