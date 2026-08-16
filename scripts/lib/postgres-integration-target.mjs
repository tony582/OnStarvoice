export function validatePostgresIntegrationTarget({
  testDatabaseUrl,
  databaseUrl,
  requireDatabaseUrl = false,
}) {
  const rawUrl = String(testDatabaseUrl || '').trim();
  const rawDatabaseUrl = String(databaseUrl || '').trim();
  if (!rawUrl) {
    throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  const allowedHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  const allowedName = /^onstarvoice_(?:ci|test)(?:_|$)/u.test(databaseName);

  if (parsed.search) {
    throw new Error(
      'Refusing integration tests: TEST_DATABASE_URL query parameters are not allowed.',
    );
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !allowedHost || !allowedName) {
    throw new Error(
      'Refusing integration tests: use a localhost database named onstarvoice_ci* or onstarvoice_test*.',
    );
  }

  if ((requireDatabaseUrl || rawDatabaseUrl) && rawDatabaseUrl !== rawUrl) {
    throw new Error(
      'DATABASE_URL conflicts with TEST_DATABASE_URL; refusing an ambiguous database target.',
    );
  }

  return { databaseName, databaseUrl: parsed, rawUrl };
}

const LOOPBACK_SERVER_ADDRESSES = new Set([
  null,
  undefined,
  '127.0.0.1',
  '127.0.0.1/32',
  '::1',
  '::1/128',
]);

function isRfc1918Ipv4(serverAddress) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/32)?$/u.exec(
    String(serverAddress || ''),
  );
  if (!match) return false;

  const octets = match.slice(1).map(Number);
  if (octets.some(octet => octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

export function isAllowedPostgresIntegrationServerAddress({
  serverAddress,
  target,
  environment = process.env,
}) {
  if (LOOPBACK_SERVER_ADDRESSES.has(serverAddress)) return true;

  const databaseUrl = target?.databaseUrl;
  const githubHostedDockerTarget =
    environment?.GITHUB_ACTIONS === 'true' &&
    environment?.CI === 'true' &&
    environment?.RUNNER_ENVIRONMENT === 'github-hosted' &&
    environment?.RUNNER_OS === 'Linux' &&
    target?.databaseName === 'onstarvoice_ci' &&
    databaseUrl instanceof URL &&
    ['postgres:', 'postgresql:'].includes(databaseUrl.protocol) &&
    databaseUrl.hostname === '127.0.0.1' &&
    databaseUrl.port === '5432' &&
    decodeURIComponent(databaseUrl.pathname.replace(/^\//u, '')) === 'onstarvoice_ci';

  return githubHostedDockerTarget && isRfc1918Ipv4(serverAddress);
}
