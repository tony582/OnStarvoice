/** P2-C local split-topology Scheduler candidate. */

import 'dotenv/config';

import { runProcessEntrypoint } from '../runtime/process-entrypoint.js';

await runProcessEntrypoint({
  expectedRole: 'scheduler',
  entrypoint: 'server/entrypoints/scheduler.js',
});
