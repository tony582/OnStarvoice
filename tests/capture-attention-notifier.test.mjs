import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildCaptureAttentionEmail,
  buildCaptureAttentionEventKey,
  captureAttentionRetryDelayMs,
  deliverClaimedCaptureAttentionNotification,
  enqueueCaptureSafetyAttentionNotification,
  isStructuredSafetyAttention,
  normalizeCaptureAttentionRecipients,
} from '../server/services/capture-attention-notifier.js';
import {
  captureEmailTransporterCacheKey,
} from '../server/services/email-notifier.js';

function safetySnapshot(overrides = {}) {
  return {
    status: 'needs_action',
    title: '13 个关键词采集',
    platform: 'douyin',
    attemptNumber: 2,
    updatedAt: '2026-07-26T02:00:00.000Z',
    progress: {
      current: 7,
      total: 13,
      keyword: '别克APP',
      savedCount: 42,
    },
    checkpoint: {
      keywordResults: [
        {keyword: '前一个词', status: 'completed', savedCount: 20},
        {
          keyword: '别克APP',
          status: 'needs_action',
          errorCode: 'DOUYIN_SEARCH_SECURITY_CHALLENGE',
          securityBlocked: true,
          platformSafetyBlocked: true,
          requiresManualAction: true,
        },
      ],
    },
    error: {
      code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE',
      category: 'platform_safety_block',
      securityBlocked: true,
      platformSafetyBlocked: true,
      requiresManualAction: true,
      message: '检测到抖音图片安全验证',
    },
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenant_id: '22222222-2222-4222-8222-222222222222',
    status: 'needs_action',
    attempt_number: 2,
    title: '13 个关键词采集',
    platform: 'douyin',
    ...overrides,
  };
}

function agent(overrides = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenant_id: '22222222-2222-4222-8222-222222222222',
    display_name: '公司 Edge',
    ...overrides,
  };
}

function claimedRow(overrides = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    tenant_id: '22222222-2222-4222-8222-222222222222',
    task_id: '11111111-1111-4111-8111-111111111111',
    claim_token: '55555555-5555-4555-8555-555555555555',
    event_key: buildCaptureAttentionEventKey(
      '11111111-1111-4111-8111-111111111111',
      2,
      'DOUYIN_SEARCH_SECURITY_CHALLENGE',
    ),
    attempt_count: 0,
    payload: {
      taskTitle: '13 个关键词采集',
      orchestrationId: '66666666-6666-4666-8666-666666666666',
      agentName: '公司 Edge',
      platform: 'douyin',
      keyword: '别克APP',
      keywordCurrent: 7,
      keywordTotal: 13,
      savedCount: 42,
      errorCode: 'DOUYIN_SEARCH_SECURITY_CHALLENGE',
      errorMessage: '检测到抖音图片安全验证',
      detectedAt: '2026-07-26T02:00:00.000Z',
    },
    ...overrides,
  };
}

test('only structured safety evidence can create a needs-action notification', () => {
  assert.equal(
    isStructuredSafetyAttention(safetySnapshot(), task()),
    true,
  );
  assert.equal(
    isStructuredSafetyAttention(
      safetySnapshot({
        error: {message: '页面出现验证码'},
        checkpoint: {},
        progress: {current: 7, total: 13},
      }),
      task(),
    ),
    false,
  );
  assert.equal(
    isStructuredSafetyAttention(
      safetySnapshot({
        error: {
          code: 'DOUYIN_SEARCH_SERVICE_ABNORMAL',
          securityBlocked: true,
          requiresManualAction: true,
        },
        checkpoint: {},
        progress: {},
      }),
      task(),
    ),
    false,
  );
  assert.equal(
    isStructuredSafetyAttention(safetySnapshot(), task({status: 'running'})),
    false,
  );
  assert.equal(
    isStructuredSafetyAttention(
      safetySnapshot({
        error: {code: 'LOGIN_REQUIRED', category: 'login_required'},
        checkpoint: {},
        progress: {},
      }),
      task(),
    ),
    true,
  );
});

