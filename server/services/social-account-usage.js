const SUPPORTED_PLATFORMS = new Set(['xiaohongshu', 'douyin', 'weibo']);
const LOGIN_STATES = new Set(['authenticated', 'logged_out', 'unknown']);
const IDENTITY_CONFIDENCES = new Set(['high', 'medium', 'low', 'unknown']);
const RESERVED_PLATFORM_ACCOUNT_IDS = new Set([
  'self',
  'me',
  'my',
  'profile',
  'home',
  'login',
  'undefined',
  'null',
]);
const MAX_USAGE_EVENTS_PER_HEARTBEAT = 200;
const MAX_EVENT_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

function text(value, limit = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function count(value, maximum = 10000) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(maximum, parsed);
}

function safeJson(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const SAFETY_EVIDENCE_CODES = new Set([
  'XHS_SECURITY_BLOCK',
  'DOUYIN_SEARCH_SECURITY_CHALLENGE',
  'SECURITY_VERIFICATION_REQUIRED',
  'PAGE_CHALLENGE_BLOCK',
  'PLATFORM_SAFETY_BLOCK',
  'HTTP_429',
  'RATE_LIMITED',
  'LOGIN_REQUIRED',
  'AUTHENTICATION_REQUIRED',
]);
const SAFETY_EVIDENCE_CATEGORIES = new Set([
  'platform_safety_block',
  'login_required',
  'authentication_required',
]);

function containsSafetyEvidence(value, depth = 0) {
  if (depth > 4 || value == null) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.slice(0, 30).some(item => containsSafetyEvidence(item, depth + 1));
  }
  const code = text(value.code || value.errorCode, 120).toUpperCase();
  const category = text(value.category || value.errorCategory, 120)
    .toLowerCase();
  if (
    SAFETY_EVIDENCE_CODES.has(code) ||
    SAFETY_EVIDENCE_CATEGORIES.has(category) ||
    value.securityEvidence?.confirmed === true ||
    value.safetyEvidence?.confirmed === true
  ) {
    return true;
  }
  return Object.entries(value).slice(0, 80).some(([key, nested]) => {
    if (
      /platformSafetyBlocked|platform_safety_blocked|securityBlocked|security_blocked|requiresManualAction|requires_manual_action|loginRequired|login_required/iu.test(key) &&
      nested === true
    ) {
      return true;
    }
    return containsSafetyEvidence(nested, depth + 1);
  });
}

export function normalizeSocialPlatform(value) {
  const platform = text(value, 40).toLowerCase();
  return SUPPORTED_PLATFORMS.has(platform) ? platform : '';
}

export function isReservedPlatformAccountId(value) {
  return RESERVED_PLATFORM_ACCOUNT_IDS.has(
    text(value, 240).toLowerCase().replace(/^@/u, ''),
  );
}

export function hasDurableSocialAccountIdentity(value = {}) {
  const source = safeJson(value);
  return Boolean(
    (
      text(source.platformAccountId, 240) &&
      !isReservedPlatformAccountId(source.platformAccountId)
    ) ||
    (
      text(source.accountHandle, 160) &&
      !isReservedPlatformAccountId(source.accountHandle)
    ),
  );
}

export function isTrustedSocialAccountObservation(value = {}) {
  const source = safeJson(value);
  return (
    hasDurableSocialAccountIdentity(source) &&
    ['high', 'medium'].includes(
      text(source.confidence, 40).toLowerCase(),
    )
  );
}

export function socialAccountIdentityMatchesAccount(
  observedValue = {},
  accountValue = {},
) {
  const observed = safeJson(observedValue);
  const account = safeJson(accountValue);
  const observedId = text(observed.platformAccountId, 240);
  const accountId = text(
    account.platform_account_id || account.platformAccountId,
    240,
  );
  if (observedId && accountId) return observedId === accountId;
  const observedHandle = text(observed.accountHandle, 160).toLowerCase();
  const accountHandle = text(
    account.account_handle || account.accountHandle,
    160,
  ).toLowerCase();
  return Boolean(
    observedHandle &&
    accountHandle &&
    observedHandle === accountHandle,
  );
}

