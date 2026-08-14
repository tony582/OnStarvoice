import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('tickets with a linked content record reuse the live patrol timeline without replacing existing tabs', () => {
  const recordDrawer = source('web/admin/src/components/shared/RecordDrawer.tsx');
  const ticketDrawer = source('web/admin/src/components/shared/TicketDrawer.tsx');

  assert.match(recordDrawer, /export function RecordPatrolPanel/);
  assert.match(recordDrawer, /content-patrol\/posts\/\$\{record\.id\}\/timeline/);
  assert.match(recordDrawer, /汇总负面巡查与关注内容巡查/);
  assert.match(recordDrawer, /run\.workflowLabel/);
  assert.match(recordDrawer, /runs\.length === 0/);
  assert.match(recordDrawer, /record\.sentiment !== 'negative'/);

  assert.match(ticketDrawer, /import \{ RecordPatrolPanel \} from '@\/components\/shared\/RecordDrawer'/);
  assert.doesNotMatch(ticketDrawer, /rec\?\.sentiment === 'negative'/);
  assert.match(ticketDrawer, /\.\.\.\(rec\s*\?/);
  assert.match(ticketDrawer, /id: 'patrol' as const, label: '舆情巡查', icon: Radar/);
  assert.match(ticketDrawer, /tab === 'patrol' && rec/);
  assert.match(ticketDrawer, /<RecordPatrolPanel key=\{String\(rec\.id\)\} record=\{rec\} \/>/);

  assert.match(ticketDrawer, /id: 'snapshot' as const, label: '采集'/);
  assert.match(ticketDrawer, /id: 'history' as const, label: `处理记录/);
});

test('comment tickets persist and retain the original content record association', () => {
  const ticketsRoute = source('server/routes/tickets.js');
  const migration = source('server/db/migrations/050_ticket_comment_record_link.sql');

  assert.match(ticketsRoute, /record_id AS source_record_id/);
  assert.match(ticketsRoute, /sourceType === 'content' \? sourceId : \(snap\.source_record_id \|\| null\)/);
  assert.match(ticketsRoute, /recordId = comment\?\.record_id \|\| recordId \|\| null/);

  assert.match(migration, /UPDATE tickets t/);
  assert.match(migration, /SET source_record_id = cl\.record_id/);
  assert.match(migration, /t\.source_comment_id = cl\.id/);
  assert.match(migration, /t\.tenant_id = cl\.tenant_id/);
});
