import { payloadHash } from '../storage/codec.mjs';
import { RunnerFault } from './errors.mjs';

const DEFAULTS = Object.freeze({ maxLinks: 20, maxCards: 40, maxSwipes: 20, keywordMs: 600_000, batchMs: 1_500_000, maxPending: 100 });

export class BudgetLedger {
  constructor({ task, store, clock, resumeAuthorized = false }) {
    this.task = task;
    this.store = store;
    this.clock = clock;
    this.limits = { ...DEFAULTS, ...task.budgets };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RunnerFault('invalid_budget');
    }
    this.key = task.identity.discoveryRunId;
    const saved = store.loadCheckpoint(this.key);
    const now = clock.wallNow();
    const requestedDeadline = task.deadlineAt ? Date.parse(task.deadlineAt) : null;
    if (requestedDeadline !== null && !Number.isFinite(requestedDeadline)) throw new RunnerFault('invalid_deadline');
    this.revision = saved?.revision ?? 0;
    this.state = saved?.value ?? { limitsHash: payloadHash(this.limits), elapsedMs: 0, lastWallAt: now, deadlineAt: requestedDeadline, items: {} };
    if (this.state.limitsHash !== payloadHash(this.limits)) throw new RunnerFault('budget_configuration_changed');
    if (now < this.state.lastWallAt) throw new RunnerFault('wall_clock_regressed');
    if (requestedDeadline !== null) this.state.deadlineAt = Math.min(this.state.deadlineAt ?? Infinity, requestedDeadline);
    this.state.elapsedMs += now - this.state.lastWallAt;
    this.itemKey = task.identity.itemId;
    let item = this.state.items[this.itemKey];
    if (item) {
      if (!resumeAuthorized) throw new RunnerFault('resume_authorization_required');
      if (['completed', 'completed_with_warnings', 'canceled'].includes(item.status)) throw new RunnerFault('terminal_item');
      if (item.attemptId === task.identity.attemptId || task.identity.assignmentRevision <= item.assignmentRevision) throw new RunnerFault('fresh_attempt_required');
      if (item.definitionHash !== payloadHash({ keyword: task.keyword, filters: task.filters })) throw new RunnerFault('item_definition_changed');
      item.elapsedMs += now - item.lastWallAt;
      item.attemptId = task.identity.attemptId;
      item.assignmentRevision = task.identity.assignmentRevision;
      item.status = 'running';
    } else {
      item = { definitionHash: payloadHash({ keyword: task.keyword, filters: task.filters }), attemptId: task.identity.attemptId,
        assignmentRevision: task.identity.assignmentRevision,
        elapsedMs: 0, lastWallAt: now, cards: 0, swipes: 0, links: [], status: 'running' };
      this.state.items[this.itemKey] = item;
    }
    // An event can survive a crash before noteLink. Count all original attempts,
    // including acknowledged/quarantined delivery, without retargeting evidence.
    item.links = [...new Set([...item.links, ...store.discoveredWorkIds(task.identity)])];
    this.lastMono = clock.monotonicNow();
    this.state.lastWallAt = now;
    this.item.lastWallAt = now;
    this.save();
  }
  get item() { return this.state.items[this.itemKey]; }
  advance() {
    const wall = this.clock.wallNow();
    const mono = this.clock.monotonicNow();
    if (wall < this.state.lastWallAt || mono < this.lastMono) throw new RunnerFault('wall_clock_regressed');
    const elapsed = Math.max(wall - this.state.lastWallAt, mono - this.lastMono);
    this.state.elapsedMs += elapsed;
    this.item.elapsedMs += elapsed;
    this.state.lastWallAt = wall;
    this.item.lastWallAt = wall;
    this.lastMono = mono;
  }
  save() { this.revision = this.store.saveCheckpoint(this.key, this.state, this.revision); }
  assertAllowed() {
    this.advance();
    this.save();
    const deadline = this.state.deadlineAt ?? Infinity;
    const reason = this.clock.wallNow() >= deadline ? 'task_deadline' : this.state.elapsedMs >= this.limits.batchMs ? 'batch_time_limit'
      : this.item.elapsedMs >= this.limits.keywordMs ? 'keyword_time_limit' : this.item.links.length >= this.limits.maxLinks ? 'link_limit' : null;
    if (reason) throw new RunnerFault('budget_exhausted', reason, { reason });
    if (this.store.pendingCount() >= this.limits.maxPending) throw new RunnerFault('outbox_backlog');
  }
  beforeCard() {
    this.assertAllowed();
    if (this.item.cards >= this.limits.maxCards) throw new RunnerFault('budget_exhausted', 'card_limit', { reason: 'card_limit' });
    this.item.cards++;
    this.save();
  }
  beforeSwipe() {
    this.assertAllowed();
    if (this.item.swipes >= this.limits.maxSwipes) throw new RunnerFault('budget_exhausted', 'swipe_limit', { reason: 'swipe_limit' });
    this.item.swipes++;
    this.save();
  }
  noteLink(identity) {
    if (this.item.links.includes(identity)) return false;
    this.item.links.push(identity);
    this.save();
    return true;
  }
  finish(status, reason) {
    this.advance();
    this.item.status = status;
    this.item.reason = reason;
    this.save();
  }
  summary() {
    return { cards: this.item.cards, swipes: this.item.swipes, links: this.item.links.length,
      keywordElapsedMs: this.item.elapsedMs, batchElapsedMs: this.state.elapsedMs };
  }
}