export function normalizeObservedSocialAccount(value = {}) {
  const source = safeJson(value);
  const platform = normalizeSocialPlatform(source.platform);
  if (!platform) return null;
  const loginState = LOGIN_STATES.has(source.loginState)
    ? source.loginState
    : 'unknown';
  const rawPlatformAccountId = text(
    source.platformAccountId || source.accountId,
    240,
  );
  const platformAccountId = isReservedPlatformAccountId(
    rawPlatformAccountId,
  )
    ? ''
    : rawPlatformAccountId;
  const rawAccountHandle = text(
    source.accountHandle || source.handle,
    160,
  );
  const accountHandle = isReservedPlatformAccountId(rawAccountHandle)
    ? ''
    : rawAccountHandle;
  const displayName = text(
    source.displayName || source.accountName,
    160,
  );
  const observedAt = new Date(source.observedAt || Date.now());
  return {
    platform,
    platformAccountId,
    accountHandle,
    displayName,
    avatarUrl: text(source.avatarUrl, 1000),
    loginState,
    confidence: IDENTITY_CONFIDENCES.has(
      text(source.confidence, 40).toLowerCase(),
    )
      ? text(source.confidence, 40).toLowerCase()
      : 'unknown',
    sourceUrl: text(source.sourceUrl, 1000),
    observedAt: Number.isFinite(observedAt.getTime())
      ? observedAt.toISOString()
      : new Date().toISOString(),
  };
}

function shanghaiDate(value) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export function normalizeSocialUsageEvent(value = {}, now = Date.now()) {
  const source = safeJson(value);
  const eventId = text(source.eventId || source.id, 240);
  const platform = normalizeSocialPlatform(source.platform);
  const occurredAt = new Date(source.occurredAt || source.createdAt || now);
  const occurredMs = occurredAt.getTime();
  if (
    !eventId ||
    !platform ||
    !Number.isFinite(occurredMs) ||
    occurredMs < now - MAX_EVENT_AGE_MS ||
    occurredMs > now + MAX_FUTURE_SKEW_MS
  ) {
    return null;
  }
  const searches = count(source.searches);
  const enhancements = count(source.enhancements);
  const captureRuns = count(source.captureRuns);
  const capturedItems = count(source.capturedItems, 100000);
  if (searches + enhancements + captureRuns + capturedItems === 0) {
    return null;
  }
  const metadata = safeJson(source.metadata);
  return {
    eventId,
    platform,
    searches,
    enhancements,
    captureRuns,
    capturedItems,
    succeeded: source.succeeded !== false,
    safetyVerification:
      source.safetyVerification === true ||
      source.securityVerification === true ||
      containsSafetyEvidence(metadata),
    occurredAt: occurredAt.toISOString(),
    usageDate: shanghaiDate(occurredAt),
    accountIdentity: normalizeObservedSocialAccount({
      ...safeJson(source.accountIdentity),
      platform,
      loginState: 'authenticated',
      observedAt:
        safeJson(source.accountIdentity).observedAt ||
        occurredAt.toISOString(),
    }),
    metadata,
  };
}

export function normalizeSocialUsageEvents(value, now = Date.now()) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];
  for (const item of source.slice(0, MAX_USAGE_EVENTS_PER_HEARTBEAT)) {
    const event = normalizeSocialUsageEvent(item, now);
    if (!event || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    normalized.push(event);
  }
  return normalized;
}

async function currentBinding(tx, agent, platform) {
  return await tx.queryOne(`
    SELECT
      b.id AS binding_id, b.social_account_id, b.source AS binding_source,
      a.platform_account_id, a.account_handle, a.display_name,
      a.identity_source, a.agent_binding_mode
    FROM social_account_bindings b
    JOIN social_accounts a
      ON a.id = b.social_account_id AND a.tenant_id = b.tenant_id
    WHERE b.tenant_id = $1
      AND b.agent_id = $2
      AND b.platform = $3
      AND b.status = 'current'
    ORDER BY b.first_seen_at DESC
    LIMIT 1
    FOR UPDATE OF b, a
  `, [agent.tenant_id, agent.id, platform]);
}

