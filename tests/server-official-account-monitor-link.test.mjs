import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  matchesOfficialCommentAuthor,
  matchesOfficialRecordOwner,
} from '../server/services/comment-workflow.js';

const migration = await readFile(
  new URL('../server/db/migrations/049_official_account_monitor_link.sql', import.meta.url),
  'utf8',
);
const initialMigration = await readFile(
  new URL('../server/db/migrations/001_initial_postgres.sql', import.meta.url),
  'utf8',
);
const monitorRoute = await readFile(
  new URL('../server/routes/monitor.js', import.meta.url),
  'utf8',
);
const officialPatrolRoute = await readFile(
  new URL('../server/routes/official-comment-patrol.js', import.meta.url),
  'utf8',
);
const commentWorkflow = await readFile(
  new URL('../server/services/comment-workflow.js', import.meta.url),
  'utf8',
);
const adminRoute = await readFile(
  new URL('../server/routes/admin.js', import.meta.url),
  'utf8',
);

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source section: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('migration separates creator subscriptions from linked official accounts', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS platform_user_id TEXT/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS account_no TEXT/u);
  assert.match(
    migration,
    /DROP INDEX IF EXISTS uniq_official_accounts_tenant_platform_id[\s\S]*account_id <> '' AND status <> 'deleted'/u,
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS subject_type TEXT NOT NULL DEFAULT 'creator'/u);
  assert.match(
    migration,
    /official_account_id UUID[\s\S]*REFERENCES official_accounts\(id\) ON DELETE SET NULL/u,
  );
  assert.match(
    migration,
    /assigned_agent_id UUID[\s\S]*REFERENCES capture_agents\(id\) ON DELETE SET NULL/u,
  );
  assert.match(migration, /CHECK \(subject_type IN \('creator', 'official'\)\)/u);
  assert.match(
    migration,
    /WHERE official_account_id IS NOT NULL[\s\S]*subject_type <> 'official'/u,
  );
});

