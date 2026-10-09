/** Independent API process (PROCESS_ROLE=api): HTTP listener, media dirs and request-side cleanups only. */

import 'dotenv/config';

import { runProcessEntrypoint } from '../runtime/process-entrypoint.js';

await runProcessEntrypoint({
  expectedRole: 'api',
  entrypoint: 'server/entrypoints/api.js',
});
