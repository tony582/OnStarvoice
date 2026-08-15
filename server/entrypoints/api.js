/** P2-C local split-topology API candidate. */

import 'dotenv/config';

import { runProcessEntrypoint } from '../runtime/process-entrypoint.js';

await runProcessEntrypoint({
  expectedRole: 'api',
  entrypoint: 'server/entrypoints/api.js',
});