async function findObservedAccount(tx, agent, observed) {
  if (observed.platformAccountId) {
    const byId = await tx.queryOne(`
      SELECT id, identity_source, agent_binding_mode,
        platform_account_id, account_handle
      FROM social_accounts
      WHERE tenant_id = $1 AND platform = $2 AND platform_account_id = $3
      LIMIT 1
    `, [
      agent.tenant_id,
      observed.platform,
      observed.platformAccountId,
    ]);
    if (byId) return byId;
  }
  if (observed.accountHandle) {
    return await tx.queryOne(`
      SELECT id, identity_source, agent_binding_mode,
        platform_account_id, account_handle
      FROM social_accounts
      WHERE tenant_id = $1
        AND platform = $2
        AND lower(account_handle) = lower($3)
        AND (
          $4 = ''
          OR platform_account_id = ''
          OR platform_account_id = $4
        )
      LIMIT 1
    `, [
      agent.tenant_id,
      observed.platform,
      observed.accountHandle,
      observed.platformAccountId,
    ]);
  }
  return null;
}

async function updateAccountObservation(tx, agent, accountId, observed) {
  return await tx.queryOne(`
    UPDATE social_accounts
    SET platform_account_id = CASE
        WHEN identity_source <> 'manual' AND platform_account_id = '' THEN $1
        ELSE platform_account_id
      END,
      account_handle = CASE
        WHEN identity_source <> 'manual' AND account_handle = '' THEN $2
        ELSE account_handle
      END,
      display_name = CASE
        WHEN identity_source = 'manual' THEN display_name
        ELSE COALESCE(NULLIF($3, ''), display_name)
      END,
      identity_source = CASE
        WHEN identity_source = 'placeholder'
          AND ($1 <> '' OR $2 <> '')
          THEN 'extension'
        ELSE identity_source
      END,
      health_status = CASE
        WHEN $4 = 'logged_out' AND health_status = 'active'
          THEN 'login_required'
        WHEN $4 = 'authenticated' AND health_status = 'login_required'
          THEN 'active'
        ELSE health_status
      END,
      last_seen_at = CASE
        WHEN $4 = 'authenticated' THEN $5::timestamptz
        ELSE last_seen_at
      END,
      last_agent_id = $6,
      updated_at = now()
    WHERE id = $7 AND tenant_id = $8
    RETURNING id
  `, [
    observed.platformAccountId,
    observed.accountHandle,
    observed.displayName,
    observed.loginState,
    observed.observedAt,
    agent.id,
    accountId,
    agent.tenant_id,
  ]);
}

async function bindAccount(tx, agent, accountId, observed, source) {
  await tx.execute(`
    UPDATE social_account_bindings
    SET status = 'historical', ended_at = now(), updated_at = now()
    WHERE tenant_id = $1 AND agent_id = $2 AND platform = $3
      AND status = 'current' AND social_account_id <> $4
  `, [agent.tenant_id, agent.id, observed.platform, accountId]);
  const binding = await tx.queryOne(`
    INSERT INTO social_account_bindings (
      tenant_id, agent_id, social_account_id, platform, source,
      last_login_state, first_seen_at, last_seen_at, metadata
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7::timestamptz, $7::timestamptz, $8::jsonb
    )
    ON CONFLICT (
      tenant_id, agent_id, platform
    ) WHERE status = 'current'
    DO UPDATE SET
      social_account_id = EXCLUDED.social_account_id,
      source = EXCLUDED.source,
      last_login_state = EXCLUDED.last_login_state,
      last_seen_at = EXCLUDED.last_seen_at,
      metadata = social_account_bindings.metadata || EXCLUDED.metadata,
      updated_at = now()
    RETURNING id, social_account_id
  `, [
    agent.tenant_id,
    agent.id,
    accountId,
    observed.platform,
    source,
    observed.loginState,
    observed.observedAt,
    JSON.stringify({
      confidence: observed.confidence,
      sourceUrl: observed.sourceUrl,
      avatarUrl: observed.avatarUrl,
    }),
  ]);
  return binding;
}

