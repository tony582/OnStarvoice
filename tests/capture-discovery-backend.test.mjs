import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {normalizeBatch, validatePrincipal} from '../server/services/capture-discovery/validation.js';
import {parseDouyinShareUrl, resolveEventIdentity} from '../server/services/capture-discovery/identity.js';
import {validateLineage} from '../server/services/capture-discovery/state.js';

const principal = Object.fromEntries(['tenantId', 'agentId', 'authCodeId', 'authBindingId'].map(key => [key, randomUUID()]));
const taskId = randomUUID();
const event = {
  eventId: randomUUID(), discoveryRunId: taskId, taskId, itemId: randomUUID(),
  attemptId: randomUUID(), agentId: principal.agentId, requestHash: 'a'.repeat(64),
  assignmentRevision: 1, keyword: '别克壁纸', discoveredAt: '2026-09-22T01:00:00Z',
  verification: 'verified', rawShareUrl: 'https://www.douyin.com/video/7654321098765432109',
};
const normalize = input => normalizeBatch({uploadBatchId: randomUUID(), events: [input]}, principal, Date.parse('2026-09-22T02:00:00Z'));

test('payload hash ignores JSON key order and upload grouping but binds evidence and lineage', () => {
  const a = normalize({...event, observedFilters: {sort: 'latest', period: 'day'}}).events[0];
  const b = normalize({...event, observedFilters: {period: 'day', sort: 'latest'}}).events[0];
  assert.equal(a.payloadHash, b.payloadHash);
  assert.notEqual(a.payloadHash, normalize({...event, titleHint: 'new evidence'}).events[0].payloadHash);
  assert.notEqual(a.payloadHash, normalize({...event, attemptId: randomUUID()}).events[0].payloadHash);
});

test('identity and bounded payload validation refuse ambiguous admission', () => {
  assert.throws(() => normalize({...event, agentId: randomUUID()}), {code: 'AGENT_ID_MISMATCH'});
  assert.throws(() => normalize({...event, verification: undefined}), {code: 'INVALID_VERIFICATION'});
  assert.throws(() => normalize({...event, assignmentRevision: 0}), {code: 'INVALID_ASSIGNMENT_REVISION'});
  assert.throws(() => normalize({...event, titleHint: 'a'.repeat(2001)}), {code: 'INVALID_TITLEHINT'});
  assert.throws(() => normalize({...event, discoveredAt: '2999-01-01'}), {code: 'INVALID_DISCOVERED_AT'});
  assert.throws(() => validatePrincipal({...principal, tenantId: 'other'}), {code: 'INVALID_TENANTID'});
});

test('batch digest freezes complete members and evidence without depending on event order', () => {
  const second = {...event, eventId: randomUUID()};
  const batch = {uploadBatchId: randomUUID(), events: [event, second]};
  const a = normalizeBatch(batch, principal);
  const b = normalizeBatch({...batch, events: [second, event]}, principal);
  assert.equal(a.uploadBatchHash, b.uploadBatchHash);
  assert.notEqual(a.uploadBatchHash, normalizeBatch({...batch, events: [event]}, principal).uploadBatchHash);
  assert.notEqual(a.uploadBatchHash, normalizeBatch({...batch,
    events: [event, {...second, titleHint: 'changed'}]}, principal).uploadBatchHash);
});

test('only explicit Douyin work routes establish canonical identity', () => {
  const id = '7654321098765432109';
  assert.deepEqual(parseDouyinShareUrl(`作品 https://www.douyin.com/note/${id}?share=1 复制`), {
    status: 'resolved', externalId: id, canonicalUrl: `https://www.douyin.com/note/${id}`,
  });
  for (const url of ['https://127.0.0.1/video/' + id, 'https://www.douyin.com.evil.test/video/' + id,
    'https://evil@www.douyin.com/video/' + id, 'https://www.douyin.com/user/' + id,
    'https://www.douyin.com/search?q=' + id, 'http://www.douyin.com/video/' + id]) {
    assert.equal(parseDouyinShareUrl(url).status, 'needs_review');
  }
});

test('unverified page evidence never creates a canonical candidate or calls a resolver', async () => {
  const identity = await resolveEventIdentity({...event, verification: 'link_unverified'}, () => assert.fail());
  assert.equal(identity.reason, 'link_unverified');
  const conflict = await resolveEventIdentity({...event, verifiedExternalId: '7000000000000000001'});
  assert.equal(conflict.reason, 'work_identity_mismatch');
});

test('short links remain unresolved without an explicit adapter; adapter output is revalidated', async () => {
  const short = {...event, rawShareUrl: 'https://v.douyin.com/abc_123/'};
  assert.equal((await resolveEventIdentity(short)).reason, 'short_link_resolver_unavailable');
  assert.equal((await resolveEventIdentity(short, async () => event.rawShareUrl)).status, 'resolved');
  assert.equal((await resolveEventIdentity(short, async () => 'https://127.0.0.1/')).status, 'needs_review');
  assert.equal((await resolveEventIdentity(short, async () => {throw new Error('network');})).status, 'pending');
});

test('historical real attempts are audit-only and missing history is refused', () => {
  const current = {
    workflow: 'douyin_mobile_discovery', platform: 'douyin', keyword: event.keyword,
    deadline_at: '2026-09-22T03:00:00Z', current_agent_id: principal.agentId,
    execution_task_id: taskId, assignment_revision: 1, attempt_count: 1,
    attempt_number: 1, current_request_hash: event.requestHash,
    task_status: 'running', item_status: 'running', attempt_status: 'running',
  };
  const now = Date.parse('2026-09-22T02:00:00Z');
  assert.equal(validateLineage(current, event, now).late, false);
  for (const change of [{assignment_revision: 2}, {task_status: 'completed'},
    {stop_requested: true}, {deadline_at: ''}, {attempt_status: 'interrupted'}]) {
    assert.equal(validateLineage({...current, ...change}, event, now).late, true);
  }
  assert.throws(() => validateLineage(null, event, now), {code: 'ATTEMPT_LINEAGE_MISMATCH'});
});
