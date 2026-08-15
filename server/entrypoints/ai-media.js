/** P2-C local split-topology AI/Media candidate. */

import 'dotenv/config';

import { runProcessEntrypoint } from '../runtime/process-entrypoint.js';

await runProcessEntrypoint({
  expectedRole: 'ai-media',
  entrypoint: 'server/entrypoints/ai-media.js',
});
