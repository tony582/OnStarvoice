import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

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
  assert.match(
    monitorRoute,
    /\$3 = '' AND \$4 = '' AND \$5 = '' AND \$6 = ''[\s\S]*account_name = \$7/u,
  );
  assert.match(
    officialPatrolRoute,
    /r\.author_id = oa\.platform_user_id/u,
  );
  assert.match(
    officialPatrolRoute,
    /r\.author_account_no = oa\.account_no/u,
  );
  assert.match(
    officialPatrolRoute,
    /r\.author_id = oa\.account_id[\s\S]*r\.author_account_no = oa\.account_id/u,
  );
  assert.match(commentWorkflow, /account\.platform_user_id/u);
  assert.match(commentWorkflow, /account\.account_no/u);
  assert.match(commentWorkflow, /legacyAccountId/u);
  assert.match(
    officialPatrolRoute,
    /NOT \([\s\S]*oa\.platform_user_id[\s\S]*r\.author_id[\s\S]*\)[\s\S]*r\.author_name = oa\.account_name/u,
  );
  assert.match(
    commentWorkflow,
    /if \(accountHasStrongIdentity && subjectHasStrongIdentity\) return false/u,
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

test('legacy official-account saves create or reuse a tenant-safe linked official subscription', () => {
  assert.match(
    adminRoute,
    /async function syncOfficialAccountMonitorSubscription\(tx, tenantId, account\)/u,
  );
  assert.match(
    adminRoute,
    /WHERE tenant_id = \$1[\s\S]*subject_type = 'official'[\s\S]*official_account_id = \$2[\s\S]*FOR UPDATE/u,
  );
  assert.match(
    adminRoute,
    /account_url = \$3[\s\S]*official_account_id IS NULL OR official_account_id = \$4/u,
  );
  assert.match(
    adminRoute,
    /INSERT INTO monitor_subscriptions \([\s\S]*subject_type,[\s\S]*official_account_id[\s\S]*'active', true, '', now\(\), 'official', \$6/u,
  );
  assert.match(
    adminRoute,
    /await syncOfficialAccountMonitorSubscription\(tx, tenantId, saved\)/u,
  );
});

test('legacy official-account status changes preserve subscription history', () => {
  assert.match(
    adminRoute,
    /accountStatus === 'deleted'[\s\S]*accountStatus === 'active'[\s\S]*'paused'/u,
  );
  assert.match(
    adminRoute,
    /UPDATE monitor_subscriptions[\s\S]*status = \$5[\s\S]*official_account_id = \$6[\s\S]*WHERE id = \$7 AND tenant_id = \$8/u,
  );
  assert.match(
    adminRoute,
    /UPDATE monitor_subscriptions AS subscription[\s\S]*SET status = 'deleted'[\s\S]*account\.tenant_id = \$1[\s\S]*subscription\.tenant_id = \$1/u,
  );
  assert.doesNotMatch(
    adminRoute,
    /DELETE FROM monitor_subscriptions/u,
  );
});

test('admin account saves preserve stable rows and links', () => {
  assert.doesNotMatch(adminRoute, /DELETE FROM official_accounts WHERE tenant_id/u);
  assert.match(
    adminRoute,
    /UPDATE official_accounts[\s\S]*WHERE id = \$11 AND tenant_id = \$12[\s\S]*RETURNING \*/u,
  );
  assert.match(
    adminRoute,
    /SET status = 'deleted', updated_at = now\(\)[\s\S]*tenant_id = \$1/u,
  );
  assert.match(adminRoute, /platform_user_id = CASE WHEN \$3 <> ''/u);
  assert.match(adminRoute, /account_no = CASE WHEN \$4 <> ''/u);
});
