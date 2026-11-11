import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {backfillWindow} from '../services/cross-posts/backfill.js';

// A separate, explicitly mutating entry point; the existing dry-run script remains read-only.
export function parseBackfillArgs(args) {
  const {values} = parseArgs({args, options: {apply: {type: 'boolean'}, days: {type: 'string'},
    tenant: {type: 'string'}, 'as-of': {type: 'string'}, output: {type: 'string'}}});
  if (!values.apply || values.days !== '30') throw new Error('Explicit --apply --days 30 is required');
  if (values.tenant && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(values.tenant)) throw new Error('Invalid --tenant UUID');
  const options = {days: 30, ...(values.tenant ? {tenantId: values.tenant} : {}), ...(values['as-of'] ? {now: values['as-of']} : {})};
  backfillWindow(options);
  return {options, output: values.output};
}

async function main() {
  const {options, output} = parseBackfillArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('Explicit DATABASE_URL is required; no database fallback is allowed');
  const {backfillCrossPosts} = await import('../services/cross-posts/backfill.js');
  const {closePool} = await import('../db/pool.js');
  let report;
  try { report = await backfillCrossPosts(options); }
  catch (error) {
    report = {mode: 'apply', ok: false, error: error.code || error.message,
      failedTenantId: error.failedTenantId || null, completedTenants: error.completedTenants || []};
    process.exitCode = 1;
  } finally {await closePool();}
  const json = JSON.stringify(report, null, 2) + '\n';
  if (output) await writeFile(output, json);
  console.log(json.trimEnd());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {console.error(error.message); process.exitCode = 1;});
