(function installRetiredRunnerCleanup(root, factory) {
  const api = factory();
  if (typeof module === "object" && module?.exports) module.exports = api;
  root.OnStarvoiceRetiredRunnerCleanup = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const text = (value) => typeof value === "string" ? value.trim() : "";

  function isFinalReceipt(receipt) {
    return Boolean(
      receipt?.v === 1 &&
      text(receipt.requestId) && text(receipt.attemptId) &&
      text(receipt.documentId) &&
      Number.isSafeInteger(receipt.tabId) && receipt.tabId > 0 &&
      Number.isFinite(Date.parse(text(receipt.at))) &&
      receipt.heartbeatStopped === true && receipt.flushed === true &&
      receipt.flushing !== true && receipt.pendingUploads === 0,
    );
  }

  function sameReceipt(left, right) {
    return isFinalReceipt(left) && isFinalReceipt(right) &&
      ["requestId", "attemptId", "documentId", "tabId", "at"].every(
        (key) => left[key] === right[key],
      );
  }

  // Only receipts written by a runner can authorize closing that document.
  // A terminal ledger entry, elapsed time, or an empty outbox alone cannot.
  function selectReceipts(stored, prefix) {
    return Object.entries(stored || {}).filter(([key, receipt]) =>
      key.startsWith(prefix) && isFinalReceipt(receipt) &&
      key === `${prefix}${receipt.requestId}.${receipt.attemptId}`,
    ).map(([, receipt]) => receipt);
  }

  function inspectCandidate({
    receipt, latestReceipt, tab, contexts, slot, terminal = false,
    lock, lockKnown = false, outbox, relays,
    runnerMatches = false,
  } = {}) {
    const preserve = (reason) => ({closable: false, reason});
    if (!isFinalReceipt(receipt)) return preserve("receipt_not_final");
    if (!sameReceipt(receipt, latestReceipt)) return preserve("receipt_changed");
    if (!lockKnown) return preserve("lock_state_unknown");
    if (lock && (
      text(lock.holderDocumentId) === receipt.documentId ||
      Number(lock.holderTabId) === receipt.tabId ||
      (text(lock.captureTaskId) === `unattended-capture:${receipt.requestId}` &&
        (!text(lock.captureTaskAttemptId) ||
          text(lock.captureTaskAttemptId) === receipt.attemptId))
    )) return preserve("lock_holder");
    if (slot && slot.id === receipt.requestId &&
      slot.attemptId === receipt.attemptId && !terminal) {
      return preserve("attempt_current");
    }
    if (slot && Number(slot.runnerTabId) === receipt.tabId &&
      (slot.id !== receipt.requestId || slot.attemptId !== receipt.attemptId)) {
      return preserve("runner_reassigned");
    }
    if (!tab || Number(tab.id) !== receipt.tabId || !runnerMatches) {
      return preserve("not_runner");
    }
    if (text(tab.pendingUrl) || tab.status === "loading") {
      return preserve("runner_navigating");
    }
    if (!Array.isArray(contexts) || contexts.length !== 1 ||
      contexts[0]?.documentId !== receipt.documentId ||
      Number(contexts[0]?.tabId) !== receipt.tabId) {
      return preserve("runner_document_unconfirmed");
    }
    if (!outbox || outbox.known !== true || outbox.pendingCount !== 0) {
      return preserve("checkpoint_reports_pending");
    }
    if (!Array.isArray(relays)) return preserve("relay_state_unknown");
    if (relays.some((relay) =>
      text(relay.senderDocumentId) === receipt.documentId ||
      Number(relay.senderTabId) === receipt.tabId ||
      (text(relay.runnerRequestId) === receipt.requestId &&
        (!text(relay.runnerAttemptId) ||
          text(relay.runnerAttemptId) === receipt.attemptId)) ||
      (text(relay.taskId) === `unattended-capture:${receipt.requestId}` &&
        !text(relay.runnerAttemptId)),
    )) return preserve("relay_in_flight");
    return {closable: true, reason: "retired_runner_verified"};
  }

  return Object.freeze({isFinalReceipt, sameReceipt, selectReceipts, inspectCandidate});
});
