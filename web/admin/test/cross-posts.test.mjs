import test from 'node:test'
import assert from 'node:assert/strict'
import { crossPostSummary, normalizeCrossPostGroup, crossPostSelectedIds, defaultCrossPostSelection, crossPostDrawerRecord } from '../src/lib/cross-posts.ts'

const members = [
  { id: 'a', platform: 'douyin', triage_status: 'unhandled' },
  { id: 'b', platform: 'wechat_channels', triage_status: 'reviewed' },
  { id: 'c', platform: 'xiaohongshu', archived_at: '2026-11-11' },
]

test('badge requires a real group and shows each other platform once', () => {
  assert.deepEqual(crossPostSummary({ platform: 'douyin', cross_post_group_id: 'a', cross_post_count: '3', cross_post_platforms: ['douyin', 'wechat_channels', 'wechat_channels', 'xiaohongshu'] }),
    { count: 3, otherPlatforms: ['wechat_channels', 'xiaohongshu'] })
  assert.equal(crossPostSummary({ cross_post_count: 3 }).count, 0)
  assert.equal(crossPostSummary({ cross_post_group_id: 'a', cross_post_count: 1 }).count, 0)
})

test('only the current writable member starts selected', () => {
  assert.deepEqual(defaultCrossPostSelection(members, 'a'), ['a'])
  assert.deepEqual(defaultCrossPostSelection(members, 'b'), ['b'])
  assert.deepEqual(defaultCrossPostSelection(members, 'c'), [])
  assert.deepEqual(defaultCrossPostSelection(members, 'missing'), [])
})

test('batch selection cannot include hidden, duplicate or archived records', () => {
  assert.deepEqual(crossPostSelectedIds(members, ['b', 'a', 'b', 'foreign', 'c']), ['b', 'a'])
  assert.deepEqual(crossPostSelectedIds(members, []), [])
  assert.equal(members[1].triage_status, 'reviewed')
})

test('exclusion reload prunes the removed member without selecting another one', () => {
  const reloaded = normalizeCrossPostGroup({ groupId: 'a', members: [members[0], members[0], members[2]] })
  assert.deepEqual(reloaded.members.map(member => member.id), ['a', 'c'])
  assert.deepEqual(crossPostSelectedIds(reloaded.members, ['a', 'b']), ['a'])
  assert.deepEqual(normalizeCrossPostGroup({}), { groupId: null, members: [] })
})

test('drawer switching keeps full body and the chosen member status and lifecycle', () => {
  const next = crossPostDrawerRecord({ id: 'b', title: '完整标题', content: '正文不能丢失', image_urls: ['image'], platform: 'wechat_channels' },
    { ...members[1], title: '截断标题', feishu_table_no: '42', triage_priority: 'high', archived_at: '2026-11-11' })
  assert.equal(next.content, '正文不能丢失')
  assert.equal(next.title, '完整标题')
  assert.equal(next.triage_status, 'reviewed')
  assert.equal(next.archived_at, '2026-11-11')
  assert.equal(next.feishu_table_no, '42')
})

test('drawer switching preserves admission presentation and newer full-detail handling state', () => {
  const outside = crossPostDrawerRecord({id:'b', triage_status:'unhandled', triage_display_status:'not_admitted',triage_display_reason:'AI 判定无关'},members[0])
  assert.equal(outside.triage_display_status,'not_admitted')
  assert.equal(outside.triage_display_reason,'AI 判定无关')
  const updated = crossPostDrawerRecord({id:'b',triage_status:'reviewed'}, {...members[1],triage_status:'unhandled'})
  assert.equal(updated.triage_status,'reviewed')
  assert.equal(crossPostDrawerRecord({id:'b',archived_at:'2026-11-12'}, {...members[1],archived_at:null}).archived_at,'2026-11-12')
  assert.equal(crossPostDrawerRecord({id:'b',archived_at:null}, {...members[1],archived_at:'2026-11-11'}).archived_at,null)
})
