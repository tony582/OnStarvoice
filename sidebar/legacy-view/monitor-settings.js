// L3-B monitor-settings: explicit legacy-view responsibility.
export function createMonitorSettingsView({legacyViewState, ports, application, keywordModel, viewOperations}) {
  const {
    DEFAULT_MONITOR_SETTINGS,
    MONITOR_SUBJECT_TYPE,
    document,
    window,
  } = ports;
  const normalizeMonitorSettingsInput = (...args) => application.normalizeMonitorSettingsInput(...args);
  const normalizeMonitorSubjectType = (...args) => application.normalizeMonitorSubjectType(...args);

  function readMonitorSelectedPlatform() {
    return document.body.dataset.selectedPlatform;
  }
  function confirmMonitorRemoval() {
    return window.confirm?.("删除后该监控项将从当前列表移除，是否继续？");
  }
  async function handleMonitorListClick(event) {
    const button = event.target.closest(".btn-monitor-toggle, .btn-monitor-delete");
    if (!button) return;
    await application.handleLegacyMonitorAction(Object.freeze({
      readSubscriptionId: () => String(button.dataset.id || "").trim(),
      isToggle: () => button.classList.contains("btn-monitor-toggle"),
      readNextStatus: () => button.dataset.nextStatus,
      isDelete: () => button.classList.contains("btn-monitor-delete"),
    }));
  }

  function getMonitorSettingsElements() {
    const publishWindow = document.getElementById("inputMonitorPublishWindow");
    const likeThreshold = document.getElementById("inputMonitorLikeThreshold");
    const runTimes = document.getElementById("inputMonitorRunTimes");
    const observeWindowHours = document.getElementById(
      "inputMonitorObserveWindowHours",
    );

    if (!publishWindow || !likeThreshold || !runTimes || !observeWindowHours) {
      return null;
    }

    return {
      publishWindow,
      likeThreshold,
      runTimes,
      observeWindowHours,
    };
  }
  function populateMonitorSettingsForm(settings = {}) {
    const elements = getMonitorSettingsElements();
    if (!elements) {
      return;
    }

    const normalized = normalizeMonitorSettingsInput(settings);
    elements.publishWindow.value = normalized.publishWindow;
    elements.likeThreshold.value = String(normalized.likeThreshold);
    elements.runTimes.value =
      normalized.runTimes[0] || DEFAULT_MONITOR_SETTINGS.runTimes[0];
    elements.observeWindowHours.value = String(normalized.observeWindowHours);
  }
  function readMonitorSettingsForm() {
    const elements = getMonitorSettingsElements();
    if (!elements) {
      return {...DEFAULT_MONITOR_SETTINGS};
    }

    return normalizeMonitorSettingsInput({
      publishWindow: elements.publishWindow.value,
      likeThreshold: elements.likeThreshold.value,
      runTimes: elements.runTimes.value,
      observeWindowHours: elements.observeWindowHours.value,
    });
  }
  function resolveMonitorDisplayName(item) {
    return (
      String(
        item?.displayName ||
          item?.display_name ||
          item?.bloggerNameSnapshot ||
          item?.bloggerName ||
          "",
      ).trim() ||
      String(
        item?.accountNo ||
          item?.account_no ||
          item?.profileInternalId ||
          item?.profile_internal_id ||
          item?.platformBloggerId ||
          "",
      ).trim() ||
      "未命名博主"
    );
  }
  function getMonitorSubjectType() {
    const selectedButton = document.querySelector(
      '.monitor-subject-option[aria-pressed="true"]',
    );
    return normalizeMonitorSubjectType(selectedButton?.dataset?.subjectType);
  }
  function getMonitorSubjectLabel(subjectType) {
    return normalizeMonitorSubjectType(subjectType) ===
      MONITOR_SUBJECT_TYPE.OFFICIAL
      ? "官方账号"
      : "关注博主";
  }
  function setMonitorSubjectType(subjectType) {
    const normalized = normalizeMonitorSubjectType(subjectType);
    document.querySelectorAll(".monitor-subject-option").forEach((button) => {
      const isSelected =
        normalizeMonitorSubjectType(button.dataset.subjectType) === normalized;
      button.classList.toggle("is-selected", isSelected);
      button.setAttribute("aria-pressed", String(isSelected));
    });
    window.getMonitorSubjectType = () => normalized;
    window.refreshMonitorSubjectAction?.();
  }

  return Object.freeze({
    readMonitorSelectedPlatform,
    confirmMonitorRemoval,
    handleMonitorListClick,
    getMonitorSettingsElements,
    populateMonitorSettingsForm,
    readMonitorSettingsForm,
    resolveMonitorDisplayName,
    getMonitorSubjectType,
    getMonitorSubjectLabel,
    setMonitorSubjectType,
  });
}
