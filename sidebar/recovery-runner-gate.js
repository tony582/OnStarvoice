import {parsePageOperationOwnerControl, pageOperationOwnerControlMatches} from '../utils/capture/page-operation-client.js';

const PORT = 'onstarvoice:local-recovery-runner-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const handoffs = new WeakMap();
let documentGate = null;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// This module owns one dormant-shell connection, not a second task executor.
// URL values locate a reservation; only the background's one-shot claim grants
// execution. Both legacy bootstraps await exactly the same document Promise.
export function createLocalRecoveryRunnerGate({
  location = globalThis.location,
  chromeApi = globalThis.chrome,
  lifecycle = globalThis.window,
} = {}) {
  const query = new URLSearchParams(String(location?.search || ''));
  const isRecoveryRunner = query.has('localRecoveryIntent');
  if (!isRecoveryRunner) return Object.freeze({
    isRecoveryRunner: false,
    waitForActivation: () => null,
    assertActive() {},
  });

  const launchIntentId = query.get('localRecoveryIntent');
  const requestId = query.get('unattendedRun');
  const attemptId = query.get('unattendedAttempt');
  let error = null, port = null, holderId = '', bound = false;
  let activation = null, claiming = false, claimed = null, consumer = null;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // An early disconnect can precede the second bootstrap's subscription.
  ready.catch(() => undefined);
  const token = Object.freeze({});

  function fail(code) {
    if (error) return;
    error = failure(code);
    rejectReady(error);
    consumer?.onDisconnect();
    port?.disconnect?.();
  }
  function assertActive() {
    if (error) throw error;
    if (!claimed) throw failure('local_recovery_runner_not_activated');
  }
  function matchesActivation(value) {
    return value?.launchIntentId === launchIntentId && value.requestId === requestId &&
      value.attemptId === attemptId && Number.isSafeInteger(value.generation) && value.generation > 0;
  }
  async function claimAfterActivation() {
    if (error || !bound || !activation || claiming) return;
    claiming = true;
    try {
      const response = await chromeApi.runtime.sendMessage({
        type: 'onstarvoice:local-recovery-runner-claim',
        launchIntentId, requestId, attemptId, generation: activation.generation, holderId,
      });
      if (error) return;
      const control = parsePageOperationOwnerControl(response?.strictControl);
      if (response?.ok !== true || response.accepted !== true ||
          response.launchIntentId !== launchIntentId || response.scopeMode !== 'cooperative' ||
          !control || control.requestId !== requestId || control.attemptId !== attemptId ||
          control.generation !== activation.generation || response.data?.id !== requestId ||
          response.data?.attemptId !== attemptId || !response.lock?.id ||
          response.lock.holderId !== holderId || response.lock.holderDocumentId !== control.ownerDocumentId) {
        fail('local_recovery_claim_unconfirmed');
        return;
      }
      claimed = Object.freeze({...response, strictControl: control});
      handoffs.set(token, {
        assertActive,
        take() {
          assertActive();
          if (consumer) throw failure('local_recovery_owner_already_adopted');
          return Object.freeze({
            claim: claimed, port,
            attach(callbacks) {
              assertActive();
              if (consumer) throw failure('local_recovery_owner_already_adopted');
              consumer = callbacks;
            },
            assertActive,
          });
        },
      });
      resolveReady(token);
    } catch (caught) {
      fail(caught?.code || 'local_recovery_claim_failed');
    }
  }
  function start() {
    if (port || error || !holderId) return;
    try {
      port = chromeApi.runtime.connect({name: PORT});
      port.onDisconnect.addListener(() => fail('local_recovery_runner_disconnected'));
      port.onMessage.addListener(message => {
        if (error) return;
        if (message?.type === 'capture-owner:strict-stop') {
          const stoppedControl = parsePageOperationOwnerControl(message.strictControl);
          if (!stoppedControl || stoppedControl.requestId !== requestId || stoppedControl.attemptId !== attemptId ||
              (claimed && !pageOperationOwnerControlMatches(stoppedControl, claimed.strictControl)) ||
              (!claimed && activation && stoppedControl.generation !== activation.generation)) return;
          if (consumer) consumer.onStop(message);
          else fail('local_recovery_stop_before_adoption');
          return;
        }
        if (message?.type !== 'onstarvoice:local-recovery-activated') return;
        // A notification is only a pre-claim wakeup. Once this document has its
        // authoritative claim, a late notification cannot replace or revoke it.
        if (claimed) return;
        if (!matchesActivation(message) || (activation && activation.generation !== message.generation)) {
          fail('local_recovery_activation_identity_mismatch');
          return;
        }
        activation = Object.freeze({launchIntentId, requestId, attemptId, generation: message.generation});
        void claimAfterActivation();
      });
      Promise.resolve(chromeApi.runtime.sendMessage({
        type: 'onstarvoice:local-recovery-runner-bind', launchIntentId, holderId,
      })).then(response => {
        if (error) return;
        if (response?.ok !== true || !['prepared', 'runner_bound'].includes(response.phase)) {
          fail('local_recovery_bind_unconfirmed');
          return;
        }
        bound = true;
        void claimAfterActivation();
      }, () => fail('local_recovery_bind_failed'));
    } catch (caught) {
      fail(caught?.code || 'local_recovery_bind_failed');
    }
  }
  for (const key of ['localRecoveryIntent', 'unattendedRun', 'unattendedAttempt']) {
    if (query.getAll(key).length !== 1 || !UUID.test(query.get(key) || '')) {
      fail('local_recovery_runner_url_invalid');
    }
  }
  lifecycle?.addEventListener?.('pagehide', () => fail('local_recovery_runner_document_hidden'));
  return Object.freeze({
    isRecoveryRunner: true,
    assertActive,
    waitForActivation(options = {}) {
      if (Object.hasOwn(options, 'holderId')) {
        if (typeof options.holderId !== 'string' || !options.holderId.trim() ||
            options.holderId !== options.holderId.trim() || (holderId && holderId !== options.holderId)) {
          fail('local_recovery_holder_mismatch');
        } else holderId = options.holderId;
      }
      start();
      return ready;
    },
  });
}

export function getLocalRecoveryRunnerGate() {
  if (!documentGate) documentGate = createLocalRecoveryRunnerGate();
  return documentGate;
}

// No plain renderer object can masquerade as the result of the handshake.
export function consumeLocalRecoveryOwnerHandoff(token) {
  const entry = handoffs.get(token);
  if (!entry) throw failure('local_recovery_owner_handoff_required');
  entry.assertActive();
  handoffs.delete(token);
  return entry.take();
}
