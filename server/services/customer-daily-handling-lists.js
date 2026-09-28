const ms = value => value == null || value === '' ? NaN : new Date(value).getTime();
const object = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
};
const status = record => record?.status || record?.triage_status || 'unhandled';
const REPLY_STATUSES = new Set(['replied', 'negative_comment']);
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

// Reclassifying a reply does not start a new conversation. Any other status
// ends that reply episode, so reopening a post cannot resurrect an old reply.
export function customerDailyHandlingEpisode(transition, transitions, cutoffAt) {
  const related = [...new Map(transitions.filter(item => item.recordId === transition.recordId
    && ms(item.handledAt) < ms(cutoffAt)).map(item => [item.eventId, item])).values()]
    .sort((a, b) => ms(a.handledAt) - ms(b.handledAt) || String(a.eventId).localeCompare(String(b.eventId)));
  const index = related.findIndex(item => item.eventId === transition.eventId);
  const reply = REPLY_STATUSES.has(transition.nextStatus);
  const compatible = value => reply ? REPLY_STATUSES.has(value) : value === transition.nextStatus;
  let first = index;
  while (first > 0 && compatible(related[first].previousStatus)
    && related[first].previousStatus === related[first - 1].nextStatus) first--;
  const departure = related.slice(index + 1).find(item => !compatible(item.nextStatus));
  return {startAt: related[first].handledAt, endAt: departure?.handledAt || cutoffAt,
    transitions: related.slice(first, index + 1),
    needsEarlierContext: reply && compatible(related[first].previousStatus), compatible};
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
    const episode = customerDailyHandlingEpisode(transition, ordered, period.cutoffAt);
    const source = [...episode.transitions].reverse().find(item => String(object(eventsById.get(item.eventId)?.metadata).note || '').trim());
    const replyContent = String(object(eventsById.get(source?.eventId)?.metadata).note || '');
    const transitionIds = new Set(episode.transitions.map(item => item.eventId));
    const supplementalNotes = notes.filter(note => String(note.record_id).toLowerCase() === transition.recordId)
      .map(note => ({id: `note:${note.id}`, body: String(note.body || ''), createdAt: note.created_at}));
    for (const event of events) {
      if (transitionIds.has(event.id)) continue;
      const meta = object(event.metadata);
      const targets = event.action === 'record.triage_batch_updated' ? meta.recordIds : [event.target_id];
      if (!Array.isArray(targets) || !targets.some(id => String(id).toLowerCase() === transition.recordId)) continue;
      const noteStatus = meta.nextStatus || meta.status;
      if ((!noteStatus || episode.compatible(noteStatus)) && String(meta.note || '').trim()) supplementalNotes.push({id: `status:${event.id}`, body: String(meta.note), createdAt: event.created_at});
    }
    const currentNotes = [...new Map(supplementalNotes.filter(note => note.body.trim()
      && ms(note.createdAt) >= ms(episode.startAt) && ms(note.createdAt) < ms(episode.endAt)).map(note => [note.id, note])).values()]
      .sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.id.localeCompare(b.id));
    output[field].push({recordId: row.id, title: String(row.title || '未命名帖子'), platform: row.platform || 'unknown',
      url: link(row), status: status(row), markedAt: transition.handledAt, eventId: transition.eventId,
      replyContent, supplementalNotes: currentNotes,
      ...(source && source.eventId !== transition.eventId ? {replySourceEventId: source.eventId} : {}),
      ...(Number.isFinite(ms(row.first_seen_at)) ? {isHistorical: ms(row.first_seen_at) < ms(period.collectionStartAt || period.periodStart)} : {})});
  }
  for (const posts of Object.values(output)) posts.sort((a, b) => ms(a.markedAt) - ms(b.markedAt) || a.recordId.localeCompare(b.recordId));
  return output;
}
