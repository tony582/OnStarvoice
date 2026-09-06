(function installTerminalAuthority(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module?.exports) module.exports = api;
  root.OnStarvoiceTerminalAuthority = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function terminalAuthorityApi(root) {
  'use strict';
  const ACTION = 'dismiss_terminal_recovery_metadata';
  const PREPARE = 'onstarvoice:prepare-terminal-recovery-dismissal';
  const EXECUTE = 'onstarvoice:execute-terminal-recovery-dismissal';
  const POLICY = 'terminal-recovery-metadata-v1';
  const WINDOW_MS = 5000;
  const COUNT_KEYS = ['total', 'processed', 'saved', 'success', 'failed', 'skipped', 'retried', 'warnings'];
  const ITEM_KEYS = ['round', 'index', 'keyword', 'status', 'attemptCount', 'savedCount', 'finishedAt'];
  const SOURCE_KEYS = ['clientTaskId', 'controlTaskId', 'clientAttemptId', 'attemptNumber',
    'progressSeq', 'sourceUpdatedAt', 'finishedAt', 'cloudCommandId', 'platform'];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const own = (value, key) => Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
  const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && value.trim() === value;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const denial = reason => ({ok: false, accepted: false, persisted: false, reason});

  // Read only JSON own data, not accessors, inherited grants or synthesized defaults.
  function canonical(value, depth = 0, budget = {nodes: 0}) {
    if (++budget.nodes > 50000 || depth > 18) throw new Error('invalid_data');
    if (value === null || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'string') {
      if (value.length > 200000) throw new Error('invalid_data');
      return JSON.stringify(value);
    }
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (!value || typeof value !== 'object') throw new Error('invalid_data');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length) throw new Error('invalid_data');
    if (Array.isArray(value)) {
      return '[' + Array.from({length: value.length}, (_, index) => {
        const field = descriptors[index];
        if (!field || !own(field, 'value')) throw new Error('invalid_data');
        return canonical(field.value, depth + 1, budget);
      }).join(',') + ']';
    }
    return '{' + Object.keys(descriptors).sort().map(key => {
      if (!own(descriptors[key], 'value')) throw new Error('invalid_data');
      return JSON.stringify(key) + ':' + canonical(descriptors[key].value, depth + 1, budget);
    }).join(',') + '}';
  }
  const copy = value => JSON.parse(canonical(value));
  const equal = (left, right) => canonical(left) === canonical(right);
  function selected(value, keys) {
    if (!record(value) || keys.some(key => !own(value, key))) throw new Error('source_invalid');
    return Object.fromEntries(keys.map(key => [key, value[key]]));
  }
  function emptyOptional(value, key) {
    return !own(value, key) || value[key] === null || value[key] === '' ||
      (record(value[key]) && Object.keys(value[key]).length === 0) ||
      (Array.isArray(value[key]) && value[key].length === 0);
  }
  const SIGNAL_KEYS = /^(securityBlocked|security_blocked|platformSafetyBlocked|platform_safety_blocked|requiresManualAction|requires_manual_action|syncReconciliationRequired|reconciliationRequired|adoptionPending|stopPending|cleanupPending|closurePending)$/;
  const SIGNAL_CODE = /(?:RECONCILIATION|SAFETY_BLOCK|SECURITY|CHALLENGE|AUTHENTICATION_REQUIRED|LOGIN_REQUIRED|RATE_LIMIT|HTTP_429|NEEDS_ACTION|CAPTURE_LOCK_CONFLICT|UNATTENDED_STALE)/i;
  function hasUnsafeSignal(value, parentKey = '') {
    if (Array.isArray(value)) return value.some(item => hasUnsafeSignal(item, parentKey));
    if (!record(value)) return false;
    return Object.entries(value).some(([key, item]) => {
      if (SIGNAL_KEYS.test(key) && item !== false && item !== null) return true;
      if (/^(?:code|errorCode|error_code|category|errorCategory|error_category)$/.test(key) &&
          typeof item === 'string' && SIGNAL_CODE.test(item)) return true;
      if (/security.?evidence/i.test(parentKey) && key === 'confirmed' && item !== false) return true;
      return hasUnsafeSignal(item, key);
    });
  }

  // Business settlement only. This policy never proves physical page quiescence.
  function inspectState(rawState, rawAuth, buildProjection) {
    const state = copy(rawState), auth = copy(rawAuth);
    const {request, ledger} = state;
    if (!record(auth) || !text(auth.authMutationId) || !record(auth.captureAgent) ||
        !text(auth.captureAgent.id) || !text(auth.captureAgent.token) ||
        !record(auth.tenant) || !text(auth.tenant.id)) throw new Error('credential_invalid');
    if (!record(request) || request.status !== 'completed_with_failures' ||
        !UUID.test(request.id) || !UUID.test(request.attemptId) || !timestamp(request.updatedAt) ||
        !timestamp(request.finishedAt) || Date.parse(request.finishedAt) > Date.parse(request.updatedAt) ||
        !integer(request.attemptNumber) || request.attemptNumber < 1 || !integer(request.progressSeq) ||
        request.cloudAgentScopeId !== auth.captureAgent.id || request.cloudAssigned !== true ||
        !UUID.test(request.cloudCommandId)) throw new Error('source_invalid');
    // These are explicit terminal-producer fields. Missing does not mean false.
    if (!own(request, 'recoveryPendingLaunch') || request.recoveryPendingLaunch !== false ||
        request.recoveryWaitUntil !== '' || request.wakeGraceUntil !== '' ||
        !emptyOptional(request, 'recoveryDismissedAt') || hasUnsafeSignal(request)) {
      throw new Error('source_not_eligible');
    }
    for (const key of ['localClosureEvidence', 'localClosureEvidences', 'localClosureStopConfirmation',
      'orchestrationContext', 'previousAttemptId', 'parentRequestId', 'recoveryAdoption',
      'recoveryAdoptionReceipt', 'localRecoveryAdoption', 'adoptionReceipt', 'error']) {
      if (!emptyOptional(request, key)) throw new Error('source_not_eligible');
    }
    const plan = request.planSnapshot;
    if (!record(plan) || !['xiaohongshu', 'douyin'].includes(plan.platform) ||
        plan.autoLoop !== false || plan.maxRounds !== 1 ||
        !Array.isArray(plan.keywords) || plan.keywords.length < 1 || plan.keywords.length > 30 ||
        plan.keywords.some(keyword => !text(keyword) || keyword.length > 120) ||
        new Set(plan.keywords).size !== plan.keywords.length ||
        (!plan.autoLoop && plan.maxRounds !== 1) || !emptyOptional(plan, 'searchPasses')) {
      throw new Error('source_plan_unsupported');
    }
    const total = plan.keywords.length * plan.maxRounds;
    const counts = selected(request.counts, COUNT_KEYS);
    if (Object.values(counts).some(value => !integer(value)) || total > 200 ||
        counts.total !== total || counts.processed !== total || counts.failed + counts.warnings < 1) {
      throw new Error('settlement_invalid');
    }
    const results = request.checkpoint?.keywordResults;
    if (!Array.isArray(results) || results.length !== total) throw new Error('settlement_invalid');
    const seen = new Set(), sums = {completed: 0, partial: 0, failed: 0, skipped: 0, saved: 0, retries: 0};
    const keywordResults = results.map(raw => {
      const item = selected(raw, ITEM_KEYS);
      if (!integer(item.round) || item.round < 1 || item.round > plan.maxRounds || !integer(item.index) ||
          item.index >= plan.keywords.length || item.keyword !== plan.keywords[item.index] ||
          !own(sums, item.status) || !['completed', 'partial', 'failed', 'skipped'].includes(item.status) ||
          !integer(item.attemptCount) || item.attemptCount < 1 || !integer(item.savedCount) ||
          !timestamp(item.finishedAt) || Date.parse(item.finishedAt) > Date.parse(request.finishedAt)) {
        throw new Error('settlement_invalid');
      }
      const identity = `${item.round}:${item.index}`;
      if (seen.has(identity)) throw new Error('settlement_invalid');
      seen.add(identity); sums[item.status]++; sums.saved += item.savedCount;
      sums.retries += Math.max(0, item.attemptCount - 1);
      return item;
    });
    const summary = selected(request.summary, ['completed', 'partial', 'failed', 'skipped', 'saved', 'retries']);
    if (!equal(summary, sums) || counts.success !== sums.completed || counts.failed !== sums.failed ||
        counts.warnings !== sums.partial || counts.skipped !== sums.skipped || counts.saved !== sums.saved ||
        counts.retried !== sums.retries ||
        (own(request.summary, 'total') && request.summary.total !== total) ||
        (own(request.summary, 'success') && request.summary.success !== sums.completed)) {
      throw new Error('settlement_invalid');
    }
    const progress = request.progress;
    if (!record(progress) || progress.unattendedRequestId !== request.id ||
        progress.unattendedAttemptId !== request.attemptId || progress.progressScope !== 'terminal' ||
        progress.phase !== 'unattended_completed_with_failures' || progress.finishedAt !== request.finishedAt ||
        progress.current !== total || progress.total !== total || progress.keywordCurrent !== total ||
        progress.keywordTotal !== total || progress.waitUntil !== '' ||
        progress.streamingSyncEvidenceKnown !== true || progress.streamingSyncDrainCompleted !== true ||
        progress.streamingSyncBlocked !== false || progress.streamingSyncCanceled !== false) {
      throw new Error('settlement_invalid');
    }
    for (const key of ['streamingSyncEnqueuedCount', 'streamingSyncProcessedCount',
      'streamingSyncSuccessCount', 'streamingSyncFailedCount', 'streamingSyncSkippedCount',
      'streamingSyncPendingCount', 'streamingSyncActiveCount', 'streamingSyncRemainingCount',
      'streamingSyncCapturedUniqueCount', 'streamingSyncEnqueuedUniqueCount',
      'streamingSyncExcludedUniqueCount', 'streamingSyncSucceededUniqueCount', 'capturedRecordCount']) {
      if (!own(progress, key) || !integer(progress[key])) throw new Error('settlement_invalid');
    }
    if (!record(ledger) || !Array.isArray(ledger.runs)) throw new Error('source_invalid');
    const matches = ledger.runs.filter(run => run?.id === request.id);
    if (matches.length !== 1) throw new Error('source_ambiguous');
    const run = matches[0];
    if (run.attemptId !== request.attemptId || run.updatedAt !== request.updatedAt ||
        run.status !== request.status || run.finishedAt !== request.finishedAt ||
        run.metadata?.cloudAgentScopeId !== request.cloudAgentScopeId ||
        run.metadata?.cloudCommandId !== request.cloudCommandId || hasUnsafeSignal(run)) {
      throw new Error('source_changed');
    }
    for (const key of ['localClosure', 'localClosures', 'orchestrationContext']) {
      if (!emptyOptional(run.metadata, key)) throw new Error('source_not_eligible');
    }
    if (!own(state, 'archive')) throw new Error('archive_invalid');
    if (state.archive !== null) {
      if (!record(state.archive) || !record(state.archive.requests)) throw new Error('archive_invalid');
      if (own(state.archive.requests, request.id) ||
          Object.values(state.archive.requests).some(entry => entry?.id === request.id)) {
        throw new Error('source_ambiguous');
      }
    }
    const projection = buildProjection(copy(request));
    if (!record(projection?.run) || !record(projection?.snapshot)) throw new Error('projection_unavailable');
    for (const candidate of [projection.run, run, projection.snapshot]) {
      if (candidate.id !== request.id || candidate.attemptId !== request.attemptId ||
          candidate.updatedAt !== request.updatedAt || candidate.attemptNumber !== request.attemptNumber ||
          candidate.progressSeq !== request.progressSeq || candidate.status !== request.status ||
          candidate.finishedAt !== request.finishedAt || candidate.platform !== plan.platform ||
          !equal(selected(candidate.counts, COUNT_KEYS), counts) ||
          !equal(selected(candidate.progress, ['phase', 'current', 'total']),
            selected(progress, ['phase', 'current', 'total'])) ||
          !Array.isArray(candidate.checkpoint?.keywordResults) ||
          !equal(candidate.checkpoint.keywordResults.map(item => selected(item, ITEM_KEYS)), keywordResults)) {
        throw new Error('projection_mismatch');
      }
    }
    const source = {clientTaskId: request.id, controlTaskId: request.id, clientAttemptId: request.attemptId,
      attemptNumber: request.attemptNumber, progressSeq: request.progressSeq, sourceUpdatedAt: request.updatedAt,
      finishedAt: request.finishedAt, cloudCommandId: request.cloudCommandId, platform: plan.platform,
      settlement: {counts, progress: selected(progress, ['phase', 'current', 'total']), keywordResults}};
    return {source, auth, sourceFingerprint: canonical({request, run})};
  }

  function createTerminalAuthority(options = {}) {
    const {extensionId, generation, readState, readCredential, buildProjection,
      checkOnlineAuthority, commitTerminalMetadata, isReady, isCallerCurrent} = options;
    const now = options.now || (() => Date.now());
    const randomId = options.randomId || (() => root.crypto.randomUUID());
    const timer = options.setTimer || root.setTimeout?.bind(root);
    const clearTimer = options.clearTimer || root.clearTimeout?.bind(root);
    const digest = options.digest || (async value => {
      const buffer = await root.crypto.subtle.digest('SHA-256', new root.TextEncoder().encode(value));
      return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
    });
    const handles = new Map(), invalidDocuments = new Set();
    let invalidated = false;
    const ready = () => !invalidated && /^[a-p]{32}$/.test(extensionId) && text(generation) &&
      [readState, readCredential, buildProjection, checkOnlineAuthority, commitTerminalMetadata,
        isReady, isCallerCurrent, timer, clearTimer].every(port => typeof port === 'function') && isReady() === true;
    function callerFrom(sender) {
      try {
        const data = copy(sender), url = `chrome-extension://${extensionId}/sidebar/sidebar.html`;
        if (data.id !== extensionId || data.url !== url || !text(data.documentId) ||
            data.documentLifecycle !== 'active' || (own(data, 'frameId') && data.frameId !== 0) ||
            (own(data, 'tab') && (!record(data.tab) || data.tab.url !== url || !integer(data.tab.id)))) return null;
        return {id: data.id, url, documentId: data.documentId, generation,
          tabId: data.tab?.id ?? null, frameId: data.frameId ?? null};
      } catch {return null;}
    }
    const currentCaller = caller => !invalidated && !invalidDocuments.has(caller.documentId) &&
      isCallerCurrent(Object.freeze({...caller})) === true;
    function parseMessage(message, type) {
      const safe = copy(message);
      const keys = type === PREPARE ? ['action', 'type'] : ['action', 'type', 'handle'];
      if (!record(safe) || Object.keys(safe).some(key => !keys.includes(key)) || safe.action !== ACTION ||
          (own(safe, 'type') && safe.type !== type) || (type === EXECUTE && !text(safe.handle))) {
        throw new Error('command_invalid');
      }
      return safe;
    }
    function prune() {
      const time = now();
      for (const [key, entry] of handles) {
        if (entry.state !== 'executing' && time >= (entry.receiptUntil || entry.expiresAt)) handles.delete(key);
      }
    }
    async function readCandidate() {
      const auth = await readCredential();
      const state = await readState();
      // An omitted storage archive key is represented explicitly as null by the host.
      const candidate = inspectState(state, auth, buildProjection);
      candidate.credentialFingerprint = await digest(canonical(candidate.auth));
      return candidate;
    }
    async function online(candidate, caller, upperBound = Infinity) {
      const startedAt = now(), deadline = Math.min(startedAt + WINDOW_MS, upperBound);
      if (deadline <= startedAt || !currentCaller(caller)) throw new Error('authority_expired');
      const abort = new root.AbortController();
      let timeoutId;
      const timeout = new Promise((resolve, reject) => {
        timeoutId = timer(() => {abort.abort(); reject(new Error('authority_expired'));}, deadline - startedAt);
      });
      let response;
      try {
        response = copy(await Promise.race([
          Promise.resolve().then(() => checkOnlineAuthority({action: ACTION, source: copy(candidate.source)},
            {rawAuth: copy(candidate.auth), signal: abort.signal, deadline})), timeout,
        ]));
      } finally {clearTimer(timeoutId);}
      if (now() >= deadline || !currentCaller(caller)) throw new Error('authority_expired');
      if (response.ok !== true || response.decision !== 'allow' || response.action !== ACTION ||
          response.policyVersion !== POLICY || !/^[0-9a-f]{64}$/.test(response.authorityRevision) ||
          response.agentId !== candidate.auth.captureAgent.id || response.tenantId !== candidate.auth.tenant.id ||
          !text(response.authCodeId) || !text(response.authBindingId) || !timestamp(response.evaluatedAt) ||
          !timestamp(response.expiresAt) || Date.parse(response.expiresAt) <= now() ||
          Date.parse(response.expiresAt) <= Date.parse(response.evaluatedAt) ||
          Date.parse(response.expiresAt) - Date.parse(response.evaluatedAt) > WINDOW_MS ||
          !equal(selected(response.source, SOURCE_KEYS), selected(candidate.source, SOURCE_KEYS)) ||
          ['serverTaskId', 'serverAttemptId', 'snapshotId', 'snapshotFingerprint'].some(key => !text(response.source[key]))) {
        throw new Error('authority_denied');
      }
      return {authority: response, deadline: Math.min(deadline, Date.parse(response.expiresAt))};
    }
    async function prepare(message, sender) {
      const caller = callerFrom(sender);
      if (!caller) return denial('caller_invalid');
      try {
        parseMessage(message, PREPARE);
        if (!ready() || !currentCaller(caller)) return denial('control_unavailable');
        prune();
        if (handles.size >= 128) return denial('handle_capacity');
        const candidate = await readCandidate();
        const evaluation = await online(candidate, caller);
        const handle = `${randomId()}.${randomId()}`;
        if (!text(handle) || handles.has(handle)) return denial('handle_unavailable');
        handles.set(handle, {state: 'prepared', caller, candidate,
          credentialFingerprint: candidate.credentialFingerprint,
          authority: evaluation.authority, expiresAt: evaluation.deadline});
        return {ok: true, accepted: true, persisted: false, reason: 'terminal_metadata_prepared',
          action: ACTION, handle, expiresAt: new Date(evaluation.deadline).toISOString()};
      } catch (error) {return denial(safeReason(error));}
    }
    async function execute(message, sender) {
      const caller = callerFrom(sender);
      if (!caller) return denial('caller_invalid');
      let entry;
      try {
        const intent = parseMessage(message, EXECUTE);
        if (!ready() || !currentCaller(caller)) return denial('control_unavailable');
        prune(); entry = handles.get(intent.handle);
        if (!entry || !equal(entry.caller, caller)) return denial('handle_invalid');
        if (entry.state === 'done') {
          // A receipt is not a new grant, but even its task identifiers belong
          // to the original identity. Do not wait for async storage.onChanged
          // to hide them after a same-agent token/binding or tenant replacement.
          const fingerprint = await digest(canonical(await readCredential()));
          if (!ready() || !currentCaller(caller) || fingerprint !== entry.credentialFingerprint) {
            handles.delete(intent.handle);
            return denial('handle_invalid');
          }
          return {...entry.receipt, replayed: true};
        }
        if (entry.state !== 'prepared') return denial('handle_consumed');
        entry.state = 'executing';
        const candidate = await readCandidate();
        if (candidate.credentialFingerprint !== entry.candidate.credentialFingerprint ||
            candidate.sourceFingerprint !== entry.candidate.sourceFingerprint) throw new Error('source_changed');
        const evaluation = await online(candidate, caller, entry.expiresAt);
        const validateCurrent = (state, auth) => {
          try {
            if (!ready() || !currentCaller(caller) || now() >= evaluation.deadline) return denial('authority_expired');
            const current = inspectState(state, auth, buildProjection);
            if (canonical(current.auth) !== canonical(candidate.auth) ||
                current.sourceFingerprint !== candidate.sourceFingerprint) return denial('source_changed');
            return {accepted: true, source: copy(candidate.source)};
          } catch (error) {return denial(safeReason(error));}
        };
        const result = await commitTerminalMetadata({source: copy(candidate.source),
          credentialFingerprint: candidate.credentialFingerprint, authority: copy(evaluation.authority),
          deadline: evaluation.deadline, validateCurrent});
        if (result?.accepted !== true || result?.persisted !== true) {
          throw new Error(result?.reason === 'authority_expired' ? 'authority_expired' : 'commit_rejected');
        }
        const receipt = {ok: true, accepted: true, persisted: true, action: ACTION,
          reason: 'terminal_metadata_persisted', requestId: candidate.source.clientTaskId,
          attemptId: candidate.source.clientAttemptId, replayed: false};
        entry.state = 'done'; entry.receipt = receipt; entry.receiptUntil = now() + 30000;
        // Completed receipts retain no credential or raw business data.
        delete entry.candidate; delete entry.authority;
        return receipt;
      } catch (error) {
        if (entry && entry.state === 'executing') {
          entry.state = 'failed'; delete entry.candidate; delete entry.authority;
        }
        return denial(safeReason(error));
      }
    }
    const reasons = new Set(['invalid_data', 'source_invalid', 'credential_invalid', 'source_not_eligible',
      'source_plan_unsupported', 'settlement_invalid', 'source_ambiguous', 'source_changed', 'archive_invalid',
      'projection_unavailable', 'projection_mismatch', 'command_invalid', 'authority_expired',
      'authority_denied', 'commit_rejected']);
    function safeReason(error) {return reasons.has(error?.message) ? error.message : 'control_unavailable';}
    return Object.freeze({prepare, execute,
      invalidateCaller({documentId} = {}) {
        if (!text(documentId)) return;
        invalidDocuments.add(documentId);
        for (const [handle, entry] of handles) {
          if (entry.caller.documentId === documentId && entry.state !== 'executing') handles.delete(handle);
        }
        // A long-lived worker cannot accumulate an unbounded document tombstone set.
        if (invalidDocuments.size > 256) {invalidated = true; handles.clear(); invalidDocuments.clear();}
      },
      invalidateAll() {invalidated = true; handles.clear();},
    });
  }
  return Object.freeze({ACTION, PREPARE, EXECUTE, POLICY, WINDOW_MS, createTerminalAuthority});
});
