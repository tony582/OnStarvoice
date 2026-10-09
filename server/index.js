/**
 * StarVoice compatibility process (PROCESS_ROLE=all).
 *
 * Runs HTTP, scheduler and AI/media work in one process and still owns
 * migrations + bootstrap at startup. Production runs the split topology
 * (entrypoints/api.js, scheduler.js, ai-media.js) since 2026-10-09; this
 * entrypoint is the rollback target (deploy/process-topology.compatibility.json)
 * and the default for local development.
 */

import 'dotenv/config';

import { runProcessEntrypoint } from './runtime/process-entrypoint.js';

await runProcessEntrypoint({
  expectedRole: 'all',
  entrypoint: 'server/index.js',
});