async function createObservedAccount(tx, agent, observed, source) {
  const created = await tx.queryOne(`
    INSERT INTO social_accounts (
      tenant_id, platform, platform_account_id, account_handle,
      display_name, identity_source, health_status, last_seen_at,
      last_agent_id
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8::timestamptz,
      $9
    )
    ON CONFLICT DO NOTHING
    RETURNING id, identity_source, agent_binding_mode,
      platform_account_id, account_handle
  `, [
    agent.tenant_id,
    observed.platform,
    observed.platformAccountId,
    observed.accountHandle,
    observed.displayName || '未识别账号',
    source,
    observed.loginState === 'logged_out' ? 'login_required' : 'unknown',
    observed.loginState === 'authenticated' ? observed.observedAt : null,
    agent.id,
  ]);
  if (created) return created;
  return await findObservedAccount(tx, agent, observed);
}

export async function ensureCurrentSocialAccount(
  tx,
  agent,
  platform,
  observedValue = null,
) {
  const observed = normalizeObservedSocialAccount(
    observedValue || {
      platform,
      loginState: 'unknown',
      observedAt: new Date().toISOString(),
    },
  );
  if (!observed) return null;
  const current = await currentBinding(tx, agent, observed.platform);
  const hasDurableIdentity = hasDurableSocialAccountIdentity(observed);

  if (
    current &&
    observed.loginState === 'logged_out' &&
    !observed.platformAccountId &&
    !observed.accountHandle &&
    !observed.displayName
  ) {
    await updateAccountObservation(
      tx,
      agent,
      current.social_account_id,
      observed,
    );
    await tx.execute(`
      UPDATE social_account_bindings
      SET last_login_state = 'logged_out',
        last_seen_at = $1::timestamptz,
        updated_at = now()
      WHERE id = $2 AND tenant_id = $3
    `, [observed.observedAt, current.binding_id, agent.tenant_id]);
    return {id: current.social_account_id, observed};
  }

  const sameCurrentIdentity = Boolean(
    current &&
    (
      socialAccountIdentityMatchesAccount(observed, current) ||
      (
        !observed.platformAccountId &&
        !observed.accountHandle &&
        (
          current.identity_source === 'placeholder' ||
          (
            !observed.displayName &&
            observed.loginState === 'unknown'
          )
        )
      )
    )
  );

  if (!hasDurableIdentity) {
    if (!current) return null;
    const manualCurrent =
      current.binding_source === 'manual' ||
      current.agent_binding_mode === 'manual';
    if (!manualCurrent) return null;
    await updateAccountObservation(
      tx,
      agent,
      current.social_account_id,
      {...observed, displayName: ''},
    );
    await tx.execute(`
      UPDATE social_account_bindings
      SET last_login_state = $1,
        last_seen_at = $2::timestamptz,
        updated_at = now()
      WHERE id = $3 AND tenant_id = $4
    `, [
      observed.loginState,
      observed.observedAt,
      current.binding_id,
      agent.tenant_id,
    ]);
    return {id: current.social_account_id, observed};
  }

  if (sameCurrentIdentity) {
    await updateAccountObservation(
      tx,
      agent,
      current.social_account_id,
      observed,
    );
    await bindAccount(
      tx,
      agent,
      current.social_account_id,
      observed,
      current.binding_source || 'extension',
    );
    return {id: current.social_account_id, observed};
  }

  if (
    current?.binding_source === 'manual' ||
    current?.agent_binding_mode === 'manual'
  ) {
    await tx.execute(`
      UPDATE social_account_bindings
      SET metadata = metadata || $1::jsonb,
        updated_at = now()
      WHERE id = $2 AND tenant_id = $3
    `, [
      JSON.stringify({
        identityConflict: true,
        conflictObservedAt: observed.observedAt,
      }),
      current.binding_id,
      agent.tenant_id,
    ]);
    return null;
  }

  if (!isTrustedSocialAccountObservation(observed)) {
    return null;
  }

  let account = await findObservedAccount(tx, agent, observed);
  if (
    !account &&
    current?.identity_source === 'placeholder' &&
    (observed.platformAccountId ||
      observed.accountHandle ||
      observed.displayName)
  ) {
    account = {
      id: current.social_account_id,
      identity_source: current.identity_source,
    };
  }
  if (!account) {
    account = await createObservedAccount(
      tx,
      agent,
      observed,
      observed.platformAccountId ||
        observed.accountHandle ||
        observed.displayName
        ? 'extension'
        : 'placeholder',
    );
  }
  if (account?.agent_binding_mode === 'manual') {
    return null;
  }
  await updateAccountObservation(tx, agent, account.id, observed);
  await bindAccount(
    tx,
    agent,
    account.id,
    observed,
    account.identity_source === 'placeholder'
      ? 'placeholder'
      : 'extension',
  );
  return {id: account.id, observed};
}

