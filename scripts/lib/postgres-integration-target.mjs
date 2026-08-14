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
