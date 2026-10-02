import { randomUUID } from 'node:crypto';
import { canonicalJson, payloadHash, transaction } from './codec.mjs';

export function recordEvent(db, payload) {
  if (!payload?.eventId || typeof payload.eventId !== 'string') throw new TypeError('eventId required');
  const hash = payloadHash(payload);
  return transaction(db, () => {
    const previous = db.prepare('SELECT * FROM events WHERE event_id = ?').get(payload.eventId);
    if (previous) {
      if (previous.payload_hash !== hash) {
        throw Object.assign(new Error('Event payload conflicts with durable original'), { code: 'event_payload_conflict' });
      }
      return { eventId: payload.eventId, duplicate: true };
    }
    db.prepare('INSERT INTO events (event_id, payload, payload_hash, state) VALUES (?, ?, ?, ?)')
      .run(payload.eventId, canonicalJson(payload), hash, 'pending');
    return { eventId: payload.eventId, duplicate: false };
  });
}

function readBatch(db, batchId) {
  const rows = db.prepare('SELECT e.payload FROM batch_events b JOIN events e ON e.event_id = b.event_id WHERE b.batch_id = ? ORDER BY b.position').all(batchId);
  return { uploadBatchId: batchId, events: rows.map((row) => JSON.parse(row.payload)) };
}

export function nextBatch(db, { limit = 5 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new RangeError('Batch limit must be 1..5');
  return transaction(db, () => {
    const previous = db.prepare("SELECT id FROM batches WHERE state = 'open' ORDER BY rowid LIMIT 1").get();
    if (previous) return readBatch(db, previous.id);
    const rows = db.prepare("SELECT event_id FROM events WHERE state = 'pending' ORDER BY rowid LIMIT ?").all(limit);
    if (!rows.length) return null;
    const id = randomUUID();
    db.prepare('INSERT INTO batches (id, state) VALUES (?, ?)').run(id, 'open');
    for (const [position, row] of rows.entries()) {
      db.prepare('INSERT INTO batch_events VALUES (?, ?, ?)').run(id, row.event_id, position);
      db.prepare("UPDATE events SET state = 'batched' WHERE event_id = ?").run(row.event_id);
    }
    return readBatch(db, id);
  });
}

const WAITING = "SELECT e.event_id FROM events e JOIN batch_events b ON e.event_id = b.event_id WHERE b.batch_id = ? AND e.state = 'batched'";

/** Events of this batch that still wait for a receipt. */
export function unackedInBatch(db, batchId) {
  return db.prepare(WAITING).all(batchId).length;
}

// A refused batch is taken apart so its events can be offered one at a time. Only events
// without a receipt go back to pending (oldest first again); acknowledged ones keep their batch.
export function dissolveBatch(db, batchId) {
  return transaction(db, () => {
    const rows = db.prepare(WAITING).all(batchId);
    for (const row of rows) {
      db.prepare('DELETE FROM batch_events WHERE batch_id = ? AND event_id = ?').run(batchId, row.event_id);
      db.prepare("UPDATE events SET state = 'pending' WHERE event_id = ?").run(row.event_id);
    }
    db.prepare("UPDATE batches SET state = 'closed' WHERE id = ?").run(batchId);
    return { released: rows.length };
  });
}

// The server refused this event on its own. It leaves the queue as 'rejected' with a local
// marker instead of holding up every later event; the payload stays in the store for review.
export function quarantineBatch(db, batchId, marker = {}) {
  return transaction(db, () => {
    const rows = db.prepare(WAITING).all(batchId);
    for (const row of rows) {
      db.prepare("UPDATE events SET state = 'rejected', receipt = ? WHERE event_id = ?")
        .run(canonicalJson({ ...marker, eventId: row.event_id, status: 'rejected', quarantinedBy: 'runner' }), row.event_id);
    }
    db.prepare("UPDATE batches SET state = 'closed' WHERE id = ?").run(batchId);
    return { quarantined: rows.length };
  });
}

export function ackBatch(db, batchId, receipts) {
  if (!Array.isArray(receipts)) throw new TypeError('Receipts must be an array');
  return transaction(db, () => {
    if (!db.prepare('SELECT id FROM batches WHERE id = ?').get(batchId)) throw new Error('Unknown batch');
    const members = new Set(db.prepare('SELECT event_id FROM batch_events WHERE batch_id = ?').all(batchId).map((r) => r.event_id));
    const seen = new Set();
    for (const receipt of receipts) {
      if (!members.has(receipt.eventId) || seen.has(receipt.eventId)) throw new Error('Invalid receipt membership');
      seen.add(receipt.eventId);
      if (!['accepted', 'duplicate', 'rejected'].includes(receipt.status)) throw new Error('Invalid receipt status');
      if (receipt.status !== 'rejected' && !receipt.receiptId) throw new Error('Durable receiptId required');
      const previous = db.prepare('SELECT state FROM events WHERE event_id = ?').get(receipt.eventId);
      if (previous.state === 'acked' || previous.state === 'rejected') continue;
      db.prepare('UPDATE events SET state = ?, receipt = ? WHERE event_id = ?')
        .run(receipt.status === 'rejected' ? 'rejected' : 'acked', canonicalJson(receipt), receipt.eventId);
    }
    const left = db.prepare("SELECT COUNT(*) AS count FROM events e JOIN batch_events b ON e.event_id = b.event_id WHERE b.batch_id = ? AND e.state = 'batched'").get(batchId).count;
    if (!left) db.prepare("UPDATE batches SET state = 'closed' WHERE id = ?").run(batchId);
    return { complete: left === 0, pendingReceipts: left };
  });
}
