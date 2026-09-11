import dotenv from 'dotenv';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// No scheduled execution or implicit tenant scan. Preview is the default;
// applying requires an explicit scope and the fingerprint printed by preview.
const args = process.argv.slice(2);
const value = flag => {
  const index = args.indexOf(flag);
  return index < 0 ? '' : args[index + 1] || '';
};
const allowed = new Set(['--tenant', '--parent', '--items', '--apply', '--fingerprint', '--help']);
if (args.some(arg => arg.startsWith('--') && !allowed.has(arg))) throw new Error('Unknown repair option');
if (args.includes('--help')) {
  console.log('Preview: node scripts/repair-incomplete-search-passes.js --tenant UUID --parent UUID [--items UUID,UUID]');
  console.log('Apply reviewed preview: add --apply --fingerprint SHA256. No work is dispatched by this tool.');
} else {
  dotenv.config({path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env')});
  const {repairIncompleteSequentialCompletions} = await import('../routes/capture-cloud.js');
  const {closeDb} = await import('../db/init.js');
  try {
    const result = await repairIncompleteSequentialCompletions({
      tenantId: value('--tenant'),
      parentTaskIds: value('--parent').split(',').filter(Boolean),
      itemIds: value('--items').split(',').filter(Boolean),
      apply: args.includes('--apply'),
      expectedFingerprint: value('--fingerprint'),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeDb();
  }
}
