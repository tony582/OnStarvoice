/** Independent AI/media process (PROCESS_ROLE=ai-media): labeling, reports, comment AI, media backfill; holds the ai-media role lock. */

import 'dotenv/config';

import { runProcessEntrypoint } from '../runtime/process-entrypoint.js';

await runProcessEntrypoint({
  expectedRole: 'ai-media',
  entrypoint: 'server/entrypoints/ai-media.js',
});
