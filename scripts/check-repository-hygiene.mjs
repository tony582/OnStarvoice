import { spawnSync } from 'node:child_process';

const listing = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
);

if (listing.error || listing.status !== 0) {
  console.error('Could not list repository files for hygiene checks.');
  if (listing.error) console.error(listing.error.message);
  if (listing.stderr) console.error(listing.stderr.trim());
  process.exit(2);
}

const files = listing.stdout.split('\0').filter(Boolean);
const forbidden = [];

for (const file of files) {
  const segments = file.split('/');
  const basename = segments.at(-1) || '';

  if (basename === '.DS_Store') {
    forbidden.push([file, 'macOS metadata']);
    continue;
  }

  if (/\.(?:pem|crx|zip)$/iu.test(basename)) {
    forbidden.push([file, 'key or packaged artifact']);
    continue;
  }

  if (basename.endsWith('.tsbuildinfo')) {
    forbidden.push([file, 'TypeScript build cache']);
    continue;
  }

  if (
    (basename === '.env' || basename.startsWith('.env.') || basename.includes('.env.'))
    && !basename.endsWith('.example')
  ) {
    forbidden.push([file, 'environment file without .example suffix']);
    continue;
  }

  const generatedSegments = new Set([
    'dist',
    'extension-build',
    'node_modules',
    'output',
    'release',
  ]);
  const generated = segments.find(segment => generatedSegments.has(segment));
  if (generated) forbidden.push([file, `generated ${generated}/ content`]);
}

if (forbidden.length > 0) {
  console.error('Repository hygiene check found files that must not be committed:');
  for (const [file, reason] of forbidden) console.error(`- ${file}: ${reason}`);
  process.exit(1);
}

console.log(`Repository hygiene check passed (${files.length} source files inspected).`);
