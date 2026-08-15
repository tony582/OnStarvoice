import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isProcessRole } from '../server/config/process-role.js';

export const PROCESS_TOPOLOGY_SCHEMA_VERSION = 1;
export const PROCESS_TOPOLOGIES = Object.freeze(['compatibility', 'split']);

const PROCESS_TOPOLOGY_SET = new Set(PROCESS_TOPOLOGIES);
const EXCLUSIVE_EXECUTION_ROLES = new Set(['scheduler', 'ai-media']);
const DEFAULT_MANIFEST_PATH = fileURLToPath(
  new URL('../deploy/process-topology.production.json', import.meta.url),
);

export class ProcessTopologyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProcessTopologyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProcessTopologyError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseProcessTopologyJson(jsonText) {
  try {
    return JSON.parse(jsonText);
  } catch {
    fail('TOPOLOGY_INVALID_JSON', 'Process topology manifest is not valid JSON.');
  }
}

/**
 * Validate and normalize a versioned topology manifest.
 *
 * This pure validation step recognizes split topology so it can be reviewed
 * and tested. Deployability is deliberately enforced by the separate
 * assertProcessTopologyDeployable() boundary below.
 */
export function validateProcessTopology(manifest) {
  if (!isPlainObject(manifest)) {
    fail('TOPOLOGY_INVALID_MANIFEST', 'Process topology manifest must be an object.');
  }
  if (manifest.schemaVersion !== PROCESS_TOPOLOGY_SCHEMA_VERSION) {
    fail(
      'TOPOLOGY_SCHEMA_UNSUPPORTED',
      `Process topology schemaVersion must be ${PROCESS_TOPOLOGY_SCHEMA_VERSION}.`,
    );
  }
  if (!PROCESS_TOPOLOGY_SET.has(manifest.topology)) {
    fail(
      'TOPOLOGY_MODE_UNKNOWN',
      'Process topology must be compatibility or split.',
    );
  }
  if (!Array.isArray(manifest.processes) || manifest.processes.length === 0) {
    fail('TOPOLOGY_PROCESSES_REQUIRED', 'Process topology must declare at least one process.');
  }

  const seenNames = new Set();
  const roleInstanceCounts = new Map();
  const processes = manifest.processes.map((processConfig, index) => {
    if (!isPlainObject(processConfig)) {
      fail('TOPOLOGY_PROCESS_INVALID', `processes[${index}] must be an object.`);
    }

    const name = typeof processConfig.name === 'string' ? processConfig.name.trim() : '';
    if (!name) {
      fail('TOPOLOGY_PROCESS_NAME_REQUIRED', `processes[${index}].name is required.`);
    }
    if (seenNames.has(name)) {
      fail('TOPOLOGY_PROCESS_NAME_DUPLICATE', 'Process names must be unique.');
    }
    seenNames.add(name);

    if (!isProcessRole(processConfig.role)) {
      fail('TOPOLOGY_ROLE_UNKNOWN', `processes[${index}].role is not recognized.`);
    }
    if (!Number.isSafeInteger(processConfig.instances) || processConfig.instances < 1) {
      fail(
        'TOPOLOGY_INSTANCES_INVALID',
        `processes[${index}].instances must be a positive integer.`,
      );
    }

    roleInstanceCounts.set(
      processConfig.role,
      (roleInstanceCounts.get(processConfig.role) || 0) + processConfig.instances,
    );
    return Object.freeze({
      name,
      role: processConfig.role,
      instances: processConfig.instances,
    });
  });

  const allInstances = roleInstanceCounts.get('all') || 0;
  const totalInstances = processes.reduce((sum, processConfig) => (
    sum + processConfig.instances
  ), 0);
  if (allInstances > 1) {
    fail('TOPOLOGY_MULTIPLE_ALL', 'Compatibility topology permits only one all instance.');
  }
  if (allInstances === 1 && totalInstances > 1) {
    fail('TOPOLOGY_MIXED_MODES', 'The all role cannot run alongside any independent role.');
  }

  for (const role of EXCLUSIVE_EXECUTION_ROLES) {
    if ((roleInstanceCounts.get(role) || 0) > 1) {
      fail(
        'TOPOLOGY_DUPLICATE_EXECUTION_AUTHORITY',
        'A production topology cannot assign the same exclusive execution authority more than once.',
      );
    }
  }

  if (manifest.topology === 'compatibility') {
    if (processes.length !== 1 || allInstances !== 1 || totalInstances !== 1) {
      fail(
        'TOPOLOGY_COMPATIBILITY_INVALID',
        'Compatibility topology requires exactly one process with role all and one instance.',
      );
    }
  } else {
    if (allInstances > 0) {
      fail('TOPOLOGY_SPLIT_CONTAINS_ALL', 'Split topology cannot contain the all role.');
    }
    if ((roleInstanceCounts.get('api') || 0) < 1) {
      fail('TOPOLOGY_SPLIT_API_REQUIRED', 'Split topology must include an api process.');
    }
  }

  const roleCounts = Object.freeze(
    Object.fromEntries([...roleInstanceCounts.entries()].sort(([left], [right]) => (
      left.localeCompare(right)
    ))),
  );
  return Object.freeze({
    schemaVersion: PROCESS_TOPOLOGY_SCHEMA_VERSION,
    topology: manifest.topology,
    processes: Object.freeze(processes),
    roleCounts,
    totalInstances,
    deployable: manifest.topology === 'compatibility',
  });
}

export function assertProcessTopologyDeployable(manifest) {
  const topology = validateProcessTopology(manifest);
  if (!topology.deployable) {
    fail(
      'TOPOLOGY_SPLIT_NOT_IMPLEMENTED',
      'Split topology is recognized, but production release remains blocked until P2-C is implemented.',
    );
  }
  return topology;
}

export async function loadProcessTopology(
  manifestPath = DEFAULT_MANIFEST_PATH,
  { requireDeployable = true } = {},
) {
  let contents;
  try {
    contents = await readFile(manifestPath, 'utf8');
  } catch {
    fail('TOPOLOGY_READ_FAILED', 'Unable to read the process topology manifest.');
  }
  const manifest = parseProcessTopologyJson(contents);
  return requireDeployable
    ? assertProcessTopologyDeployable(manifest)
    : validateProcessTopology(manifest);
}

export function formatProcessTopologySummary(topology) {
  const roles = Object.entries(topology.roleCounts)
    .map(([role, count]) => `${role}:${count}`)
    .join(',');
  return `schemaVersion=${topology.schemaVersion} topology=${topology.topology} roles=${roles}`;
}

async function main() {
  const manifestPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : DEFAULT_MANIFEST_PATH;
  try {
    const topology = await loadProcessTopology(manifestPath, { requireDeployable: true });
    console.log(`Process topology preflight passed: ${formatProcessTopologySummary(topology)}`);
  } catch (error) {
    const code = error instanceof ProcessTopologyError ? error.code : 'TOPOLOGY_PREFLIGHT_FAILED';
    const message = error instanceof ProcessTopologyError
      ? error.message
      : 'Process topology preflight failed unexpectedly.';
    console.error(`Process topology preflight failed [${code}]: ${message}`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
