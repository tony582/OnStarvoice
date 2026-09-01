import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  matchesExecutionBoundOfficialRecordOwner,
  matchesOfficialRecordOwner,
  resolveCapturedRecordType,
} from '../server/services/official-account-identity.js';
import {
  buildCommentSignalEvents,
  resolveOfficialResponseFacts,
} from '../server/services/comment-workflow.js';

const officialAccount = {
  id: '11111111-1111-4111-8111-111111111111',
  platform: 'douyin',
  account_name: '安吉星',
  aliases: ['OnStar'],
  platform_user_id: 'official-sec-uid',
  account_no: 'OnStarChina',
  account_id: '',
  skip_content: true,
  status: 'active',
  execution_bound: false,
};

test('普通采集的官方原帖只接受强身份，不按同名账号误判', () => {
  assert.equal(matchesOfficialRecordOwner({
    platform: 'douyin',
    author_name: '安吉星',
  }, officialAccount), false);

  assert.equal(matchesOfficialRecordOwner({
    platform: 'douyin',
    author_name: '别的名字也可以',
    author_id: 'official-sec-uid',
  }, officialAccount), true);
});

test('官方巡查执行可在强 ID 暂缺时按绑定账号兜底，但拒绝冲突身份', () => {
  const executionAccount = {
    ...officialAccount,
    platform_user_id: '',
    account_no: '',
    execution_bound: true,
  };
  assert.equal(matchesExecutionBoundOfficialRecordOwner({
    platform: 'douyin',
    author_name: '安吉星',
    author_id: 'captured-sec-uid',
  }, executionAccount), true);

  assert.equal(matchesExecutionBoundOfficialRecordOwner({
    platform: 'douyin',
    author_name: '安吉星',
    author_id: 'different-sec-uid',
  }, {...officialAccount, execution_bound: true}), false);
});

test('官方内容在同步入库前确定类型，并在身份短暂缺失时防降级', () => {
  const strong = resolveCapturedRecordType({
    record: {
      platform: 'douyin',
      record_type: 'blogger_notes',
      author_id: 'official-sec-uid',
      skip_official_accounts: true,
    },
    officialAccounts: [officialAccount],
  });
  assert.equal(strong.recordType, 'official_content');
  assert.equal(strong.officialContent, true);
  assert.equal(strong.source, 'strong_identity');

  const preserved = resolveCapturedRecordType({
    record: {
      platform: 'douyin',
      record_type: 'blogger_notes',
      author_name: '安吉星',
      skip_official_accounts: true,
    },
    existing: {record_type: 'official_content'},
    officialAccounts: [],
  });
  assert.equal(preserved.recordType, 'official_content');
  assert.equal(preserved.source, 'preserved_official_content');
});

test('官方巡查任务不受单台 Extension 的本地排除开关反向覆盖', () => {
  for (const account of [
    {...officialAccount, execution_bound: true},
    {
      ...officialAccount,
      platform_user_id: '',
      account_no: '',
      execution_bound: true,
    },
  ]) {
    const result = resolveCapturedRecordType({
      record: {
        platform: 'douyin',
        record_type: 'blogger_notes',
        author_name: '安吉星',
        author_id: account.platform_user_id || 'captured-sec-uid',
        skip_official_accounts: false,
      },
      officialAccounts: [account],
    });
    assert.equal(result.recordType, 'official_content');
    assert.equal(result.source, 'official_patrol_execution');
  }
});