test('accepted first transition enqueues one idempotent outbox row', async () => {
  const calls = [];
  const tx = {
    queryOne: async (sql, params) => {
      calls.push({sql, params});
      return {id: 'notification-1'};
    },
  };
  const inserted = await enqueueCaptureSafetyAttentionNotification(tx, {
    agent: agent(),
    task: task(),
    snapshot: safetySnapshot(),
    previous: {status: 'running', attempt_number: 2},
    snapshotAccepted: true,
  });
  assert.equal(inserted.id, 'notification-1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT \(tenant_id, event_key\) DO NOTHING/u);
  assert.match(
    calls[0].params[4],
    /security_verification:11111111-1111-4111-8111-111111111111:2:DOUYIN_SEARCH_SECURITY_CHALLENGE/u,
  );
  const payload = JSON.parse(calls[0].params[5]);
  assert.equal(payload.keyword, '别克APP');
  assert.equal(payload.keywordCurrent, 7);
  assert.equal(payload.keywordTotal, 13);

  const replay = await enqueueCaptureSafetyAttentionNotification(tx, {
    agent: agent(),
    task: task(),
    snapshot: safetySnapshot(),
    previous: {status: 'needs_action', attempt_number: 2},
    snapshotAccepted: true,
  });
  assert.equal(replay, null);
  assert.equal(calls.length, 1);

  const stale = await enqueueCaptureSafetyAttentionNotification(tx, {
    agent: agent(),
    task: task(),
    snapshot: safetySnapshot(),
    previous: {status: 'running', attempt_number: 2},
    snapshotAccepted: false,
  });
  assert.equal(stale, null);
  assert.equal(calls.length, 1);
});

test('a new attempt can generate a new safety-attention event', async () => {
  const calls = [];
  const tx = {
    queryOne: async (_sql, params) => {
      calls.push(params);
      return {id: 'notification-2'};
    },
  };
  await enqueueCaptureSafetyAttentionNotification(tx, {
    agent: agent(),
    task: task({attempt_number: 3}),
    snapshot: safetySnapshot({attemptNumber: 3}),
    previous: {status: 'needs_action', attempt_number: 2},
    snapshotAccepted: true,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0][4], /:3:DOUYIN_SEARCH_SECURITY_CHALLENGE$/u);
});

test('recipient normalization is bounded and never falls back implicitly', () => {
  assert.equal(
    normalizeCaptureAttentionRecipients(
      ' Owner@Example.com;owner@example.com, bad, ops@example.cn ',
    ),
    'owner@example.com,ops@example.cn',
  );
});

test('missing dedicated recipient becomes blocked_config without sending', async () => {
  const persisted = [];
  let sent = 0;
  const result = await deliverClaimedCaptureAttentionNotification(
    claimedRow(),
    {
      getSettingFn: async (key, tenantId) => {
        assert.equal(key, 'capture_attention_email_to');
        assert.equal(tenantId, claimedRow().tenant_id);
        return '';
      },
      sendEmailFn: async () => {
        sent += 1;
      },
      persistFn: async (_row, update) => persisted.push(update),
      now: new Date('2026-07-26T03:00:00.000Z'),
    },
  );
  assert.equal(result.status, 'blocked_config');
  assert.equal(sent, 0);
  assert.equal(persisted[0].status, 'blocked_config');
});

test('delivery succeeds outside the outbox claim and records a stable message id', async () => {
  const persisted = [];
  const sent = [];
  const result = await deliverClaimedCaptureAttentionNotification(
    claimedRow(),
    {
      getSettingFn: async () => 'ops@example.com',
      sendEmailFn: async email => sent.push(email),
      persistFn: async (_row, update) => persisted.push(update),
      now: new Date('2026-07-26T03:00:00.000Z'),
    },
  );
  assert.equal(result.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tenantId, claimedRow().tenant_id);
  assert.match(sent[0].messageId, /^<capture-attention-[a-f0-9]+@starvoice\.local>$/u);
  assert.equal(persisted[0].status, 'sent');
  assert.equal(persisted[0].attemptCount, 1);
});

test('missing tenant SMTP configuration is recorded as blocked_config', async () => {
  const persisted = [];
  const result = await deliverClaimedCaptureAttentionNotification(
    claimedRow(),
    {
      getSettingFn: async () => 'ops@example.com',
      sendEmailFn: async () => {
        const error = new Error('SMTP 未配置');
        error.code = 'SMTP_NOT_CONFIGURED';
        throw error;
      },
      persistFn: async (_row, update) => persisted.push(update),
      now: new Date('2026-07-26T03:00:00.000Z'),
    },
  );
  assert.equal(result.status, 'blocked_config');
  assert.equal(persisted[0].status, 'blocked_config');
  assert.equal(persisted[0].attemptCount, 1);
});

test('transient failures use bounded backoff and eventually become failed', async () => {
  const now = new Date('2026-07-26T03:00:00.000Z');
  const first = [];
  const firstResult = await deliverClaimedCaptureAttentionNotification(
    claimedRow(),
    {
      getSettingFn: async () => 'ops@example.com',
      sendEmailFn: async () => {
        throw new Error('temporary SMTP timeout');
      },
      persistFn: async (_row, update) => first.push(update),
      now,
    },
  );
  assert.equal(firstResult.status, 'retry_wait');
  assert.equal(first[0].status, 'retry_wait');
  assert.equal(
    first[0].nextAttemptAt.getTime() - now.getTime(),
    captureAttentionRetryDelayMs(1),
  );

  const terminal = [];
  const terminalResult = await deliverClaimedCaptureAttentionNotification(
    claimedRow({attempt_count: 4}),
    {
      getSettingFn: async () => 'ops@example.com',
      sendEmailFn: async () => {
        throw new Error('still unavailable');
      },
      persistFn: async (_row, update) => terminal.push(update),
      now,
    },
  );
  assert.equal(terminalResult.status, 'failed');
  assert.equal(terminal[0].attemptCount, 5);
});

test('admin task link is optional and only accepts an HTTP public base URL', () => {
  const previous = process.env.ADMIN_PUBLIC_URL;
  try {
    delete process.env.ADMIN_PUBLIC_URL;
    const withoutLink = buildCaptureAttentionEmail(claimedRow());
    assert.equal(withoutLink.adminUrl, '');
    assert.doesNotMatch(withoutLink.html, /打开调度中心处理/u);

    process.env.ADMIN_PUBLIC_URL = 'https://voice.example.com/ignored-path';
    const withLink = buildCaptureAttentionEmail(claimedRow());
    assert.equal(
      withLink.adminUrl,
      'https://voice.example.com/admin/?page=dispatch&view=attention&taskId=11111111-1111-4111-8111-111111111111&orchestrationId=66666666-6666-4666-8666-666666666666#/m/page/dispatch?view=attention&taskId=11111111-1111-4111-8111-111111111111&orchestrationId=66666666-6666-4666-8666-666666666666',
    );
    assert.match(withLink.html, /打开调度中心处理/u);
    assert.match(withLink.html, /当前关键词已停在原 Agent 等待人工/u);
    assert.match(withLink.html, /如有其他未开始关键词，系统会自动分配/u);
    assert.doesNotMatch(withLink.html, /结束\/接力任务/u);

    process.env.ADMIN_PUBLIC_URL = 'javascript:alert(1)';
    assert.equal(buildCaptureAttentionEmail(claimedRow()).adminUrl, '');
  } finally {
    if (previous === undefined) delete process.env.ADMIN_PUBLIC_URL;
    else process.env.ADMIN_PUBLIC_URL = previous;
  }
});

test('SMTP transporter cache separates tenant transport details including password', () => {
  const base = {
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    user: 'sender@example.com',
    pass: 'secret-a',
  };
  const key = captureEmailTransporterCacheKey(base);
  assert.notEqual(
    key,
    captureEmailTransporterCacheKey({...base, port: 587}),
  );
  assert.notEqual(
    key,
    captureEmailTransporterCacheKey({...base, secure: false}),
  );
  assert.notEqual(
    key,
    captureEmailTransporterCacheKey({...base, pass: 'secret-b'}),
  );
});

test('heartbeat only enqueues while the cron worker owns SMTP delivery', async () => {
  const [route, notifier, cron, admin, migration] = await Promise.all([
    readFile(new URL('../server/routes/capture-cloud.js', import.meta.url), 'utf8'),
    readFile(
      new URL(
        '../server/services/capture-attention-notifier.js',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(new URL('../server/cron.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/routes/admin.js', import.meta.url), 'utf8'),
    readFile(
      new URL(
        '../server/db/migrations/046_capture_attention_notifications.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  ]);
  assert.match(route, /enqueueCaptureSafetyAttentionNotification\(tx,/u);
  assert.doesNotMatch(route, /sendTenantEmail|sendMail/u);
  assert.match(notifier, /FOR UPDATE SKIP LOCKED/u);
  assert.match(notifier, /await sendEmailFn\(/u);
  assert.match(cron, /processCaptureAttentionNotifications\(20\)/u);
  assert.match(
    admin,
    /key <> 'capture_attention_email_to'/u,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS capture_attention_notifications/u,
  );
  assert.match(migration, /UNIQUE \(tenant_id, event_key\)/u);
  assert.match(
    migration,
    /status IN \('pending', 'processing', 'retry_wait'\)/u,
  );
});
