import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const load = relativePath => readFile(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
)

const [patrolRoute, adminRoute, exclusionPage, mergeMigration] = await Promise.all([
  load('server/routes/official-comment-patrol.js'),
  load('server/routes/admin.js'),
  load('web/admin/src/pages/OwnedAccountExclusionsPage.tsx'),
  load('server/db/migrations/052_merge_legacy_official_account_exclusions.sql'),
])

test('official account management returns only accounts backed by a patrol subscription', () => {
  assert.match(
    patrolRoute,
    /JOIN LATERAL \([\s\S]*monitor\.official_account_id = account\.id[\s\S]*monitor\.subject_type = 'official'/u,
  )
  assert.match(patrolRoute, /subscription\.status AS subscription_status/u)
  assert.match(patrolRoute, /subscription\.last_run_at AS subscription_last_run_at/u)
  assert.match(patrolRoute, /subscriptionStatus: account\.subscription_status/u)
  assert.match(patrolRoute, /lastCollectedAt: isoOrNull\(account\.subscription_last_run_at\)/u)
})

test('self-owned-content exclusions use a separate non-destructive API', () => {
  assert.match(exclusionPage, /\/admin\/owned-account-exclusions/u)
  assert.doesNotMatch(exclusionPage, /api\.(get|put)\([^)]*\/admin\/official-accounts/u)
  assert.match(
    adminRoute,
    /router\.put\('\/official-accounts'[\s\S]*official_accounts_extension_managed/u,
  )
  const start = adminRoute.indexOf("router.put('/owned-account-exclusions'")
  const end = adminRoute.indexOf('// 回溯重标', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const exclusionRoute = adminRoute.slice(start, end)
  assert.match(exclusionRoute, /existing\?\.extension_managed/u)
  assert.match(exclusionRoute, /SET skip_content = false/u)
  assert.doesNotMatch(
    exclusionRoute,
    /UPDATE monitor_subscriptions|INSERT INTO monitor_subscriptions|DELETE FROM monitor_subscriptions/u,
  )
})

test('migration safely merges only unlinked name-only legacy exclusions', () => {
  assert.match(mergeMigration, /CREATE TEMP TABLE official_account_legacy_merge ON COMMIT DROP/u)
  assert.match(
    mergeMigration,
    /subscription\.official_account_id = account\.id[\s\S]*subscription\.subject_type = 'official'/u,
  )
  assert.match(
    mergeMigration,
    /legacy\.platform_user_id = ''[\s\S]*legacy\.account_no = ''[\s\S]*legacy\.account_id = ''[\s\S]*legacy\.profile_url = ''/u,
  )
  assert.match(mergeMigration, /UPDATE official_responses response/u)
  assert.match(mergeMigration, /UPDATE monitor_subscriptions subscription/u)
  assert.match(mergeMigration, /UPDATE official_comment_patrol_snapshots snapshot/u)
  assert.match(mergeMigration, /SET status = 'deleted'/u)
})
