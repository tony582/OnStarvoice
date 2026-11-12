import 'dotenv/config';
import {pathToFileURL} from 'node:url';
import {backfillTriageSuggestions} from '../services/triage-suggestions.js';
import {closePool} from '../db/pool.js';

export function parseTriageSuggestionBackfillArgs(args) {
  let tenantId = '', apply = false, sampleLimit = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--tenant') tenantId = args[++i] || '';
    else if (args[i] === '--samples') sampleLimit = Number(args[++i]);
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(tenantId)
    || !Number.isSafeInteger(sampleLimit) || sampleLimit < 0 || sampleLimit > 100)
    throw new Error('Usage: node server/scripts/triage-suggestions-backfill.js --tenant UUID [--samples 20] [--apply]');
  return {tenantId, apply, sampleLimit};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await backfillTriageSuggestions(parseTriageSuggestionBackfillArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await closePool(); }
}
