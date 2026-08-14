import { validatePostgresIntegrationTarget } from '../../scripts/lib/postgres-integration-target.mjs';

function writeEvent(payload) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`, error => error ? reject(error) : resolve());
  });
}

const role = process.argv[2];
const applicationName = process.argv[3];

try {
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const { acquireProcessRoleLocks } = await import(
    '../../server/runtime/process-role-locks.js'
  );

  let lockLostCount = 0;
  const lockHandle = await acquireProcessRoleLocks({
    role,
    databaseUrl: target.rawUrl,
    applicationName,
    logger: { error() {} },
    onLockLost: async details => {
      lockLostCount += 1;
      await writeEvent({
        event: 'lock-lost',
        count: lockLostCount,
        cause: details.event,
        backendPid: details.backendPid,
      });
      setTimeout(() => process.exit(73), 100);
    },
  });

  await writeEvent({
    event: 'acquired',
    processPid: process.pid,
    backendPid: lockHandle.backendPid,
    heldRoles: lockHandle.heldRoles,
  });

  let shutdownPromise;
  const shutdown = () => {
    shutdownPromise ||= (async () => {
      await writeEvent({ event: 'shutdown-started' });
      // Mirror the P2-B compatibility entrypoint: ordinary pools can close,
      // but the dedicated role-lock session stays held until process exit.
      setTimeout(() => process.exit(0), 1000);
    })();
    shutdownPromise.catch(async error => {
      await writeEvent({ event: 'fatal', message: error.message });
      process.exit(1);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  await writeEvent({
    event: 'fatal',
    name: error.name,
    code: error.code || null,
    message: error.message,
  });
  process.exit(1);
}
