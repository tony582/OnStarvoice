'use strict';

/**
 * PM2 application list derived from the versioned process topology manifest.
 *
 * The manifest (deploy/process-topology.production.json by default) is the
 * single source of truth for which StarVoice processes run in production.
 * Every process gets an explicit PROCESS_ROLE here, so the role never depends
 * on what server/.env happens to contain; dotenv does not override variables
 * that PM2 already set.
 *
 *   pm2 startOrRestart deploy/ecosystem.config.cjs --update-env
 *
 * Rollback to the single compatibility process without editing this file:
 *
 *   PROCESS_TOPOLOGY_MANIFEST=deploy/process-topology.compatibility.json \
 *     pm2 startOrRestart deploy/ecosystem.config.cjs --update-env
 *
 * The two topologies must never run at the same time. deploy/deploy.sh deletes
 * every `onstarvoice*` PM2 process that the active manifest does not list, and
 * the PostgreSQL role locks refuse a second scheduler / ai-media owner anyway.
 */

const path = require('node:path');

const ENTRYPOINTS = Object.freeze({
  all: 'index.js',
  api: 'entrypoints/api.js',
  scheduler: 'entrypoints/scheduler.js',
  'ai-media': 'entrypoints/ai-media.js',
});

// Caps, not reservations. The old single process ran with 400M; the three
// split processes each carry a slice of that work.
const MAX_MEMORY_RESTART = Object.freeze({
  all: '400M',
  api: '400M',
  scheduler: '300M',
  'ai-media': '400M',
});

// Graceful drain budget is PROCESS_SHUTDOWN_TIMEOUT_MS (default 30s) plus the
// 1s forced-exit margin in server/runtime/process-entrypoint.js.
const KILL_TIMEOUT_MS = 35_000;

// server/db/pool.js refuses to start an independent role in production unless
// PG_DATABASE_INSTANCE_COUNT says how many processes share PG_POOL_MAX, and
// server/db/query.js needs at least 3 connections per process to split them
// into critical / general / reporting gates. 30 ÷ 3 = 10 per process, i.e. the
// same per-process budget the single `all` process had with PG_POOL_MAX=10.
// These override whatever server/.env says (dotenv never overrides PM2 env).
// Total PostgreSQL sessions ≈ 30 pool + 2 role-lock + 1 LISTEN.
const SPLIT_DATABASE_ENV = Object.freeze({
  PG_DATABASE_INSTANCE_COUNT: '3',
  PG_POOL_MAX: '30',
});

const manifestPath = process.env.PROCESS_TOPOLOGY_MANIFEST
  ? path.resolve(process.cwd(), process.env.PROCESS_TOPOLOGY_MANIFEST)
  : path.join(__dirname, 'process-topology.production.json');
const manifest = require(manifestPath);

if (!manifest || !Array.isArray(manifest.processes) || manifest.processes.length === 0) {
  throw new Error(`Process topology manifest has no processes: ${manifestPath}`);
}

const serverDir = path.join(__dirname, '..', 'server');

module.exports = {
  apps: manifest.processes.map((processConfig) => {
    const script = ENTRYPOINTS[processConfig.role];
    if (!script) {
      throw new Error(`Unsupported process role in topology manifest: ${processConfig.role}`);
    }
    return {
      name: processConfig.name,
      cwd: serverDir,
      script,
      instances: processConfig.instances,
      exec_mode: 'fork',
      max_memory_restart: MAX_MEMORY_RESTART[processConfig.role],
      kill_timeout: KILL_TIMEOUT_MS,
      // A worker that loses the role-lock race (old owner still draining)
      // exits non-zero; back off instead of hammering PostgreSQL.
      exp_backoff_restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
        PROCESS_ROLE: processConfig.role,
        ...(processConfig.role === 'all' ? {} : SPLIT_DATABASE_ENV),
      },
    };
  }),
};
