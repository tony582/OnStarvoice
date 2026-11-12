import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {ACTIVE_QUEUE_CONDITION} from '../server/routes/triage.js';
import {TRIAGE_SUGGESTION_ACTIVE_SQL} from '../server/services/triage-suggestions.js';
const source=readFileSync(new URL('../server/routes/triage.js',import.meta.url),'utf8');
test('content triage and suggestions exclude profile-only and official-account records',()=>{
  assert.equal(ACTIVE_QUEUE_CONDITION,TRIAGE_SUGGESTION_ACTIVE_SQL);
  assert.match(ACTIVE_QUEUE_CONDITION,/r\.record_type NOT IN \('official_content', 'blogger_profile'\)/);
  const content=source.slice(source.indexOf('const TRIAGE_CONTENT_CONDITION'),source.indexOf('const TRIAGE_QUEUE_CONDITION'));
  assert.match(content,/r\.record_type NOT IN \('official_content', 'blogger_profile'\)/);
});
