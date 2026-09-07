// Cooperative strict stop orchestration. Browser/network waits never hold Q.
// A missing receipt remains pending; timeout is not a quiescence proof.
(function install(root) {
  'use strict';
  const PORT = 'onstarvoice:strict-capture-owner-v1';
  const PREFIX = 'onstarvoice:strict-';
  const PREPARE = 'onstarvoice:prepare-active-capture-stop';
  const EXECUTE = 'onstarvoice:execute-active-capture-stop';
  const INSPECT = 'onstarvoice:inspect-active-capture-stop';
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 320 && value.trim() === value;
  const scopeOf = j => ({version: 1, requestId: j.requestId, attemptId: j.attemptId,
    generation: j.generation, ownerDocumentId: j.ownerDocumentId});
  const deny = reason => ({ok: false, accepted: false, reason, sourceStopped: false});
  function create(ports) {
    const {journal, authority, extensionId, workerEpoch, resolveDocument, sendPage,
      createTab, admitWhileLegacyIdle, now = Date.now, randomId = () => root.crypto.randomUUID(),
      pause = ms => new Promise(resolve => root.setTimeout(resolve, ms))} = ports;
    const api = root.OnStarvoiceActiveStopAuthority;
    const localSource = ports.localSource;
    const candidate = (state, options) => localSource && state.origin?.request?.requestId === state.request?.id
      ? localSource.candidate(state, options) : api.candidate(state, options);
    const evaluate = (current, action) => current.local ? localSource.evaluate(current, action) : authority.evaluate(current);
    const stopAction = j => j?.originKind === 'local-v1' ? 'stop_local_capture' : api.ACTION;
    const sameScope = root.OnStarvoiceStopJournal.sameScope;
    const valid = root.OnStarvoiceStopJournal.valid;
    const connections = new Map(), handles = new Map(), inflight = new Map();
    const pageAdmissions = new Map(), pageRefreshes = new Map();
    let dispatchTail = Promise.resolve();
    function dispatchGate(operation) {
      const work = dispatchTail.then(operation, operation);
      dispatchTail = work.catch(() => {});
      return work;
    }
    const owns = (j, scope) => valid(j) && sameScope(j, scope) && j.workerEpoch === workerEpoch;
    function caller(sender) {
      try {
        const url = new URL(sender?.url);
        if (sender?.id !== extensionId || url.protocol !== 'chrome-extension:' || url.host !== extensionId || url.username || url.password ||
            url.pathname !== '/sidebar/sidebar.html' || !id(sender.documentId) ||
            sender.documentLifecycle !== 'active' || (sender.frameId != null && sender.frameId !== 0)) return null;
        return {documentId: sender.documentId, url: url.href, tabId: sender.tab?.id ?? null};
      } catch { return null; }
    }
    const connected = c => !!c && connections.get(c.documentId)?.sender?.url === c.url;
    async function quarantine(reason) {
      const result = await dispatchGate(() => journal.transact(({journal: j}) => {
        if (!valid(j)) return {result: false};
        return {next: {...j, phase: 'quarantined', reason}, result: true};
      }));
      if (result) void signalStop().catch(() => {});
      return result;
    }
    function attachPort(port, localHandoff = false) {
      if (port?.name !== PORT && !(localHandoff && port?.name === 'onstarvoice:local-recovery-runner-v1')) return false;
      const c = caller(port.sender);
      if (!c || connections.size >= 32) {port.disconnect?.(); return true;}
      const old = connections.get(c.documentId);
      connections.set(c.documentId, port);
      if (old && old !== port) {
        for (const [key, entry] of handles) if (entry.caller === c.documentId) handles.delete(key);
        void quarantine('owner_connection_replaced').catch(() => {});
      }
      port.onDisconnect.addListener(() => {
        if (connections.get(c.documentId) !== port) return;
        connections.delete(c.documentId);
        void journal.read().then(state => {
          if (state.journal?.ownerDocumentId === c.documentId && !state.journal.ownerReleased) return stopLocally('owner_disconnected');
        }).catch(() => {});
      });
      return true;
    }
    function sameLiveSource(state, j) {
      const r = state.request;
      let lock;
      try {lock = api.lockIdentity(state.lock, r);} catch {return false;}
      if (j.originKind === 'local-v1') return !!localSource && localSource.matches(state, j) &&
        state.auth && api.canonical(state.auth) === j.authWitness &&
        api.canonical(lock) === api.canonical(j.lockIdentity) &&
        (!state.ledger?.clearedAt || Date.parse(state.ledger.clearedAt) < Date.parse(j.createdAt));
      const rows = state.ledger?.runs?.filter(row => row?.id === j.requestId);
      if (rows?.length !== 1 || rows[0].attemptId !== j.attemptId || rows[0].updatedAt !== r?.updatedAt ||
          rows[0].status !== r?.status || rows[0].metadata?.cloudCommandId !== j.cloudCommandId ||
          rows[0].metadata?.cloudAgentScopeId !== j.agentId ||
          (state.archive && (!state.archive.requests || Object.values(state.archive.requests).some(row => row?.id === j.requestId))) ||
          r?.cloudAssigned !== true || r?.planSnapshot?.platform !== j.platform || r?.orchestrationContext ||
          r?.parentRequestId || r?.previousAttemptId || r?.recoveryPendingLaunch === true || r?.recoveryAdoptionReceipt) return false;
      return r && r.id === j.requestId && r.attemptId === j.attemptId &&
        r.cloudCommandId === j.cloudCommandId && r.cloudAgentScopeId === j.agentId &&
        state.auth && api.canonical(state.auth) === j.authWitness &&
        api.canonical(lock) === api.canonical(j.lockIdentity) &&
        (!state.ledger?.clearedAt || Date.parse(state.ledger.clearedAt) < Date.parse(j.createdAt));
    }
    function producerSourceCurrent(state, j) {
      try {
        const current = candidate(state);
        return sameLiveSource(state, j) && current.source.platform === j.platform &&
          Number.isFinite(state.lock.expiresAt) && state.lock.expiresAt > now();
      } catch {return false;}
    }
    // authWitness is kept only in memory. Never persist bearer tokens.
    const authWitnesses = new Map();
    const originWitnesses = new Map();
    function witness(j) { return {...j, authWitness: authWitnesses.get(j.generation), originWitness: originWitnesses.get(j.generation)}; }
    async function bind(message, c) {
      if (!connected(c) || !id(message.requestId) || !id(message.attemptId)) return deny('strict_owner_unavailable');
      const state = await journal.read();
      if (state.journal) return deny('strict_generation_already_retained');
      const current = candidate(state, {allowReservation: true});
      if (current.source.clientTaskId !== message.requestId || current.source.clientAttemptId !== message.attemptId ||
          state.lock.holderDocumentId !== c.documentId || !Number.isFinite(state.lock.expiresAt) ||
          state.lock.expiresAt <= now() || !Number.isSafeInteger(c.tabId) || c.tabId <= 0 ||
          state.request.runnerTabId !== c.tabId) return deny('strict_owner_mismatch');
      const credentialFingerprint = await api.credentialFingerprint(current.auth);
      const evaluation = await evaluate(current, 'start_local_capture');
      const generation = 1;
      const boundLock = {...state.lock, captureTaskId: `unattended-capture:${message.requestId}`,
        captureTaskAttemptId: message.attemptId};
      const j = {version: 1, requestId: message.requestId, attemptId: message.attemptId,
        generation, ownerDocumentId: c.documentId, workerEpoch, credentialFingerprint,
        phase: 'active', createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(),
        cloudCommandId: current.source.cloudCommandId, agentId: current.auth.captureAgent.id,
        platform: current.source.platform, source: current.source, lockIdentity: api.lockIdentity(boundLock, state.request),
        ...(current.local ? {originKind: 'local-v1', originId: current.proof.originId, originProof: copy(current.proof)} : {}),
        pages: [], operations: [], activities: [], operationWatermark: 0, activityWatermark: 0,
        retainedTabs: [c.tabId], ownerTabId: c.tabId,
        runnerQuiesced: false, pendingUploads: null, receipt: null};
      if (typeof admitWhileLegacyIdle !== 'function') return deny('strict_legacy_admission_unavailable');
      // storage.onChanged can run before storage.set's promise continuation.
      // Install the private witness before publication so our own atomic bind
      // cannot be mistaken for an unauthenticated post-restart generation.
      authWitnesses.set(generation, api.canonical(current.auth));
      if (current.local) originWitnesses.set(generation, api.canonical(current.proof));
      const result = await admitWhileLegacyIdle(() => journal.transact(fresh => {
        if (fresh.journal || !connected(c) || now() >= evaluation.deadline ||
            api.canonical(fresh.auth) !== api.canonical(current.auth) ||
            candidate(fresh, {allowReservation: true}).fingerprint !== current.fingerprint ||
            fresh.lock.expiresAt <= now()) return {result: deny('strict_source_changed')};
        return {next: j, ...(!fresh.lock.captureTaskId ? {bindLock: {...fresh.lock,
          captureTaskId: boundLock.captureTaskId, captureTaskAttemptId: boundLock.captureTaskAttemptId}} : {}),
          result: {ok: true, accepted: true, strictControl: scopeOf(j),
            scopeMode: 'cooperative', data: {strictControl: scopeOf(j), scopeMode: 'cooperative'}}};
      }, {bindReservation: true}));
      if (result?.ok) authWitnesses.set(generation, api.canonical(current.auth));
      return result;
    }
    async function mutateOwner(message, c, change, {allowStopped = false} = {}) {
      return journal.transact(state => {
        const j = state.journal;
        if (!connected(c) || !owns(j, message.strictControl) || c.documentId !== j.ownerDocumentId ||
            !sameLiveSource(state, witness(j)) || (!allowStopped &&
              (j.phase !== 'active' || !producerSourceCurrent(state, witness(j))))) {
          return {result: deny('strict_owner_or_source_changed')};
        }
        return change(j, state);
      });
    }
    async function beginOperation(message, c) {
      if (!id(message.operationId) || !['relay', 'executeScript', 'navigate', 'create', 'platform-source', 'remove', 'focus'].includes(message.kind)) {
        return deny('strict_operation_invalid');
      }
      const accepted = await mutateOwner(message, c, j => {
        if (!Number.isSafeInteger(message.operationSeq) || message.operationSeq <= j.operationWatermark ||
            j.operations.length >= 256 || j.operations.some(op => op.operationId === message.operationId)) {
          return {result: deny('strict_operation_replayed')};
        }
        const op = {operationId: message.operationId, operationSeq: message.operationSeq,
          kind: message.kind, tabId: message.tabId ?? null, state: 'pending'};
        return {next: {...j, operations: [...j.operations, op], operationWatermark: message.operationSeq}, result: {ok: true, journal: j}};
      });
      if (!accepted?.ok) return accepted;
      const work = performOperation(message, c, accepted.journal);
      inflight.set(message.operationId, work);
      try { return await work; }
      finally {inflight.delete(message.operationId);}
    }
    function expectedPage(j, page, operationId) {
      return {...scopeOf(j), documentId: page.documentId, activationId: page.activationId, operationId};
    }
    function pageReceipt(response, expected) {
      const s = response?.pageControl;
      return response?.ok === true && s && sameScope(s.scope, expected) &&
        s.scope.documentId === expected.documentId && s.scope.activationId === expected.activationId &&
        typeof s.quiesced === 'boolean' && Number.isSafeInteger(s.activeCount) && s.activeCount >= 0 ? s : null;
    }
    async function ensurePage(message, c, j) {
      const key = `${j.generation}:${message.tabId}`;
      const previous = pageAdmissions.get(key) || Promise.resolve();
      const work = previous.catch(() => {}).then(() => admitPage(message, c, j));
      pageAdmissions.set(key, work);
      try {return await work;} finally {if (pageAdmissions.get(key) === work) pageAdmissions.delete(key);}
    }
    async function admitPage(message, c, j) {
      if (!Number.isSafeInteger(message.tabId) || message.tabId <= 0) throw new Error('strict_tab_invalid');
      const owned = (await journal.read()).journal;
      if (!owns(owned, message.strictControl) || !(owned.retainedTabs || []).includes(message.tabId)) {
        throw new Error('strict_tab_not_owned');
      }
      const doc = await resolveDocument(message.tabId);
      if (!id(doc?.documentId)) throw new Error('strict_document_unavailable');
      let page = (await journal.read()).journal?.pages?.find(p => p.tabId === message.tabId && p.documentId === doc.documentId);
      if (page) return page;
      const before = await mutateOwner(message, c, current => ({result: {ok: current.pages.length < 64}}));
      if (!before?.ok) throw new Error('strict_page_admission_denied');
      const response = await sendPage(message.tabId, {action: 'onstarvoice:page-control-handshake',
        pageControl: {...scopeOf(j), documentId: doc.documentId}}, doc.documentId);
      const snapshot = response?.pageControl;
      if (response?.ok !== true || !snapshot?.strict || !sameScope(snapshot.scope, j) ||
          snapshot.scope.documentId !== doc.documentId || !id(snapshot.scope.activationId) ||
          snapshot.stopped !== false || snapshot.activeCount !== 0) throw new Error('strict_page_handshake_failed');
      page = {tabId: message.tabId, documentId: doc.documentId, activationId: snapshot.scope.activationId,
        quiesced: false, stopped: false, retained: true};
      // Once the handshake occurred, persist its identity even when stop won.
      const stored = await journal.transact(({journal: current}) => {
        if (!owns(current, message.strictControl)) return {result: deny('strict_scope_changed')};
        return {next: {...current, pages: [...current.pages, page]}, result: {ok: current.phase === 'active'}};
      });
      if (!stored?.ok) {
        // Admission raced stop after a real handshake. Cancel exact document;
        // never erase its evidence or let a failure imply no side effect.
        await sendPage(page.tabId, {action: 'onstarvoice:page-control-stop',
          pageControl: expectedPage(j, page, randomId())}, page.documentId).catch(() => null);
        throw new Error('strict_page_admission_raced_stop');
      }
      return page;
    }
    async function finishOperation(operationId, {page = null, receipt = null, failure = ''} = {}) {
      return journal.transact(({journal: j}) => {
        if (!valid(j) || j.workerEpoch !== workerEpoch) return {result: deny('strict_worker_changed')};
        const op = j.operations.find(item => item.operationId === operationId);
        if (!op || op.state !== 'pending') return {result: deny('strict_operation_replayed')};
        const operations = failure ? j.operations.map(item => item === op ? {...item, state: 'unknown', reason: failure} : item)
          : j.operations.filter(item => item !== op);
        const pages = page ? j.pages.map(item => item.documentId === page.documentId ? {...item,
          quiesced: receipt?.quiesced === true, stopped: receipt?.stopped === true} : item) : j.pages;
        return {next: {...j, operations, pages, ...(failure ? {phase: 'quarantined', reason: failure} : {})},
          result: {ok: !failure, accepted: !failure, operationId, reason: failure}};
      }).then(result => {
        if (failure) void signalStop().catch(() => {});
        return result;
      });
    }
    async function performOperation(message, c, j) {
      let page = null;
      try {
        if (message.kind === 'create' || message.kind === 'platform-source') {
          const platformUrls = {xiaohongshu: 'https://www.xiaohongshu.com/explore', douyin: 'https://www.douyin.com/'};
          const payload = message.kind === 'platform-source' ? {url: platformUrls[message.payload?.platform]} : message.payload;
          const url = new URL(payload?.url);
          if (url.protocol !== 'https:' || !['www.xiaohongshu.com', 'www.douyin.com', 'v.douyin.com'].includes(url.hostname) ||
              url.username || url.password) throw new Error('strict_url_invalid');
          const allowed = await mutateOwner(message, c, () => ({result: {ok: true}}));
          if (!allowed?.ok) throw new Error('strict_stopped_before_create');
          const result = await startEffect(message, c, () => createTab({...payload, active: false}));
          // Newly created tabs are retained even if stop interleaved. No
          // tab-only compensating close is authorized by a failed request.
          await journal.transact(({journal: current}) => ({next: {...current,
            retainedTabs: [...new Set([...(current.retainedTabs || []), result.id])]}, result: true}));
          await finishOperation(message.operationId);
          const after = await journal.read();
          if (!owns(after.journal, message.strictControl) || after.journal.phase !== 'active') return deny('strict_stopped_after_create');
          return {ok: true, accepted: true, result: message.kind === 'platform-source'
            ? {ok: true, data: {tabId: result.id, url: result.url || url.href, platform: message.payload.platform}} : result,
            operationId: message.operationId};
        }
        if (message.kind === 'remove' || message.kind === 'focus') {
          await finishOperation(message.operationId);
          return {ok: true, accepted: true, operationId: message.operationId,
            result: message.kind === 'remove' ? {removed: false, retained: true} : {keptBackground: true}};
        }
        page = await ensurePage(message, c, j);
        const envelope = expectedPage(j, page, message.operationId);
        const allowed = await mutateOwner(message, c, () => ({result: {ok: true}}));
        if (!allowed?.ok) throw new Error('strict_stopped_before_dispatch');
        if (message.kind === 'executeScript') {
          const response = await startEffect(message, c, () => sendPage(page.tabId,
            {action: 'onstarvoice:page-control-reserve', pageControl: envelope}, page.documentId));
          if (!pageReceipt(response, envelope)) throw new Error('strict_external_reservation_failed');
          return {ok: true, accepted: true, operationId: message.operationId,
            documentId: page.documentId, activationId: page.activationId, pageControl: envelope};
        }
        const payload = message.kind === 'navigate'
          ? {action: 'onstarvoice:page-control-navigate', payload: {url: message.payload?.url}}
          : message.payload;
        if (!payload || typeof payload.action !== 'string') throw new Error('strict_payload_invalid');
        const result = await startEffect(message, c,
          () => sendPage(page.tabId, {...payload, pageControl: envelope}, page.documentId));
        if (message.kind === 'navigate') {
          const oldReceipt = pageReceipt(result, envelope);
          if (result?.navigationDispatched !== true || !oldReceipt?.quiesced || !oldReceipt.stopped) {
            throw new Error('strict_navigation_retirement_unconfirmed');
          }
          // A page's own idle->frozen acknowledgement proves no producer can
          // revive there, even in BFCache. A different browser document alone
          // would NOT prove that the previous page was destroyed/quiescent.
          await journal.transact(({journal: current}) => ({next: {...current,
            pages: current.pages.filter(p => p.documentId !== page.documentId)}, result: true}));
          const deadline = now() + 15000;
          let nextDoc;
          while (now() < deadline) {
            nextDoc = await resolveDocument(page.tabId).catch(() => null);
            if (nextDoc?.documentId && nextDoc.documentId !== page.documentId) break;
            if (!await portsStillActive(message, c)) throw new Error('strict_stopped_during_navigation');
            await pause(100);
          }
          if (!nextDoc?.documentId || nextDoc.documentId === page.documentId) throw new Error('strict_navigation_document_pending');
          const nextPage = await ensurePage(message, c, j);
          await finishOperation(message.operationId);
          return {ok: true, accepted: true, operationId: message.operationId,
            result: {id: page.tabId, url: message.payload.url, documentId: nextPage.documentId}};
        }
        const inspected = await sendPage(page.tabId, {action: 'onstarvoice:page-control-inspect', pageControl: envelope}, page.documentId);
        const receipt = pageReceipt(inspected, envelope);
        if (!receipt) throw new Error('strict_page_receipt_missing');
        await finishOperation(message.operationId, {page, receipt});
        return {ok: true, accepted: true, operationId: message.operationId, documentId: page.documentId,
          activationId: page.activationId, pageControl: envelope, result: {ok: true, data: result}};
      } catch (error) {
        await finishOperation(message.operationId, {page, failure: String(error?.message || 'strict_operation_unknown')}).catch(() => {});
        return deny(String(error?.message || 'strict_operation_unknown'));
      }
    }
    async function startEffect(message, c, start) {
      const ticket = await dispatchGate(async () => {
        const permitted = await mutateOwner(message, c, () => ({result: {ok: true}}));
        if (!permitted?.ok) throw new Error('strict_stopped_before_dispatch');
        // Q has been released. Start synchronously in the same dispatch gate
        // used by stop's CAS, then release it without awaiting browser I/O.
        // Already-issued external grants stay counted until their real receipt.
        return {pending: start()};
      });
      return ticket.pending;
    }
    async function portsStillActive(message, c) {
      return (await mutateOwner(message, c, () => ({result: {ok: true}})))?.ok === true;
    }
    async function settleExternal(message, c) {
      const state = await journal.read(), j = state.journal;
      if (!connected(c) || !owns(j, message.strictControl) || c.documentId !== j.ownerDocumentId) return deny('strict_owner_mismatch');
      const op = j.operations.find(item => item.operationId === message.operationId && item.state === 'pending' && item.kind === 'executeScript');
      const page = j.pages.find(item => item.documentId === message.pageControl?.documentId);
      if (!op || !page || page.tabId !== op.tabId ||
          api.canonical(message.pageControl) !== api.canonical(expectedPage(j, page, op.operationId))) return deny('strict_operation_mismatch');
      const response = await sendPage(page.tabId, {action: 'onstarvoice:page-control-settle',
        pageControl: message.pageControl}, page.documentId);
      const receipt = pageReceipt(response, message.pageControl);
      return finishOperation(op.operationId, {page, receipt, failure: receipt ? '' : 'strict_external_receipt_missing'});
    }
    async function ownerActivity(message, c, start) {
      if (!id(message.activityId)) return deny('strict_activity_invalid');
      return mutateOwner(message, c, j => {
        const exists = j.activities.find(item => item.activityId === message.activityId);
        if (start && (exists || j.activities.length >= 64 || !Number.isSafeInteger(message.activitySeq) ||
            message.activitySeq <= j.activityWatermark)) return {result: deny('strict_activity_replayed')};
        if (!start && (!exists || exists.state !== 'pending')) return {result: deny('strict_activity_missing')};
        const activities = start ? [...j.activities, {activityId: message.activityId, activitySeq: message.activitySeq, state: 'pending'}]
          : j.activities.filter(item => item !== exists);
        return {next: {...j, activities, ...(start ? {activityWatermark: message.activitySeq, runnerQuiesced: false} : {})},
          result: {ok: true, accepted: true}};
      }, {allowStopped: !start});
    }
    async function ownerSettled(message, c, release = false) {
      const result = await mutateOwner(message, c, j => {
        if (message.runnerQuiesced !== true || j.activities.some(item => item.state !== 'settled')) {
          return {result: deny('strict_runner_pending')};
        }
        const pendingUploads = Number.isSafeInteger(message.pendingUploads) && message.pendingUploads >= 0 ? message.pendingUploads : null;
        return {next: {...j, runnerQuiesced: true, pendingUploads, ...(release ? {ownerReleased: true,
          phase: j.phase === 'active' ? 'stop_requested' : j.phase} : {})}, result: {ok: true, accepted: true}};
      }, {allowStopped: true});
      if (release && result?.ok) void signalStop().catch(() => {});
      return result;
    }
    async function prepare(message, c) {
      if (!connected(c)) return deny('strict_caller_invalid');
      const state = await journal.read(), j = state.journal;
      if (message.action !== stopAction(j)) return deny('strict_caller_invalid');
      if (!valid(j) || j.workerEpoch !== workerEpoch || j.phase !== 'active') return deny('strict_cohort_unavailable');
      const current = candidate(state);
      if (!sameLiveSource(state, witness(j))) return deny('strict_source_changed');
      const evaluation = await evaluate(current, stopAction(j));
      if (!connected(c)) return deny('strict_caller_changed');
      for (const [key, entry] of handles) if (entry.deadline <= now()) handles.delete(key);
      if (handles.size >= 64) return deny('strict_handle_capacity');
      const handle = randomId();
      handles.set(handle, {caller: c.documentId, connection: connections.get(c.documentId), source: current, generation: j.generation,
        action: stopAction(j), deadline: evaluation.deadline, used: false});
      return {ok: true, accepted: true, action: stopAction(j), handle, expiresAt: new Date(evaluation.deadline).toISOString()};
    }
    async function execute(message, c) {
      const entry = handles.get(message.handle);
      if (!connected(c) || !entry || message.action !== entry.action || entry.caller !== c.documentId ||
          entry.connection !== connections.get(c.documentId) || entry.used || now() >= entry.deadline) return deny('strict_handle_invalid');
      entry.used = true;
      const current = candidate(await journal.read());
      if (api.canonical(current.auth) !== api.canonical(entry.source.auth) || current.fingerprint !== entry.source.fingerprint) return deny('strict_source_changed');
      const evaluation = await evaluate(current, entry.action);
      const deadline = Math.min(entry.deadline, evaluation.deadline);
      const result = await dispatchGate(() => journal.transact(state => {
        const j = state.journal;
        if (!valid(j) || j.workerEpoch !== workerEpoch || j.generation !== entry.generation ||
            j.phase !== 'active' || !connected(c) || now() >= deadline ||
            api.canonical(state.auth) !== api.canonical(current.auth) || candidate(state).fingerprint !== current.fingerprint) {
          return {result: deny('strict_source_changed')};
        }
        return {next: {...j, phase: 'stop_requested', stopId: randomId(), stopRequestedAt: new Date(now()).toISOString(),
          stopSource: current.source, authorityRevision: evaluation.authority.authorityRevision}, result: {ok: true}};
      }));
      if (!result?.ok) return result;
      void signalStop().catch(() => {});
      return {ok: true, accepted: true, action: entry.action, phase: 'stop_requested',
        sourceStopped: false, resourcesReleased: false, successorAllowed: false};
    }
    async function signalStop() {
      const {journal: j} = await journal.read();
      if (!valid(j) || j.phase === 'active') return;
      const port = connections.get(j.ownerDocumentId);
      try {port?.postMessage({type: 'capture-owner:strict-stop', strictControl: scopeOf(j)});} catch {}
      await Promise.allSettled(j.pages.map(async page => {
        const envelope = expectedPage(j, page, randomId());
        const response = await sendPage(page.tabId, {action: 'onstarvoice:page-control-stop', pageControl: envelope}, page.documentId);
        const receipt = pageReceipt(response, envelope);
        await journal.transact(({journal: current}) => {
          if (!valid(current) || !sameScope(current, j)) return {result: false};
          return {next: {...current, pages: current.pages.map(p => p.documentId === page.documentId ? {...p,
            stopped: receipt?.stopped === true, quiesced: receipt?.quiesced === true} : p)}, result: true};
        });
      }));
    }
    async function stopLocally(reason) {
      // Fail-safe lifecycle stop, not a new UI command grant. A disconnected
      // owner cannot leave its previously admitted cohort free to produce.
      await quarantine(reason);
    }
    async function inspect(message, c) {
      if (!connected(c)) return deny('strict_caller_invalid');
      const state = await journal.read(), j = state.journal;
      if (!valid(j) || j.workerEpoch !== workerEpoch || !sameLiveSource(state, witness(j))) return deny('strict_source_changed');
      if (j.phase === 'active') return {ok: true, accepted: true, phase: 'active', sourceStopped: false};
      for (const page of j.pages) {
        const key = `${j.generation}:${page.documentId}`;
        if (pageRefreshes.has(key)) continue;
        const refresh = (async () => {
        const expected = expectedPage(j, page, randomId());
        const response = await sendPage(page.tabId, {action: 'onstarvoice:page-control-inspect', pageControl: expected}, page.documentId);
        const receipt = pageReceipt(response, expected);
        await journal.transact(({journal: current}) => {
          if (!valid(current) || !sameScope(current, j)) return {result: false};
          return {next: {...current, pages: current.pages.map(p => p.documentId === page.documentId ? {...p,
            stopped: receipt?.stopped === true, quiesced: receipt?.quiesced === true} : p)}, result: true};
        });
        })();
        pageRefreshes.set(key, refresh);
        void refresh.catch(() => {}).finally(() => pageRefreshes.delete(key));
      }
      return journal.transact(fresh => {
        const current = fresh.journal;
        if (!valid(current) || !sameScope(current, j) || !sameLiveSource(fresh, witness(current))) return {result: deny('strict_source_changed')};
        const pending = current.operations.some(op => op.state !== 'settled') || current.activities.some(op => op.state !== 'settled');
        const pageStopped = current.pages.every(page => page.stopped && page.quiesced);
        const sourceStopped = current.runnerQuiesced === true && pageStopped && !pending && current.phase !== 'quarantined';
        const retainedTabs = [...new Set([...(current.retainedTabs || []), ...current.pages.map(page => page.tabId)])];
        const receipt = {ok: true, accepted: true, action: stopAction(current), requestId: current.requestId,
          attemptId: current.attemptId, generation: current.generation, sourceStopped,
          runnerQuiesced: current.runnerQuiesced === true, pendingUploads: current.pendingUploads,
          resourcesReleased: false, successorAllowed: false, retainedTabs,
          manualActionRequired: true, mainWorldCooperative: true,
          phase: sourceStopped ? 'stopped' : current.phase === 'quarantined' ? 'quarantined' : 'draining'};
        return {next: {...current, phase: receipt.phase, receipt}, result: receipt};
      });
    }
    async function handle(message, sender) {
      const c = caller(sender);
      if (!c) return deny('strict_caller_invalid');
      try {
        switch (message.type) {
          case PREFIX + 'owner-bind': return await bind(message, c);
          case PREFIX + 'owner-activity-begin': return await ownerActivity(message, c, true);
          case PREFIX + 'owner-activity-end': return await ownerActivity(message, c, false);
          case PREFIX + 'owner-settled': return await ownerSettled(message, c);
          case PREFIX + 'owner-release': return await ownerSettled(message, c, true);
          case PREFIX + 'page-operation': return await beginOperation(message, c);
          case PREFIX + 'operation-settled': return await settleExternal(message, c);
          case PREPARE: return await prepare(message, c);
          case EXECUTE: return await execute(message, c);
          case INSPECT: return await inspect(message, c);
          default: return deny('strict_message_unsupported');
        }
      } catch (error) {return deny(String(error?.message || 'strict_control_failed'));}
    }
    return Object.freeze({handle, attachPort, stopLocally, localJournal: journal,
      // Private background-only handoff ports, never selected by a renderer
      // message. Exact authorization and storage CAS belong to local recovery.
      async localRecoverySource() {
        const state = await journal.read(), j = state.journal;
        if (!valid(j) || j.originKind !== 'local-v1' || j.workerEpoch !== workerEpoch ||
            !sameLiveSource(state, witness(j))) throw new Error('local_stop_witness_unavailable');
        return state;
      },
      async adoptLocalSuccessor({auth, proof, generation, port}, commit) {
        if (generation !== 2 || !caller(port?.sender) || !localSource) throw new Error('local_handoff_invalid');
        if (!attachPort(port, true)) throw new Error('local_owner_connection_invalid');
        authWitnesses.set(generation, api.canonical(auth));
        originWitnesses.set(generation, api.canonical(proof));
        return dispatchGate(commit);
      },
      async reconcileWitness() {
        const state = await journal.read();
        if (valid(state.journal) && (state.journal.workerEpoch !== workerEpoch ||
            !sameLiveSource(state, witness(state.journal)) || (state.journal.phase === 'active' &&
              !producerSourceCurrent(state, witness(state.journal))))) await stopLocally('strict_runtime_or_source_changed');
      },
      accepts: type => typeof type === 'string' && (type.startsWith(PREFIX) || [PREPARE, EXECUTE, INSPECT].includes(type)),
      guardLegacy: () => journal.guard(),
      async guardScope(scope, sender, {allowStopped = false} = {}) {
        const c = caller(sender), state = await journal.read();
        return connected(c) && owns(state.journal, scope) && c.documentId === state.journal.ownerDocumentId &&
          sameLiveSource(state, witness(state.journal)) && (allowStopped ||
            (state.journal.phase === 'active' && producerSourceCurrent(state, witness(state.journal))));
      },
    });
  }
  root.OnStarvoiceStrictCaptureControl = Object.freeze({PORT, PREPARE, EXECUTE, INSPECT, create});
})(globalThis);
