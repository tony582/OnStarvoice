// A per-owner capability, never a patch to the shared browser API. The
// background owns admission and document identity; caller-supplied IDs alone
// cannot grant a browser operation.
const CONTROL_KEYS = Object.freeze([
  'requestId', 'attemptId', 'generation', 'ownerDocumentId',
]);

export function parsePageOperationOwnerControl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getOwnPropertyDescriptor(value, 'version')?.value !== 1) return null;
  const control = {version: 1};
  for (const key of CONTROL_KEYS) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value')) return null;
    if (key === 'generation') {
      if (!Number.isSafeInteger(field.value) || field.value <= 0) return null;
    } else if (typeof field.value !== 'string' || !field.value ||
        field.value !== field.value.trim()) return null;
    control[key] = field.value;
  }
  return Object.freeze(control);
}

export function pageOperationOwnerControlMatches(left, right) {
  const a = parsePageOperationOwnerControl(left);
  const b = parsePageOperationOwnerControl(right);
  return Boolean(a && b && CONTROL_KEYS.every((key) => a[key] === b[key]));
}

function operationError(code, detail = '') {
  const error = new Error(detail || code);
  error.code = code;
  return error;
}

export function createPageOperationClient({
  strictControl,
  chromeApi = globalThis.chrome,
  relayType = 'RELAY_TO_CONTENT',
  createId = () => globalThis.crypto?.randomUUID?.() ||
    `operation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
} = {}) {
  const control = parsePageOperationOwnerControl(strictControl);
  if (!control || typeof chromeApi?.runtime?.sendMessage !== 'function') {
    throw operationError('strict_owner_control_required');
  }
  const send = (message) => chromeApi.runtime.sendMessage(message);
  let stopped = false;
  let disconnected = false;
  const pending = new Set();
  const unconfirmed = new Set();
  const retainedTabs = new Set();
  const ownedTabIds = new Set();
  let sourceTabId = null;
  let sourceBootstrapUrl = '';
  const listeners = new Set();
  let operationSeq = 0;
  let activitySeq = 0;
  let operationAdmissionTail = Promise.resolve();
  let activityAdmissionTail = Promise.resolve();

  function assertDispatchAllowed() {
    if (stopped || disconnected) throw operationError('capture_strict_stopped');
  }

  function track(promise) {
    const work = Promise.resolve(promise);
    pending.add(work);
    work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }

  async function settle(pageControl, outcome, operationSequence) {
    const response = await send({
      type: 'onstarvoice:strict-operation-settled',
      strictControl: control,
      pageControl,
      operationId: pageControl.operationId,
      operationSeq: operationSequence,
      outcome,
    });
    if (response?.ok !== true) throw operationError(
      response?.error?.code || 'strict_operation_settlement_unconfirmed',
    );
  }

  function operate(kind, tabId, payload, execute = null) {
    assertDispatchAllowed();
    const operationId = String(createId());
    const operationSequence = ++operationSeq;
    return track((async () => {
      let response;
      try {
        const admitted = operationAdmissionTail.then(() => {
          assertDispatchAllowed();
          return send({
            type: 'onstarvoice:strict-page-operation',
            strictControl: control,
            operationId,
            operationSeq: operationSequence,
            kind,
            tabId,
            payload,
          });
        });
        operationAdmissionTail = admitted.catch(() => undefined);
        response = await admitted;
      } catch (error) {
        if (error?.code !== 'capture_strict_stopped') unconfirmed.add(operationId);
        throw error;
      }
      if (response?.ok !== true || response?.accepted === false) throw operationError(
        response?.error?.code || 'strict_page_operation_rejected',
        response?.error?.message,
      );
      const grant = response.data || response;
      if (!execute) {
        if (grant.retained === true && Number.isSafeInteger(tabId)) {
          retainedTabs.add(tabId);
        }
        const result = Object.hasOwn(grant, 'result') ? grant.result : grant;
        const createdId = Number(kind === 'platform-source' ? result?.data?.tabId : result?.id);
        if (['platform-source', 'create'].includes(kind) && Number.isSafeInteger(createdId) && createdId > 0) {
          ownedTabIds.add(createdId);
          if (kind === 'platform-source') {
            const source = new URL(result?.data?.url);
            const host = {xiaohongshu: 'www.xiaohongshu.com', douyin: 'www.douyin.com'}[payload?.platform];
            if (!host || source.protocol !== 'https:' || source.hostname !== host || source.username || source.password) {
              unconfirmed.add(operationId);
              throw operationError('strict_source_url_unconfirmed');
            }
            sourceTabId = createdId;
            sourceBootstrapUrl = source.href;
          }
        }
        return result;
      }
      const pageControl = grant.pageControl;
      if (!pageOperationOwnerControlMatches(pageControl, control) ||
          pageControl.operationId !== operationId ||
          typeof pageControl.documentId !== 'string' || !pageControl.documentId ||
          typeof pageControl.activationId !== 'string' || !pageControl.activationId) {
        unconfirmed.add(operationId);
        throw operationError('strict_page_operation_grant_mismatch');
      }
      let outcome = 'rejected_before_dispatch';
      let result;
      let failure;
      try {
        // A stop arriving while admission was pending must not cause a late
        // native dispatch. The granted slot still receives a settled receipt.
        assertDispatchAllowed();
        outcome = 'dispatched';
        result = await execute(pageControl);
        outcome = 'fulfilled';
      } catch (error) {
        failure = error;
        if (outcome !== 'rejected_before_dispatch' || !stopped) outcome = 'rejected';
      }
      try {
        await settle(pageControl, outcome, operationSequence);
      } catch (error) {
        unconfirmed.add(operationId);
        if (!failure) failure = error;
      }
      if (failure) throw failure;
      return result;
    })());
  }

  function stop(expected, reason = 'stop_requested') {
    if (!pageOperationOwnerControlMatches(control, expected)) return false;
    stopped = true;
    for (const listener of listeners) listener(reason);
    return true;
  }

  async function drain() {
    // Snapshot loops include children admitted by an already running producer.
    // No Promise.race timeout can erase its underlying browser Promise.
    while (pending.size) await Promise.allSettled([...pending]);
    return Object.freeze({
      runnerQuiesced: pending.size === 0 && unconfirmed.size === 0 && !disconnected,
      pendingCount: pending.size,
      unconfirmedOperations: [...unconfirmed],
      retainedTabs: [...retainedTabs],
      stopped,
      disconnected,
    });
  }

  function runProducer(kind, callback) {
    assertDispatchAllowed();
    const activityId = String(createId());
    const activitySequence = ++activitySeq;
    return track((async () => {
      let begun;
      try {
        const admitted = activityAdmissionTail.then(() => {
          assertDispatchAllowed();
          return send({
            type: 'onstarvoice:strict-owner-activity-begin',
            strictControl: control,
            activityId,
            activitySeq: activitySequence,
            kind,
          });
        });
        activityAdmissionTail = admitted.catch(() => undefined);
        begun = await admitted;
      } catch (error) {
        if (error?.code !== 'capture_strict_stopped') unconfirmed.add(activityId);
        throw error;
      }
      if (begun?.ok !== true) throw operationError(
        begun?.error?.code || 'strict_owner_activity_rejected',
      );
      let failure;
      let result;
      try {
        assertDispatchAllowed();
        result = await callback();
      } catch (error) {
        failure = error;
      }
      try {
        const ended = await send({
          type: 'onstarvoice:strict-owner-activity-end',
          strictControl: control,
          activityId,
          activitySeq: activitySequence,
          outcome: failure ? 'rejected' : 'fulfilled',
        });
        if (ended?.ok !== true) throw operationError(
          ended?.error?.code || 'strict_owner_activity_settlement_unconfirmed',
        );
      } catch (error) {
        unconfirmed.add(activityId);
        if (!failure) failure = error;
      }
      if (failure) throw failure;
      return result;
    })());
  }

  const tabs = Object.create(null);
  if (typeof chromeApi.tabs?.get === 'function') {
    tabs.get = (...args) => track(chromeApi.tabs.get(...args));
  }
  tabs.query = (query = {}) => track((async () => {
    // Existing helpers ask for an active/current-window tab. In this private
    // capability that means this cohort's source, never a user's active page.
    // IDs originate only from completed background create/source operations.
    const ids = query.active === true
      ? sourceTabId === null ? [] : [sourceTabId] : [...ownedTabIds];
    const results = await Promise.all(ids.map(id => chromeApi.tabs.get(id).catch(() => null)));
    return results.filter(tab => tab && ownedTabIds.has(Number(tab.id)) &&
      (query.windowId === undefined || Number(tab.windowId) === Number(query.windowId)));
  })());
  for (const name of ['onReplaced', 'onRemoved', 'onUpdated']) {
    if (chromeApi.tabs?.[name]) tabs[name] = chromeApi.tabs[name];
  }
  tabs.create = (properties) => {
    if (properties?.url === 'about:blank') {
      if (!sourceBootstrapUrl) throw operationError('strict_source_bootstrap_required');
      // The old helper's blank bootstrap has no content document to cooperate.
      // Only this explicit scope starts a dedicated page on its verified source
      // URL; all following navigation still uses exact-document admission.
      return operate('create', null, {...properties, url: sourceBootstrapUrl});
    }
    return operate('create', null, properties);
  };
  tabs.update = (tabId, properties) => operate(
    properties?.url ? 'navigate' : 'focus', Number(tabId), properties,
  );
  tabs.remove = async (tabId) => {
    // A function returning undefined would look like tabs.remove success to
    // legacy worker cleanup. Retention is deliberately a failed close, so its
    // existing finally/reporting path cannot claim the resource was released.
    let result;
    try { result = await operate('remove', Number(tabId), {}); }
    catch (error) { retainedTabs.add(Number(tabId)); throw error; }
    if (result?.removed !== true) {
      retainedTabs.add(Number(tabId));
      throw operationError('strict_owned_tab_retained');
    }
  };
  const localStorage = Object.create(null);
  for (const name of ['get', 'set', 'remove', 'getBytesInUse']) {
    if (typeof chromeApi.storage?.local?.[name] === 'function') {
      // These are existing persistence/closure capabilities, not collection
      // admission. A stop cannot strand a save halfway through its checkpoint.
      // Observe the real storage Promise and preserve the original receiver.
      localStorage[name] = (...args) => track(chromeApi.storage.local[name](...args));
    }
  }
  const scopedChrome = Object.freeze({
    tabs: Object.freeze(tabs),
    storage: Object.freeze({local: Object.freeze(localStorage)}),
    runtime: Object.freeze({
      ...(typeof chromeApi.runtime.getURL === 'function'
        ? {getURL: (...args) => chromeApi.runtime.getURL(...args)} : {}),
      sendMessage: (message) => {
        if (message?.type === 'onstarvoice:switch-platform-tab') {
          return operate('platform-source', null, {platform: message.platform});
        }
        if (message?.type === relayType ||
            (Number.isSafeInteger(Number(message?.tabId)) && message?.payload?.action)) {
          return operate('relay', Number(message.tabId), message.payload);
        }
        // Lifecycle/progress messages carry the explicit owner identity too;
        // they do not derive authority from a mutable global task context.
        return track(send({...message, strictControl: control}));
      },
    }),
    scripting: Object.freeze({
      executeScript: (details = {}) => operate(
        'executeScript', Number(details.target?.tabId), {
          world: details.world || 'ISOLATED',
          target: details.target,
          hasFunc: typeof details.func === 'function',
          files: details.files,
        }, (pageControl) => chromeApi.scripting.executeScript({
          ...details,
          target: {tabId: Number(details.target?.tabId),
            documentIds: [pageControl.documentId]},
        }),
      ),
    }),
    windows: Object.freeze({
      update: () => Promise.reject(operationError('strict_window_focus_unsupported')),
    }),
  });

  return Object.freeze({
    strictControl: control,
    chromeApi: scopedChrome,
    operate,
    runProducer,
    track,
    stop,
    drain,
    shouldStop: () => stopped || disconnected,
    markDisconnected() { disconnected = true; stopped = true; },
    subscribeStop(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
