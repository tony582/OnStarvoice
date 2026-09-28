const ms = value => value == null || value === '' ? NaN : new Date(value).getTime();
const object = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
};
const status = record => record?.status || record?.triage_status || 'unhandled';
export function isEffectiveDailyHandling(record, target) {
  return !!record && status(record) === target
    && (target === 'replied' || record.sentiment === 'negative');
}
function link(record) {
  for (const value of [record.url, record.canonical_url]) {
    try { const url = new URL(value); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* Missing link is surfaced by report warnings. */ }
  }
  return '';
}

// Lists and corrected summary columns use the same current-state eligibility.
// Only true transitions enter a list; a same-status save or a new note cannot
// create another handled post. Notes belong to the latest handling episode.
export function buildCustomerDailyHandlingLists(records, transitions, events, notes, period) {
  const byId = new Map(records.map(record => [String(record.id).toLowerCase(), record]));
  const eventsById = new Map(events.map(event => [event.id, event]));
  const start = ms(period.handlingStartAt || period.periodStart), cutoff = ms(period.cutoffAt);
  const latest = new Map();
  const ordered = [...transitions].sort((a, b) => ms(a.handledAt) - ms(b.handledAt) || String(a.eventId).localeCompare(String(b.eventId)));
  for (const transition of ordered) {
    if (ms(transition.handledAt) >= cutoff) continue;
    const date = new Date(ms(transition.handledAt) + 8 * 3600000).toISOString().slice(0, 10);
    latest.set(`${date}:${transition.recordId}`, transition);
  }
  const output = {coldMarked: [], repliedMarked: [], commentMarked: []};
  const fields = {negative_cold: 'coldMarked', replied: 'repliedMarked', negative_comment: 'commentMarked'};
  for (const transition of latest.values()) {
    const row = byId.get(transition.recordId), field = fields[transition.nextStatus];
    if (!field || ms(transition.handledAt) < start || !isEffectiveDailyHandling(row, transition.nextStatus)) continue;
    const base = eventsById.get(transition.eventId);
    const replyContent = String(object(base?.metadata).note || '');
    const index = ordered.indexOf(transition);
    const departure = ordered.slice(index + 1).find(item => item.recordId === transition.recordId && item.nextStatus !== transition.nextStatus);
    const episodeEnd = Math.min(cutoff, departure ? ms(departure.handledAt) : cutoff);
    const supplementalNotes = notes.filter(note => String(note.record_id).toLowerCase() === transition.recordId)
      .map(note => ({id: `note:${note.id}`, body: String(note.body || ''), createdAt: note.created_at}));
    for (const event of events) {
      if (event.id === transition.eventId) continue;
      const meta = object(event.metadata);
      const targets = event.action === 'record.triage_batch_updated' ? meta.recordIds : [event.target_id];
      if (!Array.isArray(targets) || !targets.some(id => String(id).toLowerCase() === transition.recordId)) continue;
      const noteStatus = meta.nextStatus || meta.status;
      if ((!noteStatus || noteStatus === transition.nextStatus) && String(meta.note || '').trim()) supplementalNotes.push({id: `status:${event.id}`, body: String(meta.note), createdAt: event.created_at});
    }
    const currentNotes = [...new Map(supplementalNotes.filter(note => note.body.trim()
      && ms(note.createdAt) >= ms(transition.handledAt) && ms(note.createdAt) < episodeEnd).map(note => [note.id, note])).values()]
      .sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.id.localeCompare(b.id));
    output[field].push({recordId: row.id, title: String(row.title || '未命名帖子'), platform: row.platform || 'unknown',
      url: link(row), status: status(row), markedAt: transition.handledAt, eventId: transition.eventId,
      replyContent, supplementalNotes: currentNotes,
      ...(Number.isFinite(ms(row.first_seen_at)) ? {isHistorical: ms(row.first_seen_at) < ms(period.collectionStartAt || period.periodStart)} : {})});
  }
  for (const posts of Object.values(output)) posts.sort((a, b) => ms(a.markedAt) - ms(b.markedAt) || a.recordId.localeCompare(b.recordId));
  return output;
}
