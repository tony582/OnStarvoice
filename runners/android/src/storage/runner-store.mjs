import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from './codec.mjs';
import { recordEvent, nextBatch, ackBatch } from './outbox.mjs';

export class RunnerStore {
  constructor(path) {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Android Runner requires Node.js >= 24');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
        state TEXT NOT NULL, receipt TEXT
      );
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batch_events (
        batch_id TEXT NOT NULL REFERENCES batches(id),
        event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id), position INTEGER NOT NULL,
        PRIMARY KEY (batch_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        run_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run_item
        ON events (json_extract(payload, '$.discoveryRunId'), json_extract(payload, '$.itemId'));
    `);
  }

  recordEvent(payload) { return recordEvent(this.db, payload); }
  nextBatch(options) { return nextBatch(this.db, options); }
  ackBatch(batchId, receipts) { return ackBatch(this.db, batchId, receipts); }
  getEvent(eventId) {
    const row = this.db.prepare('SELECT payload, state, receipt FROM events WHERE event_id = ?').get(eventId);
    return row ? { payload: JSON.parse(row.payload), state: row.state, receipt: row.receipt ? JSON.parse(row.receipt) : null } : null;
  }
  pendingCount() { return this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE state IN ('pending', 'batched')").get().count; }
  pendingForAttempt(attemptId) {
    return this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE state IN ('pending', 'batched') AND json_extract(payload, '$.attemptId') = ?").get(attemptId).count;
  }
  quarantinedCount() { return this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE state = 'rejected'").get().count; }
  discoveredWorkIds({ discoveryRunId, itemId }) {
    const rows = this.db.prepare(`SELECT DISTINCT CASE WHEN json_extract(payload, '$.verification') = 'ui_bound'
      THEN 'ui:' || json_extract(payload, '$.uiBinding.cardId')
      ELSE json_extract(payload, '$.verifiedExternalId') END AS work_id
      FROM events WHERE json_extract(payload, '$.discoveryRunId') = ? AND json_extract(payload, '$.itemId') = ?
      AND json_extract(payload, '$.verification') IN ('verified','ui_bound')`).all(discoveryRunId, itemId);
    return rows.map((row) => row.work_id).filter((id) => typeof id === 'string' && /^(?:\d{16,22}|ui:[a-f0-9]{64})$/.test(id));
  }
  /** Read-only listing for local diagnostics. */
  listCheckpoints() {
    return this.db.prepare('SELECT run_id, revision, payload FROM checkpoints').all()
      .map((row) => ({ runId: row.run_id, revision: row.revision, value: JSON.parse(row.payload) }));
  }
  /** Keyword per item from locally recorded discoveries (read-only), for runs that predate local notes. */
  recentEventKeywords(sinceMs) {
    return this.db.prepare(`SELECT DISTINCT json_extract(payload, '$.itemId') AS item_id, json_extract(payload, '$.keyword') AS keyword
      FROM events WHERE json_extract(payload, '$.discoveredAt') >= ?`).all(new Date(sinceMs).toISOString())
      .map((row) => ({ itemId: row.item_id, keyword: row.keyword }));
  }
  loadCheckpoint(runId) {
    const row = this.db.prepare('SELECT revision, payload FROM checkpoints WHERE run_id = ?').get(runId);
    return row ? { revision: row.revision, value: JSON.parse(row.payload) } : null;
  }
  saveCheckpoint(runId, value, expectedRevision = 0) {
    const encoded = canonicalJson(value);
    const result = expectedRevision === 0
      ? this.db.prepare('INSERT OR IGNORE INTO checkpoints VALUES (?, 1, ?)').run(runId, encoded)
      : this.db.prepare('UPDATE checkpoints SET revision = revision + 1, payload = ? WHERE run_id = ? AND revision = ?').run(encoded, runId, expectedRevision);
    if (result.changes !== 1) throw Object.assign(new Error('Concurrent checkpoint modification'), { code: 'checkpoint_conflict' });
    return expectedRevision + 1;
  }
  close() { this.db.close(); }
}
