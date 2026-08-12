import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminDirectory = path.join(repositoryRoot, 'web', 'admin');
const eslintCli = path.join(adminDirectory, 'node_modules', 'eslint', 'bin', 'eslint.js');
const baselinePath = path.join(repositoryRoot, 'scripts', 'admin-lint-baseline.json');

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch (error) {
  console.error(`Admin lint baseline could not be read: ${error.message}`);
  process.exit(2);
}

if (
  !baseline?.maximumTotals
  || !Number.isInteger(baseline.maximumTotals.errors)
  || !Number.isInteger(baseline.maximumTotals.warnings)
  || !baseline.files
  || typeof baseline.files !== 'object'
) {
  console.error('Admin lint baseline has an invalid shape.');
  process.exit(2);
}

const baselineTotals = { errors: 0, warnings: 0 };
for (const [file, ceiling] of Object.entries(baseline.files)) {
  if (
    !file
    || path.isAbsolute(file)
    || file.split('/').includes('..')
    || !Number.isInteger(ceiling?.errors)
    || !Number.isInteger(ceiling?.warnings)
    || ceiling.errors < 0
    || ceiling.warnings < 0
  ) {
    console.error(`Admin lint baseline has an invalid file ceiling: ${file || '<empty>'}.`);
    process.exit(2);
  }
  baselineTotals.errors += ceiling.errors;
  baselineTotals.warnings += ceiling.warnings;
}

if (
  baselineTotals.errors !== baseline.maximumTotals.errors
  || baselineTotals.warnings !== baseline.maximumTotals.warnings
) {
  console.error('Admin lint baseline file ceilings do not match maximumTotals.');
  process.exit(2);
}

const result = spawnSync(process.execPath, [eslintCli, '.', '--format', 'json'], {
  cwd: adminDirectory,
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});

if (result.error) {
  console.error(`Admin lint baseline check could not start: ${result.error.message}`);
  process.exit(2);
}

if (!result.stdout.trim()) {
  console.error('Admin lint baseline check produced no ESLint report.');
  if (result.stderr) console.error(result.stderr.trim());
  process.exit(2);
}

let report;
try {
  report = JSON.parse(result.stdout || '[]');
} catch {
  console.error('Admin lint baseline check could not parse ESLint output.');
  if (result.stderr) console.error(result.stderr.trim());
  process.exit(2);
}

if (!Array.isArray(report) || result.status === null || result.status > 1) {
  console.error('Admin lint baseline check failed before comparison.');
  if (result.stderr) console.error(result.stderr.trim());
  process.exit(2);
}

const actual = report.reduce(
  (totals, file) => ({
    errors: totals.errors + Number(file.errorCount || 0),
    warnings: totals.warnings + Number(file.warningCount || 0),
  }),
  { errors: 0, warnings: 0 },
);

const actualByFile = new Map(
  report
    .filter(file => Number(file.errorCount || 0) > 0 || Number(file.warningCount || 0) > 0)
    .map(file => [
      path.relative(adminDirectory, file.filePath).split(path.sep).join('/'),
      {
        errors: Number(file.errorCount || 0),
        warnings: Number(file.warningCount || 0),
      },
    ]),
);

const regressions = [];
const files = new Set([...Object.keys(baseline.files), ...actualByFile.keys()]);
for (const file of [...files].sort()) {
  const allowed = baseline.files[file] || { errors: 0, warnings: 0 };
  const current = actualByFile.get(file) || { errors: 0, warnings: 0 };
  if (current.errors > allowed.errors || current.warnings > allowed.warnings) {
    regressions.push({ file, current, allowed });
  }
}

console.log(
  `Admin lint baseline: ${actual.errors} errors, ${actual.warnings} warnings `
  + `(allowed: <= ${baseline.maximumTotals.errors} errors, `
  + `<= ${baseline.maximumTotals.warnings} warnings; per-file ceilings enforced)`,
);

if (
  actual.errors > baseline.maximumTotals.errors
  || actual.warnings > baseline.maximumTotals.warnings
  || regressions.length > 0
) {
  console.error('Admin lint debt increased. Fix the new findings before proceeding.');
  for (const regression of regressions) {
    console.error(
      `- ${regression.file}: ${regression.current.errors}/${regression.current.warnings} `
      + `errors/warnings; allowed ${regression.allowed.errors}/${regression.allowed.warnings}`,
    );
  }
  process.exit(1);
}