test('只有明确关闭排除规则才允许官方内容重新进入普通内容', () => {
  const captureOverride = resolveCapturedRecordType({
    record: {
      platform: 'douyin',
      record_type: 'blogger_notes',
      author_id: 'official-sec-uid',
      skip_official_accounts: false,
    },
    existing: {record_type: 'official_content'},
    officialAccounts: [officialAccount],
  });
  assert.equal(captureOverride.recordType, 'blogger_notes');
  assert.equal(captureOverride.officialContent, false);
  assert.equal(captureOverride.source, 'capture_exclusion_disabled');

  const accountOverride = resolveCapturedRecordType({
    record: {
      platform: 'douyin',
      record_type: 'blogger_notes',
      author_id: 'official-sec-uid',
      skip_official_accounts: true,
    },
    existing: {record_type: 'official_content'},
    officialAccounts: [{...officialAccount, skip_content: false}],
  });
  assert.equal(accountOverride.recordType, 'blogger_notes');
  assert.equal(accountOverride.source, 'account_exclusion_disabled');
});

test('账号主页资料继续保持 blogger_profile，不混入官方发文类型', () => {
  const result = resolveCapturedRecordType({
    record: {
      platform: 'douyin',
      record_type: 'blogger_profile',
      author_id: 'official-sec-uid',
    },
    officialAccounts: [officialAccount],
  });
  assert.equal(result.recordType, 'blogger_profile');
  assert.equal(result.officialContent, false);
});

test('评论变化只生成提醒事件，重复采集不重复提醒', () => {
  const events = buildCommentSignalEvents({
    previousAggregate: {negativeCount: 1, officialCount: 0},
    aggregate: {negativeCount: 3, officialCount: 1},
    processingMode: 'reviewed_non_monitor',
  });
  assert.deepEqual(events.map(event => event.action), [
    'record.comment_risk_detected',
    'record.official_response_detected',
  ]);
  for (const event of events) {
    assert.equal(event.metadata.processingMode, 'reviewed_non_monitor');
    assert.equal(event.metadata.processingModeChanged, false);
    assert.equal('nextStatus' in event.metadata, false);
  }

  assert.deepEqual(buildCommentSignalEvents({
    previousAggregate: {negativeCount: 3, officialCount: 1},
    aggregate: {negativeCount: 3, officialCount: 1},
    processingMode: 'reviewed_non_monitor',
  }), []);
});

test('官方原帖归属不等于官方回复，回复事实只由评论作者决定', () => {
  assert.deepEqual(resolveOfficialResponseFacts({negativeCount: 5, officialCount: 0}), {
    officialReplied: false,
    responseStatus: 'none',
  });
  assert.deepEqual(resolveOfficialResponseFacts({negativeCount: 0, officialCount: 1}), {
    officialReplied: true,
    responseStatus: 'responded',
  });
  assert.deepEqual(resolveOfficialResponseFacts({negativeCount: 2, officialCount: 1}), {
    officialReplied: true,
    responseStatus: 'needs_followup',
  });
});

test('同步、AI 与预警链路都对官方内容做独立兜底', async () => {
  const [recordStore, syncRoute, aiLabeler, alertEngine, drawer, patrolRoute, patrolDispatch] = await Promise.all([
    readFile(new URL('../server/services/record-store.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/routes/sync.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/services/ai-labeler.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/services/alert-engine.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/admin/src/components/shared/RecordDrawer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../server/routes/official-comment-patrol.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/services/profile-patrol-dispatch.js', import.meta.url), 'utf8'),
  ]);

  assert.match(recordStore, /resolveCapturedRecordType/);
  assert.match(recordStore, /subscription\.subject_type = 'official'/);
  assert.match(recordStore, /officialContent: officialResolution\.officialContent/);
  assert.match(syncRoute, /result\.officialContent\) return null/);
  assert.match(aiLabeler, /\['official_content', 'blogger_profile'\]\.includes\(record\?\.record_type\)/);
  assert.match(alertEngine, /\['official_content', 'blogger_profile'\]\.includes\(record\.record_type\)/);
  assert.match(drawer, /新增负评提醒/);
  assert.match(drawer, /仅作提醒，处理状态仍为/);
  assert.match(patrolRoute, /skipOfficialAccounts:\s*true/);
  assert.match(patrolDispatch, /skipOfficialAccounts:\s*true/);
});
