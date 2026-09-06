// Only the legacy document event uses this bridge. It does not verify identity,
// permission or Attempt ownership, and must not be exported as a new-UI command.
export function createLegacyTaskCenterActionView({window, showMessage, executeLegacyAction}) {
  async function handleTaskCenterAction(event) {
    const detail = event?.detail && typeof event.detail === "object"
      ? event.detail
      : {};
    return executeLegacyAction(detail);
  }

  return Object.freeze({
    handleTaskCenterAction,
    activateResultsTab: () => window.activateSidebarTab?.("searchTab"),
    confirmSafetyBlock: () => window.confirm(
      "请先在抖音页面人工完成安全验证。确认页面已经恢复正常后，再继续剩余关键词。",
    ),
    notify: (message, type) => showMessage(message, type),
  });
}
