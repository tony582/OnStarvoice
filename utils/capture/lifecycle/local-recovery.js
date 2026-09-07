// Local-only control handoff. The original request/checkpoint projectors and
// producer are injected; no platform capture or second business executor lives
// here. Network/browser waits are outside every final-write lock.
(function install(root) {
  'use strict';
  const CLIENT_PORT = 'onstarvoice:local-recovery-client-v1';
  const RUNNER_PORT = 'onstarvoice:local-recovery-runner-v1';
  const PREFIX = 'onstarvoice:local-recovery-';
  const SAVE = 'onstarvoice:local-control-save-plan';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const deny = reason => ({ok: false, accepted: false, reason, successorAllowed: false});
  function create(ports) {
    const {journal, authority, captureControl, extensionId, normalizePlan, buildOriginal,
      buildRecovery, project, createRunner, afterPlanSaved = async () => {},
      lockLeaseMs = 2 * 60 * 1000,
      now = Date.now, randomId = () => root.crypto.randomUUID()} = ports;
    const sourceApi = root.OnStarvoiceLocalCaptureSource;
    const api = root.OnStarvoiceLocalCaptureAuthority;
    const canonical = api.canonical;
    const connections = new Map(), pendingBinds = new Map(), activations = new Map();
    const stamp = () => new Date(now()).toISOString();
    function noteWrite(effects, operation, attemptedPhase, identity) {
      Object.assign(effects, {writeAttempted: true, operation, attemptedPhase, ...identity});
    }
    async function failure(error, effects) {
      const result = deny(String(error?.message || 'local_recovery_failed'));
      if (!effects.writeAttempted) return result;
      // A rejected acknowledgement is not a rollback. This read grants no
      // execution and never repairs, retries, removes a fence, or closes a tab.
      let observedPhase = 'unknown', observation = 'unavailable', runnerTabId = effects.runnerTabId ?? null;
      try {
        const state = await journal.read();
        observation = 'not_matched';
        if (effects.operation === 'save_plan') {
          if (state.origin?.plan?.originId === effects.originId &&
              canonical(sourceApi.planIdentity(state.plan)) === canonical(sourceApi.planIdentity(state.origin.plan.planSnapshot))) {
            observedPhase = 'plan_saved'; observation = 'matched';
          }
        } else if (state.launch?.id === effects.launchIntentId &&
            ['prepared', 'runner_bound', 'activated', 'claimed', 'failed'].includes(state.launch.phase) &&
            state.launch.request?.id === effects.requestId && state.launch.request?.attemptId === effects.attemptId) {
          observedPhase = state.launch.phase; observation = 'matched';
          if (Number.isSafeInteger(state.launch.tabId) && state.launch.tabId > 0) runnerTabId = state.launch.tabId;
        }
      } catch { /* Unavailable storage is uncertainty, never evidence of no write. */ }
      return {...result, phase: observedPhase, reconciliationPending: true, resourcesReleased: false,
        automaticRetryAllowed: false,
        effectReceipt: {version: 1, operation: effects.operation, originId: effects.originId ?? null,
          launchIntentId: effects.launchIntentId ?? null, requestId: effects.requestId ?? null,
          attemptId: effects.attemptId ?? null, attemptedPhase: effects.attemptedPhase,
          observedPhase, observation, runnerCreationAttempted: effects.runnerCreationAttempted === true,
          runnerTabId, effectUncertain: true, reconciliationPending: true,
          resourcesReleased: false, automaticRetryAllowed: false}};
    }
    function caller(sender) {
      try {
        const url = new URL(sender?.url);
        if (sender?.id !== extensionId || url.protocol !== 'chrome-extension:' || url.host !== extensionId ||
            url.pathname !== '/sidebar/sidebar.html' || url.username || url.password || url.hash ||
            !sender.documentId || sender.documentLifecycle !== 'active' || (sender.frameId != null && sender.frameId !== 0)) return null;
        return {documentId: sender.documentId, tabId: sender.tab?.id ?? null, url: url.href};
      } catch {return null;}
    }
    const connection = c => c && connections.get(c.documentId);
    const connected = (c, name) => connection(c)?.port?.sender?.url === c.url && connection(c).name === name;
    function checkClient(c) {
      if (!connected(c, CLIENT_PORT) || new URL(c.url).search) throw new Error('local_control_client_unavailable');
    }
    function attachPort(port) {
      if (![CLIENT_PORT, RUNNER_PORT].includes(port?.name)) return false;
      const c = caller(port.sender);
      if (!c || connections.size >= 32) {port.disconnect?.(); return true;}
      const previous = connection(c);
      connections.set(c.documentId, {port, name: port.name, connectionId: randomId()});
      if (previous) void failForConnection(previous.connectionId, 'connection_replaced');
      port.onDisconnect.addListener(() => {
        if (connection(c)?.port !== port) return;
        const entry = connection(c);
        connections.delete(c.documentId);
        void failForConnection(entry.connectionId, 'connection_disconnected');
      });
      return true;
    }
    async function failForConnection(connectionId, reason) {
      const earlyIntents = [];
      for (const [id, pending] of pendingBinds) if (pending.entry.connectionId === connectionId) {
        earlyIntents.push(id); pendingBinds.delete(id);
      }
      try {
        await journal.localTransaction(state => {
          const l = state.launch;
          if (!l || l.phase === 'claimed' || (!earlyIntents.includes(l.id) && ![l.connectionId, l.clientConnectionId].includes(connectionId))) return {result: false};
          return {patch: {launch: {...l, phase: 'failed', reason, updatedAt: stamp()}}, result: true};
        });
      } catch { /* retained intent still blocks legacy launch */ }
    }
    const bindingOf = authority => Object.fromEntries(api.BINDING_KEYS.map(key => [key, authority[key]]));
    async function authorize(action, proof, state, revision) {
      if (await api.hash(state.auth) !== proof.credentialFingerprint ||
          await api.hash(sourceApi.planIdentity(proof.planSnapshot)) !== proof.planFingerprint) throw new Error('local_origin_changed');
      return authority.evaluate({action, auth: state.auth, expectedBinding: proof.binding,
        source: {originId: proof.originId, planFingerprint: proof.planFingerprint, platform: proof.planSnapshot.platform,
          requestId: proof.requestId, attemptId: proof.attemptId, generation: proof.generation,
          sourceRevision: revision}});
    }
    async function savePlan(message, c, effects) {
      checkClient(c);
      const clientConnection = connection(c);
      if (message.candidate !== true) throw new Error('local_candidate_required');
      const state = await journal.read();
      if (state.journal || state.launch || (state.request && !['completed', 'completed_with_failures', 'failed', 'canceled', 'needs_action', 'interrupted', 'stale'].includes(state.request.status))) {
        throw new Error('local_plan_source_busy');
      }
      const plan = normalizePlan(message.plan, {updatedAt: stamp()});
      if (!plan.enabled || !Array.isArray(plan.keywords) || !plan.keywords.length || plan.keywords.length > 30) throw new Error('local_plan_invalid');
      const originId = randomId(), planFingerprint = await api.hash(sourceApi.planIdentity(plan));
      const credentialFingerprint = await api.hash(state.auth);
      const revision = await api.hash({plan, previous: state.plan, clearedAt: state.ledger?.clearedAt || ''});
      const grant = await authority.evaluate({action: 'admit_local_plan', auth: state.auth,
        source: {originId, planFingerprint, platform: plan.platform, requestId: '', attemptId: '', generation: 0, sourceRevision: revision}});
      const proof = {version: 1, kind: 'local-authored-plan', originId, planFingerprint, credentialFingerprint,
        authMutationId: state.auth.authMutationId, binding: bindingOf(grant.authority), createdAt: stamp(), planSnapshot: copy(plan)};
      if (!sourceApi.validProof(proof)) throw new Error('local_plan_origin_invalid');
      await journal.localTransaction(fresh => {
        checkClient(c);
        if (connection(c) !== clientConnection || now() >= grant.deadline || fresh.journal || fresh.launch ||
            canonical(fresh.auth) !== canonical(state.auth) || canonical(fresh.plan) !== canonical(state.plan) ||
            canonical(fresh.request) !== canonical(state.request) ||
            String(fresh.ledger?.clearedAt || '') !== String(state.ledger?.clearedAt || '')) throw new Error('local_plan_changed');
        noteWrite(effects, 'save_plan', 'plan_saved', {originId});
        return {patch: {plan, origin: {version: 1, plan: proof, request: fresh.origin?.request || null}}, result: true};
      });
      await afterPlanSaved(plan);
      return {ok: true, accepted: true, originId, data: plan, candidateOnly: true};
    }
    async function maybeCreateOriginal(plan, options = {}) {
      if (options.cloudAssigned === true || options.cloudCommandId || options.orchestrationContext) return {handled: false};
      const state = await journal.read();
      if (!state.origin?.plan) return {handled: false};
      const p = state.origin.plan;
      if (!sourceApi.validProof(p) || canonical(sourceApi.planIdentity(plan)) !== canonical(sourceApi.planIdentity(p.planSnapshot)) ||
          canonical(sourceApi.planIdentity(state.plan)) !== canonical(sourceApi.planIdentity(p.planSnapshot))) throw new Error('local_plan_provenance_changed');
      if (state.journal || state.launch || (state.request && !['completed', 'completed_with_failures', 'failed', 'canceled', 'needs_action', 'interrupted', 'stale'].includes(state.request.status))) throw new Error('local_original_source_busy');
      const request = {...buildOriginal(plan, options, state.auth, stamp()), strictControlCandidate: true};
      const proof = {...p, requestId: request.id, attemptId: request.attemptId, requestCreatedAt: request.createdAt, generation: 1};
      const grant = await authorize('start_local_capture', proof, state, await api.hash({request, proof}));
      await journal.localTransaction(fresh => {
        if (now() >= grant.deadline || fresh.journal || fresh.launch ||
            canonical(fresh.auth) !== canonical(state.auth) || canonical(fresh.origin) !== canonical(state.origin) ||
            canonical(fresh.plan) !== canonical(state.plan) || canonical(fresh.request) !== canonical(state.request) ||
            String(fresh.ledger?.clearedAt || '') !== String(state.ledger?.clearedAt || '')) throw new Error('local_original_source_changed');
        const ledger = project(fresh.ledger, request, null);
        return {patch: {request, ledger, origin: {...fresh.origin, request: proof}}, result: true};
      });
      return {handled: true, request};
    }
    function stoppedFacts(state) {
      const p = sourceApi.requestProof(state, {allowSuccessor: false}), j = state.journal;
      if (!j || j.originKind !== 'local-v1' || j.originId !== p.originId || j.generation !== 1 ||
          j.requestId !== p.requestId || j.attemptId !== p.attemptId || j.phase !== 'stopped' ||
          j.runnerQuiesced !== true || j.ownerReleased !== true || j.receipt?.sourceStopped !== true ||
          j.receipt.requestId !== p.requestId || j.receipt.attemptId !== p.attemptId ||
          j.receipt.generation !== 1 || j.receipt.runnerQuiesced !== true || j.receipt.phase !== 'stopped' ||
          j.credentialFingerprint !== p.credentialFingerprint ||
          j.ownerDocumentId !== j.lockIdentity?.holderDocumentId || j.ownerTabId !== j.lockIdentity?.holderTabId ||
          j.operations.length || j.activities.length || j.pages.some(page => !page.stopped || !page.quiesced) ||
          canonical(root.OnStarvoiceActiveStopAuthority.lockIdentity(state.lock, state.request)) !== canonical(j.lockIdentity)) throw new Error('local_source_not_quiescent');
      return {request: state.request, proof: p, journal: {...j, updatedAt: ''}, lock: j.lockIdentity, generation: j.generation,
        stopId: j.stopId || '', pages: j.pages, operationWatermark: j.operationWatermark,
        activityWatermark: j.activityWatermark, clearedAt: String(state.ledger?.clearedAt || ''),
        row: state.ledger.runs.find(row => row.id === state.request.id)};
    }
    async function checkedSource(launch = null) {
      const state = await captureControl.localRecoverySource();
      const facts = stoppedFacts(state), revision = await api.hash(facts);
      if (launch && (launch.sourceRevision !== revision || launch.workerEpoch !== state.journal.workerEpoch)) throw new Error('local_recovery_source_changed');
      return {state, facts, revision};
    }
    function checkFreshSource(fresh, prior, launch = null) {
      if (canonical(fresh.auth) !== canonical(prior.state.auth) || canonical(stoppedFacts(fresh)) !== canonical(prior.facts) ||
          (launch && canonical(fresh.launch) !== canonical(launch))) throw new Error('local_recovery_source_changed');
    }
    async function prepare(message, c, effects) {
      checkClient(c);
      const client = connection(c);
      const prior = await checkedSource();
      const {state, facts, revision} = prior;
      if (message.requestId !== state.request.id || message.attemptId !== state.request.attemptId || state.launch) throw new Error('local_recovery_target_changed');
      if (!['remaining', 'failed', 'skip_current'].includes(message.mode)) throw new Error('local_recovery_mode_invalid');
      const next = buildRecovery(state.request, message.mode, stamp());
      const launchId = randomId();
      const request = {...next, strictControlCandidate: true, localRecoveryIntentId: launchId};
      const grant = await authorize('recover_local_capture', facts.proof, state, revision);
      const launch = {version: 1, id: launchId, phase: 'prepared', generation: 2, sourceRevision: revision,
        sourceRequestId: state.request.id, sourceAttemptId: state.request.attemptId,
        workerEpoch: state.journal.workerEpoch, request, createdAt: stamp(), updatedAt: stamp(),
        clientDocumentId: c.documentId, clientConnectionId: client.connectionId, tabId: null,
        documentId: '', connectionId: '', holderId: ''};
      await journal.localTransaction(fresh => {
        checkClient(c); checkFreshSource(fresh, prior);
        if (fresh.launch || connection(c) !== client || now() >= grant.deadline) throw new Error('local_recovery_prepare_changed');
        noteWrite(effects, 'prepare', 'prepared', {originId: facts.proof.originId,
          launchIntentId: launchId, requestId: request.id, attemptId: request.attemptId});
        return {patch: {launch}, result: true};
      });
      // Intentionally no platform tab, reuse, navigation, or tab-only cleanup.
      effects.runnerCreationAttempted = true;
      const runner = await createRunner(request, launchId);
      if (!Number.isSafeInteger(runner?.id) || runner.id <= 0) throw new Error('local_runner_creation_unconfirmed');
      effects.runnerTabId = runner.id;
      await journal.localTransaction(fresh => {
        checkClient(c); checkFreshSource(fresh, prior, launch);
        if (connection(c) !== client) throw new Error('local_recovery_client_changed');
        return {patch: {launch: {...fresh.launch, tabId: runner.id, updatedAt: stamp()}}, result: true};
      });
      const pending = pendingBinds.get(launchId);
      if (pending && connection(pending.c) === pending.entry) {
        pendingBinds.delete(launchId);
        void bindRunner({launchIntentId: launchId, holderId: pending.holderId}, pending.c).catch(() => {});
      }
      return {ok: true, accepted: true, phase: 'prepared', launchIntentId: launchId,
        requestId: request.id, attemptId: request.attemptId, successorAllowed: false};
    }
    function runnerConnection(c, l, holderId) {
      if (!connected(c, RUNNER_PORT) || !Number.isSafeInteger(c.tabId) || c.tabId <= 0 ||
          typeof holderId !== 'string' || !holderId || holderId.length > 320 || holderId.trim() !== holderId) throw new Error('local_runner_connection_invalid');
      const query = new URL(c.url).searchParams;
      for (const [key, value] of [['localRecoveryIntent', l.id], ['unattendedRun', l.request.id], ['unattendedAttempt', l.request.attemptId]]) {
        if (query.getAll(key).length !== 1 || query.get(key) !== value) throw new Error('local_runner_identity_changed');
      }
      if (l.tabId !== null && l.tabId !== c.tabId) throw new Error('local_runner_tab_changed');
      return connection(c);
    }
    async function bindRunner(message, c, effects = {}) {
      const entry = connection(c);
      if (!connected(c, RUNNER_PORT)) throw new Error('local_runner_connection_invalid');
      const state = await journal.read(), l = state.launch;
      if (!l || l.id !== message.launchIntentId || l.phase !== 'prepared') throw new Error('local_runner_intent_unavailable');
      if (runnerConnection(c, l, message.holderId) !== entry) throw new Error('local_runner_connection_changed');
      if (l.tabId === null) {
        if (pendingBinds.has(l.id) && pendingBinds.get(l.id).entry !== entry) throw new Error('local_runner_early_binding_conflict');
        pendingBinds.set(l.id, {c, entry, holderId: message.holderId});
        return {ok: true, phase: 'prepared'};
      }
      const prior = await checkedSource(l);
      await journal.localTransaction(fresh => {
        checkFreshSource(fresh, prior, l);
        if (runnerConnection(c, fresh.launch, message.holderId) !== entry) throw new Error('local_runner_connection_changed');
        noteWrite(effects, 'runner_bind', 'runner_bound', {originId: prior.facts.proof.originId,
          launchIntentId: l.id, requestId: l.request.id, attemptId: l.request.attemptId});
        return {patch: {launch: {...fresh.launch, phase: 'runner_bound', documentId: c.documentId,
          holderId: message.holderId, connectionId: entry.connectionId, updatedAt: stamp()}}, result: true};
      });
      if (!activations.has(l.id)) {
        const work = activate(l.id, c).catch(async error => {
          await failForConnection(entry.connectionId, String(error?.message || 'activation_failed'));
          return false;
        }).finally(() => activations.delete(l.id));
        activations.set(l.id, work);
      }
      return {ok: true, phase: 'runner_bound'};
    }
    function exactRunner(c, l) {
      const entry = runnerConnection(c, l, l.holderId);
      if (l.documentId !== c.documentId || l.connectionId !== entry.connectionId) throw new Error('local_runner_connection_changed');
      const client = connections.get(l.clientDocumentId);
      if (client?.connectionId !== l.clientConnectionId || client.name !== CLIENT_PORT) throw new Error('local_recovery_client_changed');
      return entry;
    }
    async function activate(id, c) {
      const state = await journal.read(), l = state.launch;
      if (l?.id !== id || l.phase !== 'runner_bound') throw new Error('local_activation_unavailable');
      const entry = exactRunner(c, l), prior = await checkedSource(l);
      const grant = await authorize('recover_local_capture', prior.facts.proof, prior.state, prior.revision);
      await journal.localTransaction(fresh => {
        checkFreshSource(fresh, prior, l);
        if (exactRunner(c, fresh.launch) !== entry || now() >= grant.deadline) throw new Error('local_activation_changed');
        return {patch: {launch: {...fresh.launch, phase: 'activated', updatedAt: stamp()}}, result: true};
      });
      entry.port.postMessage({type: PREFIX + 'activated', launchIntentId: id,
        requestId: l.request.id, attemptId: l.request.attemptId, generation: l.generation});
      return true;
    }
    async function claim(message, c, effects) {
      const entry = connection(c);
      if (!connected(c, RUNNER_PORT)) throw new Error('local_runner_connection_invalid');
      const state = await journal.read(), l = state.launch;
      if (!l || l.phase !== 'activated' || l.id !== message.launchIntentId ||
          l.request.id !== message.requestId || l.request.attemptId !== message.attemptId ||
          l.generation !== message.generation || l.holderId !== message.holderId) throw new Error('local_claim_not_activated');
      if (exactRunner(c, l) !== entry) throw new Error('local_runner_connection_changed');
      const prior = await checkedSource(l);
      const grant = await authorize('recover_local_capture', prior.facts.proof, prior.state, prior.revision);
      const at = stamp();
      const request = {...l.request, status: 'running', recoveryPendingLaunch: false,
        runnerTabId: c.tabId, claimedAt: at, startedAt: at, updatedAt: at, heartbeatAt: at, businessProgressAt: at};
      const proof = {...prior.facts.proof, requestId: request.id, attemptId: request.attemptId,
        requestCreatedAt: request.createdAt, generation: 2, sourceRequestId: l.sourceRequestId,
        sourceAttemptId: l.sourceAttemptId, launchIntentId: l.id, planSnapshot: copy(request.planSnapshot),
        planFingerprint: await api.hash(sourceApi.planIdentity(request.planSnapshot))};
      return captureControl.adoptLocalSuccessor({auth: prior.state.auth, proof, generation: 2, port: entry.port},
        () => journal.localTransaction(fresh => {
          checkFreshSource(fresh, prior, l);
          if (exactRunner(c, fresh.launch) !== entry || now() >= grant.deadline) throw new Error('local_claim_changed');
          const old = fresh.journal;
          const lock = {...fresh.lock, id: randomId(), holderId: l.holderId, holderDocumentId: c.documentId,
            holderTabId: c.tabId, captureTaskId: `unattended-capture:${request.id}`,
            captureTaskAttemptId: request.attemptId, createdAt: now(), expiresAt: now() + lockLeaseMs};
          const archived = ['completed', 'completed_with_failures', 'failed', 'canceled', 'needs_action', 'interrupted', 'stale'].includes(fresh.request.status)
            ? copy(fresh.request) : {...fresh.request, status: 'canceled', finishedAt: at, updatedAt: at};
          let ledger = project(fresh.ledger, archived, fresh.request);
          ledger = project(ledger, request, null);
          const archive = {...(fresh.archive || {}), requests: {...(fresh.archive?.requests || {}), [archived.id]: archived}};
          const next = {version: 1, originKind: 'local-v1', originId: proof.originId, originProof: proof,
            requestId: request.id, attemptId: request.attemptId, generation: 2, ownerDocumentId: c.documentId,
            ownerTabId: c.tabId, workerEpoch: old.workerEpoch, credentialFingerprint: proof.credentialFingerprint,
            phase: 'active', createdAt: at, updatedAt: at, agentId: proof.binding.agentId,
            platform: request.planSnapshot.platform, cloudCommandId: '',
            lockIdentity: root.OnStarvoiceActiveStopAuthority.lockIdentity(lock, request),
            pages: [], operations: [], activities: [], operationWatermark: 0, activityWatermark: 0,
            retainedTabs: [c.tabId], retired: [copy(old)], runnerQuiesced: false, pendingUploads: null, receipt: null};
          const strictControl = {version: 1, requestId: request.id, attemptId: request.attemptId,
            generation: 2, ownerDocumentId: c.documentId};
          noteWrite(effects, 'runner_claim', 'claimed', {originId: proof.originId,
            launchIntentId: l.id, requestId: request.id, attemptId: request.attemptId});
          return {patch: {journal: next, request, ledger, archive, lock,
            origin: {...fresh.origin, request: proof}, launch: {...fresh.launch, phase: 'claimed', updatedAt: at}},
            result: {ok: true, accepted: true, launchIntentId: l.id, strictControl,
              scopeMode: 'cooperative', data: request, lock, successorAllowed: true,
              retainedTabs: old.retainedTabs, resourcesReleased: false}};
        }, {reservation: true}));
    }
    async function handle(message, sender) {
      const effects = {};
      try {
        message = copy(message);
        const c = caller(sender);
        if (!c) return deny('local_caller_invalid');
        switch (message.type) {
          case SAVE: return await savePlan(message, c, effects);
          case PREFIX + 'prepare': return await prepare(message, c, effects);
          case PREFIX + 'runner-bind': return await bindRunner(message, c, effects);
          case PREFIX + 'runner-claim': return await claim(message, c, effects);
          default: return deny('local_control_unsupported');
        }
      } catch (error) {return failure(error, effects);}
    }
    return Object.freeze({handle, attachPort, maybeCreateOriginal,
      accepts: type => type === SAVE || (typeof type === 'string' && type.startsWith(PREFIX)),
    });
  }
  root.OnStarvoiceLocalRecovery = Object.freeze({CLIENT_PORT, RUNNER_PORT, SAVE, create});
})(globalThis);
