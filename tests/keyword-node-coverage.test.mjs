import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYWORD_COVERAGE_SKIP_MESSAGES,
  keywordCoverageSkipReason,
} from '../server/services/keyword-node-coverage.js';

const now = Date.parse('2026-09-22T10:00:00Z');
const ago = minutes => new Date(now - minutes * 60_000).toISOString();
const id = '00000000-0000-4000-8000-000000000001';
const fixture = () => ({
  parent: {task_type: 'capture_orchestration', status: 'pending', created_at: ago(20),
    metadata: {keywordCoverage: 'each_agent', distributionMode: 'elastic_pool', publishedAt: ago(0)}},
  item: {item_type: 'keyword', status: 'pending', metadata: {pinnedAgentId: id}},
  agent: {status: 'active', last_liveness_at: ago(0)},
});

test('offline node is optional immediately; unselected and already completed work are untouched', () => {
  const input = fixture();
  input.agent.last_liveness_at = ago(3);
  assert.equal(keywordCoverageSkipReason(input, now), 'keyword_node_offline');
  input.item.status = 'completed';
  assert.equal(keywordCoverageSkipReason(input, now), '');
  input.item.status = 'pending'; input.item.metadata = {};
  assert.equal(keywordCoverageSkipReason(input, now), '');
});

test('drafts, templates, stopped and historical parents are never changed', () => {
  for (const patch of [{draft: true}, {orchestrationTemplate: true}, {operatorStopped: true}, {stopPending: true}]) {
    const input = fixture(); input.agent = null; Object.assign(input.parent.metadata, patch);
    assert.equal(keywordCoverageSkipReason(input, now), '');
  }
  const input = fixture(); input.agent = null; input.parent.status = 'completed';
  assert.equal(keywordCoverageSkipReason(input, now), '');
});

test('old drafts get a fresh response allowance when actually published', () => {
  const input = fixture();
  assert.equal(keywordCoverageSkipReason(input, now), '');
  input.parent.metadata.publishedAt = ago(3);
  assert.equal(keywordCoverageSkipReason(input, now), 'keyword_node_no_response');
});

test('healthy slow work protects sibling keywords; repeated heartbeats do not hide a stall', () => {
  const input = fixture();
  input.child = {status: 'running', created_at: ago(25), started_at: ago(25), heartbeat_at: ago(0), business_progress_at: ago(1)};
  assert.equal(keywordCoverageSkipReason(input, now), '');
  input.nodeTasks = [input.child]; delete input.child;
  assert.equal(keywordCoverageSkipReason(input, now), '');
  input.nodeTasks[0].business_progress_at = ago(11);
  assert.equal(keywordCoverageSkipReason(input, now), 'keyword_node_no_progress');
  input.child = input.nodeTasks[0];
  assert.equal(keywordCoverageSkipReason(input, now), 'keyword_node_no_progress');
  input.child.heartbeat_at = ago(4);
  assert.equal(keywordCoverageSkipReason(input, now), 'keyword_node_no_response');
});

test('long comment requests retain the existing twelve-minute allowance', () => {
  const input = fixture();
  input.child = {status: 'running', created_at: ago(20), started_at: ago(20), heartbeat_at: ago(0),
    business_progress_at: ago(11), progress: {phase: 'detail_comments_capturing'}};
  assert.equal(keywordCoverageSkipReason(input, now), '');
  input.child.business_progress_at = ago(13);
  assert.equal(keywordCoverageSkipReason(input, now), 'keyword_node_no_progress');
});

test('explicit failures settle without exhausting automatic retries; completed sibling gives next word time', () => {
  const input = fixture(); input.item.status = 'retryable';
  assert.equal(keywordCoverageSkipReason(input, now), 'keyword_node_failed');
  input.item.status = 'pending'; input.parent.metadata.publishedAt = ago(20);
  input.nodeTasks = [{status: 'completed', finished_at: ago(1)}];
  assert.equal(keywordCoverageSkipReason(input, now), '');
});

test('a node held by an unconfirmed old-page stop is reported as fenced, not unresponsive', () => {
  assert.match(KEYWORD_COVERAGE_SKIP_MESSAGES.keyword_node_stop_fenced, /旧采集页面尚未确认停止/u);
  const input = fixture();
  input.parent.metadata.publishedAt = ago(3);
  assert.equal(keywordCoverageSkipReason(input, now), 'keyword_node_no_response');
  input.stopFenced = true;
  assert.equal(keywordCoverageSkipReason(input, now), 'keyword_node_stop_fenced');
  input.parent.metadata.publishedAt = ago(2);
  assert.equal(keywordCoverageSkipReason(input, now), '', 'the same three-minute allowance applies');
  // An undelivered create behind the fence is explained the same way.
  input.child = {status: 'pending', created_at: ago(4), started_at: null, heartbeat_at: null};
  assert.equal(keywordCoverageSkipReason(input, now), 'keyword_node_stop_fenced');
  // Real failures and real progress stalls keep their own reasons.
  input.child = {status: 'needs_action', created_at: ago(20)};
  assert.equal(keywordCoverageSkipReason(input, now), 'keyword_node_failed');
  input.child = {status: 'running', created_at: ago(25), started_at: ago(25), heartbeat_at: ago(0),
    business_progress_at: ago(11)};
  assert.equal(keywordCoverageSkipReason(input, now), 'keyword_node_no_progress');
  input.child = null;
  input.agent.last_liveness_at = ago(3);
  assert.equal(keywordCoverageSkipReason(input, now), 'keyword_node_offline');
});
