import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../server/routes/triage.js', import.meta.url),
  'utf8',
);

test('content triage excludes profile-only and official-account records', () => {
  const scopeMatches = source.match(
    /r\.record_type NOT IN \('official_content', 'blogger_profile'\)/g,
  ) || [];

  assert.equal(
    scopeMatches.length,
    2,
    'active and archived content queues must share the same content-only scope',
  );
});