async function resolveSocialAccountForUsageEvent(tx, agent, event) {
  const observed = event.accountIdentity;
  if (
    !observed ||
    (
      !observed.platformAccountId &&
      !observed.accountHandle
    )
  ) {
    return await ensureCurrentSocialAccount(
      tx,
      agent,
      event.platform,
      null,
    );
  }

  const current = await currentBinding(tx, agent, event.platform);
  const currentMatches = Boolean(
    current &&
    socialAccountIdentityMatchesAccount(observed, current)
  );
  if (currentMatches) {
    await updateAccountObservation(
      tx,
      agent,
      current.social_account_id,
      observed,
    );
    return {id: current.social_account_id, observed};
  }
  if (
    current?.binding_source === 'manual' ||
    current?.agent_binding_mode === 'manual'
  ) {
    return {id: current.social_account_id, observed};
  }
  if (!isTrustedSocialAccountObservation(observed)) {
    return null;
  }

  let account = await findObservedAccount(tx, agent, observed);
  if (!account) {
    account = await createObservedAccount(
      tx,
      agent,
      observed,
      'extension',
    );
  }
  if (account?.agent_binding_mode === 'manual') {
    return null;
  }
  await updateAccountObservation(tx, agent, account.id, observed);
  return {id: account.id, observed};
}

export async function recordObservedSocialAgentAvailability(
  tx,
  {agent, account = null, observed = null} = {},
) {
  const normalized = normalizeObservedSocialAccount(observed);
  if (
    !agent?.id ||
    !agent?.tenant_id ||
    !account?.id ||
    !normalized ||
    normalized.loginState !== 'authenticated' ||
    !isTrustedSocialAccountObservation(normalized)
  ) {
    return false;
  }
  await tx.execute(`
    INSERT INTO social_agent_daily_usage (
      tenant_id, agent_id, platform, usage_date,
      searches, enhancements, capture_runs, captured_items,
      failed_events, safety_verifications, last_event_at, last_safety_at
    ) VALUES (
      $1, $2, $3, $4::date,
      0, 0, 0, 0,
      0, 0, $5::timestamptz, NULL
    )
    ON CONFLICT (tenant_id, agent_id, platform, usage_date)
    DO UPDATE SET
      last_event_at = GREATEST(
        social_agent_daily_usage.last_event_at,
        EXCLUDED.last_event_at
      ),
      updated_at = now()
  `, [
    agent.tenant_id,
    agent.id,
    normalized.platform,
    shanghaiDate(normalized.observedAt),
    normalized.observedAt,
  ]);
  return true;
}

