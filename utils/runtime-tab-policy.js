(function installRuntimeTabPolicy(root, factory) {
  const api = factory();
  if (typeof module === "object" && module?.exports) {
    module.exports = api;
  }
  root.OnStarvoiceRuntimeTabPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function createPolicy() {
  function isActiveSenderTab(tab) {
    const tabId = Number(tab?.id);
    return Boolean(
      tab && tab.active === true && Number.isFinite(tabId) && tabId > 0,
    );
  }

  function buildCaptureProgressPatch(tab, progress) {
    const patch = {lastCaptureProgress: progress ?? null};
    if (isActiveSenderTab(tab)) {
      patch.lastActiveTabId = Number(tab.id);
    }
    return patch;
  }

  function shouldAdoptPageState(tab) {
    return isActiveSenderTab(tab);
  }

  function buildRelayRuntimePatch(tab) {
    return isActiveSenderTab(tab)
      ? {lastActiveTabId: Number(tab.id)}
      : {};
  }

  return Object.freeze({
    isActiveSenderTab,
    buildCaptureProgressPatch,
    shouldAdoptPageState,
    buildRelayRuntimePatch,
  });
});
