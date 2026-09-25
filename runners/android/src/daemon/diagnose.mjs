import {readDiagnostics} from '../core/diagnostics.mjs';
import {daemonStatus} from './local-control.mjs';

// Read-only summary of recent keyword runs and why cards or runs ended early, from the local state only.
// A keyword run's budget checkpoint is recognised by its shape, not by its key format.
const isRunLedger = value => !!value && typeof value.limitsHash === 'string' && !!value.items && typeof value.items === 'object';
const beijing = milliseconds => new Date(milliseconds + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
const DONE = new Set(['completed', 'completed_with_warnings']);

export function diagnoseRunner(store, {hours = 24, now = Date.now()} = {}) {
  const since = now - hours * 3_600_000;
  const notes = readDiagnostics(store).filter(entry => Date.parse(entry?.at) >= since);
  const keywords = new Map();
  for (const entry of notes) if (entry.itemId && entry.keyword) keywords.set(entry.itemId, entry.keyword);
  for (const event of store.recentEventKeywords?.(since) ?? []) if (!keywords.has(event.itemId)) keywords.set(event.itemId, event.keyword);
  const runs = [];
  for (const {runId, value} of store.listCheckpoints()) {
    if (!isRunLedger(value)) continue;
    for (const [itemId, item] of Object.entries(value.items)) {
      if (!(item.lastWallAt >= since)) continue;
      runs.push({start: beijing(item.lastWallAt - item.elapsedMs), end: beijing(item.lastWallAt), keyword: keywords.get(itemId) ?? null,
        status: item.status, reason: item.reason ?? null, links: item.links?.length ?? 0, cards: item.cards, swipes: item.swipes,
        skipped: item.skippedCards ?? 0, minutes: Math.round(item.elapsedMs / 6000) / 10, revision: item.assignmentRevision,
        runId: runId.slice(0, 8)});
    }
  }
  runs.sort((a, b) => a.end.localeCompare(b.end));
  const byReason = {};
  for (const run of runs) byReason[`${run.status}:${run.reason}`] = (byReason[`${run.status}:${run.reason}`] ?? 0) + 1;
  const problems = notes.filter(entry => entry.event !== 'task_finished' || !DONE.has(entry.status)).slice(-40)
    .map(entry => ({...entry, at: beijing(Date.parse(entry.at))}));
  return {checkedAt: beijing(now), hours, status: daemonStatus(store),
    summary: {runs: runs.length, finished: runs.filter(run => DONE.has(run.status)).length,
      endedEarly: runs.filter(run => !DONE.has(run.status)).length, links: runs.reduce((sum, run) => sum + run.links, 0),
      skippedCards: runs.reduce((sum, run) => sum + run.skipped, 0), byReason},
    runs, problems};
}
