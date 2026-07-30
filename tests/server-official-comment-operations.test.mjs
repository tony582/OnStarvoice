import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  captureOfficialCommentPatrolSnapshots,
} from '../server/services/official-comment-patrol-analytics.js'

const load = relativePath => readFile(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
)

const [route, monitorRoute, migration] = await Promise.all([
  load('server/routes/official-comment-patrol.js'),
  load('server/routes/monitor.js'),
  load('server/db/migrations/051_official_comment_operations.sql'),
])

test('official patrol migration stores per-run baselines and auditable actions', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS official_comment_patrol_snapshots/u)
  assert.match(migration, /monitor_execution_id UUID REFERENCES monitor_executions/u)
  assert.match(migration, /positive_comment_count INTEGER/u)
  assert.match(migration, /negative_comment_count INTEGER/u)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS official_comment_actions/u)
  assert.match(migration, /'delete_review'[\s\S]*'like'[\s\S]*'encourage_reply'/u)
  assert.match(migration, /WHERE status = 'pending'/u)
})

test('successful official patrol finish captures only posts observed by that execution', async () => {
  const calls = []
  const tx = {
    async queryOne(sql, params) {
      calls.push({method: 'queryOne', sql, params})
      return {
        id: '71111111-1111-4111-8111-111111111111',
        status: 'succeeded',
        finished_at: '2026-07-30T02:00:00.000Z',
        official_account_id: '81111111-1111-4111-8111-111111111111',
      }
    },
    async queryAll(sql, params) {
      calls.push({method: 'queryAll', sql, params})
      return [{id: '91111111-1111-4111-8111-111111111111'}]
    },
  }

  const result = await captureOfficialCommentPatrolSnapshots(
    tx,
    '61111111-1111-4111-8111-111111111111',
    '71111111-1111-4111-8111-111111111111',
  )

  assert.deepEqual(result, {captured: 1})
  assert.equal(calls.length, 2)
  assert.match(calls[0].sql, /execution\.status = 'succeeded'/u)
  assert.match(calls[1].sql, /observation\.monitor_execution_id = \$3::uuid/u)
  assert.match(calls[1].sql, /ON CONFLICT \(monitor_execution_id, record_id\)/u)
})

test('non-official or unsuccessful executions do not create patrol snapshots', async () => {
  let insertCalled = false
  const result = await captureOfficialCommentPatrolSnapshots(
    {
      async queryOne() {
        return null
      },
      async queryAll() {
        insertCalled = true
        return []
      },
    },
    '61111111-1111-4111-8111-111111111111',
    '71111111-1111-4111-8111-111111111111',
  )

  assert.deepEqual(result, {captured: 0})
  assert.equal(insertCalled, false)
})

test('workbench and comment actions are tenant-scoped and writer-protected', () => {
  assert.match(route, /'\/official-comment-patrol\/workbench'[\s\S]*requireTenantAccess,[\s\S]*requireSessionUser/u)
  assert.match(route, /'\/official-comment-patrol\/posts\/:id\/comments'[\s\S]*requireTenantAccess,[\s\S]*requireSessionUser/u)
  assert.match(route, /'\/official-comment-patrol\/comments\/:id\/actions'[\s\S]*requireTenantWriter/u)
  assert.match(route, /'\/official-comment-patrol\/actions\/:id'[\s\S]*requireTenantWriter/u)
  assert.match(route, /official_comment_action\.create/u)
  assert.match(route, /official_comment_action\.update/u)
  assert.match(monitorRoute, /captureOfficialCommentPatrolSnapshots\([\s\S]*execution\.id/u)
})