test('migration restores legacy official accounts and enforces one active execution', () => {
  assert.match(
    migration,
    /account\.profile_url = subscription\.account_url/u,
  );
  assert.match(
    migration,
    /INSERT INTO monitor_subscriptions \([\s\S]*official_account_id[\s\S]*FROM official_accounts account/u,
  );
  assert.match(
    migration,
    /subscription\.official_account_id = account\.id[\s\S]*subscription\.account_url = account\.profile_url/u,
  );
  assert.doesNotMatch(
    migration,
    /account\.account_name\s*=\s*subscription\.name/u,
  );
  assert.match(
    migration,
    /row_number\(\) OVER \([\s\S]*PARTITION BY subscription_id/u,
  );
  assert.match(
    migration,
    /uniq_monitor_executions_subscription_active[\s\S]*WHERE status IN \('pending', 'running'\)/u,
  );
});

test('migration preserves disabled state and pauses the exact legacy creator schedule', () => {
  assert.match(
    migration,
    /CASE WHEN account\.status = 'active' THEN 'active' ELSE 'paused' END/u,
  );
  assert.match(
    initialMigration,
    /next_run_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/u,
  );
  assert.match(
    migration,
    /CASE WHEN account\.status = 'active' THEN 'active' ELSE 'paused' END,[\s\S]*true,[\s\S]*'',[\s\S]*now\(\),[\s\S]*'official'/u,
  );
  assert.doesNotMatch(
    migration,
    /CASE WHEN account\.status = 'active' THEN now\(\) ELSE NULL END/u,
  );
  assert.match(
    migration,
    /UPDATE monitor_subscriptions creator[\s\S]*creator\.subject_type = 'creator'[\s\S]*creator\.status = 'active'[\s\S]*creator\.account_url = account\.profile_url/u,
  );
  assert.match(
    migration,
    /FROM monitor_subscriptions official[\s\S]*official\.subject_type = 'official'[\s\S]*official\.official_account_id = account\.id[\s\S]*official\.account_url = account\.profile_url/u,
  );
  assert.doesNotMatch(
    migration,
    /UPDATE monitor_subscriptions creator[\s\S]*creator\.keyword\s*=\s*account\.account_name/u,
  );
});

test('monitor subscriptions expose and filter subject type', () => {
  assert.match(monitorRoute, /subjectType: row\.subject_type \|\| 'creator'/u);
  assert.match(monitorRoute, /officialAccountId: row\.official_account_id \|\| null/u);
  assert.match(monitorRoute, /subjectType = ''/u);
  assert.match(monitorRoute, /AND ms\.subject_type = \$\$\{params\.length\}/u);
  assert.match(monitorRoute, /invalid_subject_type/u);
  assert.match(
    monitorRoute,
    /EXISTS \([\s\S]*official\.tenant_id = ms\.tenant_id[\s\S]*official\.subject_type = 'official'[\s\S]*official\.status = 'active'/u,
  );
  assert.match(
    monitorRoute,
    /official\.account_url = ms\.account_url[\s\S]*COALESCE\(official\.account_url, ''\) = ''[\s\S]*COALESCE\(ms\.account_url, ''\) = ''[\s\S]*official\.keyword = ms\.keyword/u,
  );
  assert.match(
    monitorRoute,
    /hasOfficialRole: Boolean\(row\.has_official_role\)/u,
  );
});

test('mark-official is tenant-safe, transactional, and reuses the POST path', () => {
  assert.match(
    monitorRoute,
    /'\/subscriptions\/:id\/mark-official'[\s\S]*withTransaction\(tx => markSubscriptionOfficial/u,
  );
  assert.match(
    monitorRoute,
    /FROM monitor_subscriptions[\s\S]*WHERE id = \$1 AND tenant_id = \$2[\s\S]*FOR UPDATE/u,
  );
  assert.match(
    monitorRoute,
    /UPDATE monitor_subscriptions[\s\S]*subject_type = 'official'[\s\S]*official_account_id = \$1[\s\S]*tenant_id = \$3/u,
  );
  assert.match(
    monitorRoute,
    /if \(input\.subjectType === 'official'\)[\s\S]*markSubscriptionOfficial\(tx/u,
  );
  assert.match(
    monitorRoute,
    /if \(subscription\?\.status === 'deleted'\)[\s\S]*else if \(!subscription\)/u,
  );
  assert.match(
    monitorRoute,
    /platform = \$2[\s\S]*subject_type = \$5[\s\S]*keyword = \$3/u,
  );
  assert.match(
    monitorRoute,
    /monitor_subscription\.marked_official/u,
  );
});

test('converting a creator preserves history while pausing the old scheduling path', () => {
  assert.match(
    monitorRoute,
    /if \(\(subscription\.subject_type \|\| 'creator'\) === 'official'\)/u,
  );
  assert.match(
    monitorRoute,
    /WHERE tenant_id = \$1[\s\S]*subject_type = 'official'[\s\S]*FOR UPDATE/u,
  );
  assert.match(
    monitorRoute,
    /INSERT INTO monitor_subscriptions \([\s\S]*subject_type,[\s\S]*official_account_id[\s\S]*'official', \$9/u,
  );
  assert.match(
    monitorRoute,
    /sourceSubscription(?:,|: subscription)/u,
  );
  assert.match(
    monitorRoute,
    /SET status = 'paused'[\s\S]*WHERE id = \$1 AND tenant_id = \$2/u,
  );
  assert.match(
    monitorRoute,
    /creatorHistoryPreserved: subscription\.id !== linkedSubscription\.id/u,
  );
  assert.match(
    monitorRoute,
    /creatorSubscriptionPaused: sourceSubscription\.status === 'paused'/u,
  );
  assert.match(
    monitorRoute,
    /assigned_agent_id = COALESCE\(\$7::uuid, assigned_agent_id\)/u,
  );
});

test('extension registration binds only its own active Agent', () => {
  assert.match(monitorRoute, /assignedAgentId: row\.assigned_agent_id \|\| null/u);
  assert.match(monitorRoute, /validateSubscriptionAgentBinding/u);
  assert.match(
    monitorRoute,
    /\(\$3 <> 'auth_code' OR code\.id = \$4::uuid\)/u,
  );
  assert.match(
    monitorRoute,
    /assigned_agent_id = COALESCE\(\$7::uuid, assigned_agent_id\)/u,
  );
  assert.match(
    monitorRoute,
    /assigned_agent_binding_invalid/u,
  );
  assert.match(
    monitorRoute,
    /if \(!subscription && input\.subjectType === 'official'\)[\s\S]*subject_type = 'creator'[\s\S]*status <> 'deleted'/u,
  );
  assert.match(
    monitorRoute,
    /created = created \|\| marked\.linkedSubscriptionCreated/u,
  );
});

test('Extension deletion retires the linked official account without touching other live links', () => {
  const route = sourceSection(
    monitorRoute,
    "router.patch('/subscriptions/:id'",
    "router.get('/executions'",
  );
  assert.match(route, /withTransaction\(async tx/u);
  assert.match(route, /UPDATE monitor_subscriptions[\s\S]*RETURNING \*/u);
  assert.match(
    route,
    /saved\.subject_type === 'official'[\s\S]*status === 'deleted'[\s\S]*UPDATE official_accounts account[\s\S]*SET status = 'deleted'/u,
  );
  assert.match(
    route,
    /NOT EXISTS \([\s\S]*other\.official_account_id = account\.id[\s\S]*other\.subject_type = 'official'[\s\S]*other\.status <> 'deleted'/u,
  );
  assert.match(
    route,
    /status === 'active'[\s\S]*UPDATE official_accounts[\s\S]*SET status = 'active'/u,
  );
});

test('legacy run-now executes creator subscriptions only', () => {
  assert.match(
    monitorRoute,
    /router\.post\('\/run-now'[\s\S]*subjectType !== 'creator'/u,
  );
  assert.match(
    monitorRoute,
    /official_subscription_requires_dispatch/u,
  );
  assert.match(
    monitorRoute,
    /WHERE tenant_id = \$1[\s\S]*status = 'active'[\s\S]*subject_type = \$2/u,
  );
});

test('extension identity fields keep internal UID and visible account number separate', () => {
  assert.match(
    monitorRoute,
    /platformUserId: normalizeText\([\s\S]*body\.profileInternalId[\s\S]*body\.platformBloggerId/u,
  );
  assert.match(
    monitorRoute,
    /accountNo: normalizeText\([\s\S]*body\.accountNo[\s\S]*body\.authorAccountNo/u,
  );
  assert.match(
    monitorRoute,
    /accountName: normalizeText\([\s\S]*body\.displayName/u,
  );
  assert.match(monitorRoute, /avatarUrl: normalizeText\(body\.avatarUrl/u);
  assert.doesNotMatch(
    monitorRoute,
    /accountNo: normalizeText\([\s\S]{0,180}body\.platformBloggerId/u,
  );
  const identityResolver = sourceSection(
    monitorRoute,
    'function resolveOfficialIdentity',
    'function mergeAliases',
  );
  assert.doesNotMatch(identityResolver, /subscription\.keyword/u);
});

test('official identity matching distinguishes platform UID and human account number', () => {
  const officialAccountWhere = sourceSection(
    officialPatrolRoute,
    'function officialAccountWhere',
    'function publicCandidate',
  );
  assert.match(
    monitorRoute,
    /\$3 = '' AND \$4 = '' AND \$5 = '' AND \$6 = ''[\s\S]*account_name = \$7/u,
  );
  assert.match(
    officialAccountWhere,
    /r\.author_id = oa\.platform_user_id/u,
  );
  assert.match(
    officialAccountWhere,
    /r\.author_account_no = oa\.account_no/u,
  );
  assert.match(
    officialAccountWhere,
    /r\.author_id = oa\.account_id[\s\S]*r\.author_account_no = oa\.account_id/u,
  );
  assert.doesNotMatch(
    officialAccountWhere,
    /author_name|jsonb_array_elements_text/u,
  );
  assert.match(commentWorkflow, /account\.platform_user_id/u);
  assert.match(commentWorkflow, /account\.account_no/u);
  assert.match(commentWorkflow, /legacyAccountId/u);

  const official = {
    status: 'active',
    platform: 'douyin',
    account_name: '安吉星',
    aliases: ['上海安吉星信息服务有限公司'],
    platform_user_id: 'official-uid',
    account_no: 'official-no',
    account_id: 'legacy-id',
  };
  assert.equal(
    matchesOfficialRecordOwner(
      {platform: 'douyin', author_name: '安吉星'},
      official,
    ),
    false,
  );
  assert.equal(
    matchesOfficialRecordOwner(
      {platform: 'douyin', author_id: 'official-uid'},
      official,
    ),
    true,
  );
  assert.equal(
    matchesOfficialCommentAuthor(
      {platform: 'douyin', author_name: '安吉星'},
      official,
    ),
    false,
  );
  assert.equal(
    matchesOfficialCommentAuthor(
      {platform: 'douyin', author_id: 'official-uid'},
      official,
    ),
    true,
  );
  const legacyOfficial = {
    ...official,
    platform_user_id: '',
    account_no: '',
    account_id: '',
  };
  assert.equal(
    matchesOfficialCommentAuthor(
      {platform: 'douyin', author_name: '安吉星'},
      legacyOfficial,
    ),
    true,
  );
  assert.equal(
    matchesOfficialRecordOwner(
      {platform: 'douyin', author_name: '安吉星'},
      legacyOfficial,
    ),
    false,
  );
});

test('subscription matching prefers strong identity or exact URL over a same-name keyword', () => {
  const markOfficial = sourceSection(
    monitorRoute,
    'async function markSubscriptionOfficial',
    "router.get('/subscriptions'",
  );
  assert.match(
    markOfficial,
    /official_account_id = \$3[\s\S]*\$4 <> '' AND keyword = \$4[\s\S]*\$5 <> '' AND account_url <> '' AND account_url = \$5/u,
  );
  assert.match(
    markOfficial,
    /\$5 = ''[\s\S]*COALESCE\(account_url, ''\) = ''[\s\S]*keyword = \$6/u,
  );
  assert.doesNotMatch(
    markOfficial,
    /keyword = \$\d+\s+OR\s+\(\$\d+ <> '' AND account_url/u,
  );

  const createRoute = sourceSection(
    monitorRoute,
    "router.post('/subscriptions'",
    "router.post(\n  '/subscriptions/:id/mark-official'",
  );
  assert.match(
    createRoute,
    /\$6::uuid IS NOT NULL AND official_account_id = \$6::uuid/u,
  );
  assert.match(
    createRoute,
    /\$7 <> '' AND keyword = \$7/u,
  );
  assert.match(
    createRoute,
    /\$4 <> '' AND account_url <> '' AND account_url = \$4[\s\S]*\$4 = ''[\s\S]*COALESCE\(account_url, ''\) = ''[\s\S]*keyword = \$3/u,
  );
  assert.doesNotMatch(
    createRoute,
    /keyword = \$3\s+OR\s+\(\$4 <> '' AND account_url/u,
  );
});

test('legacy official-account admin matching never falls back to a name when strong identity exists', () => {
  assert.match(
    adminRoute,
    /\$3 = '' AND \$4 = '' AND \$5 = '' AND \$6 = ''[\s\S]*account_name = \$7/u,
  );
  assert.doesNotMatch(
    adminRoute,
    /OR \(\$7 <> '' AND account_name = \$7\)/u,
  );
});

test('historical reclassification uses strong record identity and guarded legacy comment fallback', () => {
  const route = sourceSection(
    adminRoute,
    "router.post(['/owned-account-exclusions/reclassify'",
    "router.post('/login'",
  );
  const recordUpdate = sourceSection(route, '// ①', '// ②');
  assert.doesNotMatch(
    recordUpdate,
    /account_name\s*=\s*r\.author_name|jsonb_array_elements_text/u,
  );
  assert.ok(route.includes("COALESCE(${officialAlias}.platform_user_id, '') = ''"));
  assert.ok(route.includes("COALESCE(${officialAlias}.account_no, '') = ''"));
  assert.ok(route.includes("COALESCE(${officialAlias}.account_id, '') = ''"));
  assert.ok(route.includes("COALESCE(${rowAlias}.author_id, '') = ''"));
  assert.ok(route.includes("CASE\n                WHEN jsonb_typeof(${officialAlias}.aliases) = 'array'"));
  assert.ok(route.includes("${commentAuthorMatchSql('c')}"));
});

test('backend official-account writes are blocked because Extension owns the lifecycle', () => {
  assert.match(
    adminRoute,
    /router\.put\('\/official-accounts'[\s\S]*status\(409\)[\s\S]*official_accounts_extension_managed/u,
  );
  assert.doesNotMatch(adminRoute, /syncOfficialAccountMonitorSubscription/u);
});

test('owned-content exclusion saves never mutate Extension patrol subscriptions', () => {
  const route = sourceSection(
    adminRoute,
    "router.put('/owned-account-exclusions'",
    '// 回溯重标',
  );
  assert.match(
    route,
    /existing\?\.extension_managed[\s\S]*SET skip_content = true/u,
  );
  assert.match(
    route,
    /SET skip_content = false[\s\S]*subscription\.subject_type = 'official'[\s\S]*subscription\.status <> 'deleted'/u,
  );
  assert.match(
    route,
    /SET status = 'deleted'[\s\S]*NOT EXISTS \([\s\S]*subscription\.subject_type = 'official'/u,
  );
  assert.doesNotMatch(route, /UPDATE monitor_subscriptions|INSERT INTO monitor_subscriptions|DELETE FROM monitor_subscriptions/u);
});

test('owned-content exclusions preserve stable rows and strong identity', () => {
  const route = sourceSection(
    adminRoute,
    "router.put('/owned-account-exclusions'",
    '// 回溯重标',
  );
  assert.doesNotMatch(route, /DELETE FROM official_accounts WHERE tenant_id/u);
  assert.match(
    route,
    /UPDATE official_accounts[\s\S]*WHERE id = \$9 AND tenant_id = \$10[\s\S]*RETURNING \*/u,
  );
  assert.match(
    route,
    /SET status = 'deleted',[\s\S]*updated_at = now\(\)[\s\S]*account\.tenant_id = \$1/u,
  );
  assert.match(route, /platform_user_id = CASE WHEN \$3 <> ''/u);
  assert.match(route, /account_no = CASE WHEN \$4 <> ''/u);
});