export async function processSocialAccountHeartbeat(
  tx,
  {
    agent,
    observedAccounts = [],
    usageEvents = [],
  },
) {
  const observedByPlatform = new Map();
  for (const item of Array.isArray(observedAccounts)
    ? observedAccounts.slice(0, 10)
    : []) {
    const observed = normalizeObservedSocialAccount(item);
    if (!observed) continue;
    observedByPlatform.set(observed.platform, observed);
    const account = await ensureCurrentSocialAccount(
      tx,
      agent,
      observed.platform,
      observed,
    );
    await recordObservedSocialAgentAvailability(tx, {
      agent,
      account,
      observed,
    });
  }

  const acceptedUsageEventIds = [];
  const normalizedEvents = normalizeSocialUsageEvents(usageEvents);
  for (const event of normalizedEvents) {
    const account = event.accountIdentity
      ? await resolveSocialAccountForUsageEvent(tx, agent, event)
      : await ensureCurrentSocialAccount(
          tx,
          agent,
          event.platform,
          observedByPlatform.get(event.platform),
        );
    const inserted = await tx.queryOne(`
      INSERT INTO social_account_usage_events (
        tenant_id, event_id, social_account_id, agent_id, platform,
        searches, enhancements, capture_runs, captured_items,
        succeeded, safety_verification, occurred_at, usage_date, metadata
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12::timestamptz, $13::date, $14::jsonb
      )
      ON CONFLICT (tenant_id, event_id) DO NOTHING
      RETURNING id
    `, [
      agent.tenant_id,
      event.eventId,
      account?.id || null,
      agent.id,
      event.platform,
      event.searches,
      event.enhancements,
      event.captureRuns,
      event.capturedItems,
      event.succeeded,
      event.safetyVerification,
      event.occurredAt,
      event.usageDate,
      JSON.stringify(event.metadata),
    ]);
    acceptedUsageEventIds.push(event.eventId);
    if (!inserted) continue;
    await tx.execute(`
      INSERT INTO social_agent_daily_usage (
        tenant_id, agent_id, platform, usage_date,
        searches, enhancements, capture_runs, captured_items,
        failed_events, safety_verifications, last_event_at, last_safety_at
      ) VALUES (
        $1, $2, $3, $4::date,
        $5, $6, $7, $8,
        $9, $10, $11::timestamptz,
        CASE WHEN $10::integer > 0 THEN $11::timestamptz ELSE NULL END
      )
      ON CONFLICT (tenant_id, agent_id, platform, usage_date)
      DO UPDATE SET
        searches = social_agent_daily_usage.searches + EXCLUDED.searches,
        enhancements = social_agent_daily_usage.enhancements + EXCLUDED.enhancements,
        capture_runs = social_agent_daily_usage.capture_runs + EXCLUDED.capture_runs,
        captured_items = social_agent_daily_usage.captured_items + EXCLUDED.captured_items,
        failed_events = social_agent_daily_usage.failed_events + EXCLUDED.failed_events,
        safety_verifications = social_agent_daily_usage.safety_verifications + EXCLUDED.safety_verifications,
        last_event_at = GREATEST(social_agent_daily_usage.last_event_at, EXCLUDED.last_event_at),
        last_safety_at = CASE
          WHEN EXCLUDED.last_safety_at IS NULL THEN social_agent_daily_usage.last_safety_at
          ELSE GREATEST(social_agent_daily_usage.last_safety_at, EXCLUDED.last_safety_at)
        END,
        updated_at = now()
    `, [
      agent.tenant_id,
      agent.id,
      event.platform,
      event.usageDate,
      event.searches,
      event.enhancements,
      event.captureRuns,
      event.capturedItems,
      event.succeeded ? 0 : 1,
      event.safetyVerification ? 1 : 0,
      event.occurredAt,
    ]);
    if (!account) continue;
    await tx.execute(`
      INSERT INTO social_account_daily_usage (
        tenant_id, social_account_id, agent_id, platform, usage_date,
        searches, enhancements, capture_runs, captured_items,
        failed_events, last_event_at
      ) VALUES (
        $1, $2, $3, $4, $5::date,
        $6, $7, $8, $9,
        $10, $11::timestamptz
      )
      ON CONFLICT (
        tenant_id, social_account_id, agent_id, usage_date
      ) DO UPDATE SET
        searches = social_account_daily_usage.searches + EXCLUDED.searches,
        enhancements =
          social_account_daily_usage.enhancements + EXCLUDED.enhancements,
        capture_runs =
          social_account_daily_usage.capture_runs + EXCLUDED.capture_runs,
        captured_items =
          social_account_daily_usage.captured_items + EXCLUDED.captured_items,
        failed_events =
          social_account_daily_usage.failed_events + EXCLUDED.failed_events,
        last_event_at = GREATEST(
          social_account_daily_usage.last_event_at,
          EXCLUDED.last_event_at
        ),
        updated_at = now()
    `, [
      agent.tenant_id,
      account.id,
      agent.id,
      event.platform,
      event.usageDate,
      event.searches,
      event.enhancements,
      event.captureRuns,
      event.capturedItems,
      event.succeeded ? 0 : 1,
      event.occurredAt,
    ]);
  }

  return {
    observedAccountCount: observedByPlatform.size,
    acceptedUsageEventIds,
  };
}
