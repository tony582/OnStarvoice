import assert from 'node:assert/strict';
import test from 'node:test';
import {exportFailureResponse, EXPORT_STATEMENT_TIMEOUT_MS, EXPORT_TIMEOUT_MESSAGE} from '../server/routes/triage.js';
import {DbCapacityError} from '../server/db/query.js';

// docs/hotfix/20261009-triage-export-timeout.md: a cancelled export statement used to surface as a bare 500
// carrying PostgreSQL's English message, which the admin then translated into the list's「内容加载超时」copy.
test('a statement cancelled by statement_timeout is reported as an export timeout', () => {
  const cancelled = Object.assign(new Error('canceling statement due to statement timeout'), {code: '57014'});
  assert.deepEqual(exportFailureResponse(cancelled), {
    status: 504,
    body: {ok: false, error: 'export_timeout', message: EXPORT_TIMEOUT_MESSAGE},
  });
  assert.match(EXPORT_TIMEOUT_MESSAGE, /^导出超时：/u);
  assert.equal(EXPORT_STATEMENT_TIMEOUT_MS, 30000);
});

test('database capacity exhaustion is reported as busy with a retry hint, like the list', () => {
  const busy = exportFailureResponse(new DbCapacityError('reporting', 1500));
  assert.equal(busy.status, 503);
  assert.equal(busy.retryAfterMs, 1500);
  assert.deepEqual(busy.body, {ok: false, error: 'server_busy', message: '当前服务暂时繁忙，导出失败，请稍后重试。', retryAfterMs: 1500});
});

test('errors that already carry a status pass through; anything else goes to the generic handler', () => {
  const archived = Object.assign(new Error('内容已归档'), {status: 409, code: 'record_archived'});
  assert.deepEqual(exportFailureResponse(archived), {status: 409, body: {ok: false, error: 'record_archived', message: '内容已归档'}});
  assert.equal(exportFailureResponse(new Error('boom')), null);
  assert.equal(exportFailureResponse(null), null);
});
