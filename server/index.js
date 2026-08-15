/**
 * StarVoice compatibility process.
 *
 * Production remains on this single `all` entrypoint. The dedicated P2-C
 * entrypoints are local split-topology candidates and are not yet authorized
 * for production deployment.
 */

import 'dotenv/config';

import { runProcessEntrypoint } from './runtime/process-entrypoint.js';

await runProcessEntrypoint({
  expectedRole: 'all',
  entrypoint: 'server/index.js',
});
