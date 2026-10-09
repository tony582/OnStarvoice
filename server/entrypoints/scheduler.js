/** Independent scheduler process (PROCESS_ROLE=scheduler): cron + ops-control wakeups; holds the scheduler role lock. */

import 'dotenv/config';

import { runProcessEntrypoint } from '../runtime/process-entrypoint.js';

await runProcessEntrypoint({
  expectedRole: 'scheduler',
  entrypoint: 'server/entrypoints/scheduler.js',
});
