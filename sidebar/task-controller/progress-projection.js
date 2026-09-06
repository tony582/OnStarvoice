// L3-A progress-projection: original control flow, explicit state and compatibility ports.
export function createProgressProjectionController({controllerState, controllerPorts, controllerOperations}) {


  function readFiniteProgressNumber(...values) {
    for (const value of values) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }

  function readProgressText(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) {
        return text;
      }
    }
    return "";
  }

  function isCaptureTaskWaitPhase(phase = "") {
    const normalized = String(phase || "").trim().toLowerCase();
    return (
      normalized === "scheduled-waiting" ||
      normalized === "waiting_next_round" ||
      normalized === "starting_next_round" ||
      normalized === "keyword_retry_wait" ||
      normalized === "inter_keyword_delay" ||
      normalized === "detail_item_delay" ||
      normalized.includes("backoff") ||
      normalized.includes("safe_wait")
    );
  }

  function isCaptureTaskDetailPhase(phase = "") {
    const normalized = String(phase || "").trim().toLowerCase();
    return (
      normalized.startsWith("detail_") ||
      normalized.startsWith("comments_") ||
      normalized.includes("enhanc")
    );
  }

  function isCaptureTaskSyncPhase(phase = "") {
    const normalized = String(phase || "").trim().toLowerCase();
    return (
      normalized.includes("sync") ||
      normalized.includes("upload") ||
      normalized.includes("saving")
    );
  }

  function projectCaptureTaskProgress(
    progress = {},
    context = controllerState.activeCaptureTaskProgressContext,
  ) {
    const safeProgress =
      progress && typeof progress === "object" && !Array.isArray(progress)
        ? progress
        : {};
    const safeContext =
      context && typeof context === "object" && !Array.isArray(context)
        ? context
        : {};
    const phase = readProgressText(safeProgress.phase, safeContext.phase);
    const keyword = readProgressText(
      safeProgress.keyword,
      safeContext.keyword,
    );
    const legacyCurrent = readFiniteProgressNumber(safeProgress.current);
    const legacyTotal = readFiniteProgressNumber(safeProgress.total);
    const detailPhase = isCaptureTaskDetailPhase(phase);
    const waitPhase = isCaptureTaskWaitPhase(phase);
    const syncPhase = isCaptureTaskSyncPhase(phase);
    const targetedPost = safeProgress.targetedPost === true;
    const taskMeta = {
      ...(safeContext.taskMeta &&
      typeof safeContext.taskMeta === "object" &&
      !Array.isArray(safeContext.taskMeta)
        ? safeContext.taskMeta
        : {}),
      ...(safeProgress.taskMeta &&
      typeof safeProgress.taskMeta === "object" &&
      !Array.isArray(safeProgress.taskMeta)
        ? safeProgress.taskMeta
        : {}),
    };
    const keywordList = Array.isArray(taskMeta.keywordList)
      ? taskMeta.keywordList.map((value) => String(value || "").trim())
      : [];
    const plannedKeywordIndex = keyword ? keywordList.indexOf(keyword) : -1;

    let keywordCurrent = readFiniteProgressNumber(safeProgress.keywordCurrent);
    let keywordTotal = readFiniteProgressNumber(safeProgress.keywordTotal);
    if (plannedKeywordIndex >= 0) {
      if (keywordCurrent === null) keywordCurrent = plannedKeywordIndex + 1;
      if (keywordTotal === null) keywordTotal = keywordList.length;
    }
    if (
      !detailPhase &&
      !waitPhase &&
      !syncPhase &&
      keyword &&
      (keywordCurrent === null || keywordTotal === null)
    ) {
      if (keywordCurrent === null && legacyCurrent !== null) {
        keywordCurrent = legacyCurrent;
      }
      if (keywordTotal === null && legacyTotal !== null) {
        keywordTotal = legacyTotal;
      }
    }
    if (keywordCurrent === null) {
      keywordCurrent = readFiniteProgressNumber(safeContext.keywordCurrent);
    }
    if (keywordTotal === null) {
      keywordTotal = readFiniteProgressNumber(safeContext.keywordTotal);
    }

    let itemCurrent = readFiniteProgressNumber(safeProgress.itemCurrent);
    let itemTotal = readFiniteProgressNumber(safeProgress.itemTotal);
    if (
      detailPhase &&
      itemCurrent === null &&
      itemTotal === null &&
      legacyCurrent !== null &&
      legacyTotal !== null
    ) {
      itemCurrent = legacyCurrent;
      itemTotal = legacyTotal;
    }

    const roundCurrent = readFiniteProgressNumber(
      safeProgress.roundCurrent,
      safeProgress.round,
      safeContext.roundCurrent,
      safeContext.round,
    );
    const roundTotal = readFiniteProgressNumber(
      safeProgress.roundTotal,
      safeContext.roundTotal,
    );
    const attemptCurrent = readFiniteProgressNumber(
      safeProgress.attemptCurrent,
      safeProgress.attempt,
      safeContext.attemptCurrent,
      safeContext.attempt,
    );
    const attemptTotal = readFiniteProgressNumber(
      safeProgress.attemptTotal,
      safeProgress.maxAttempts,
      safeContext.attemptTotal,
      safeContext.maxAttempts,
    );
    const progressScope = readProgressText(
      safeProgress.progressScope,
      waitPhase
        ? "wait"
        : detailPhase
          ? "detail_item"
          : syncPhase
            ? "sync_item"
            : keyword
              ? "keyword"
              : safeContext.progressScope,
    );
    return {
      ...safeProgress,
      captureTaskId: readProgressText(
        safeProgress.captureTaskId,
        safeContext.captureTaskId,
      ),
      unattendedRequestId: readProgressText(
        safeProgress.unattendedRequestId,
        safeContext.unattendedRequestId,
      ),
      unattendedAttemptId: readProgressText(
        safeProgress.unattendedAttemptId,
        safeContext.unattendedAttemptId,
      ),
      phase,
      keyword,
      keywordCurrent,
      keywordTotal,
      itemCurrent: detailPhase || targetedPost ? itemCurrent : null,
      itemTotal: detailPhase || targetedPost ? itemTotal : null,
      round: roundCurrent,
      roundCurrent,
      roundTotal,
      attempt: attemptCurrent,
      attemptCurrent,
      attemptTotal,
      maxAttempts: attemptTotal,
      nextKeyword: readProgressText(
        safeProgress.nextKeyword,
        safeContext.nextKeyword,
      ),
      runStartedAt: readProgressText(
        safeProgress.runStartedAt,
        safeContext.runStartedAt,
      ),
      progressScope,
      taskMeta,
    };
  }

  function rememberCaptureTaskProgressContext(progress = {}) {
    const projected = projectCaptureTaskProgress(progress);
    controllerState.activeCaptureTaskProgressContext = {
      captureTaskId: projected.captureTaskId,
      unattendedRequestId: projected.unattendedRequestId,
      unattendedAttemptId: projected.unattendedAttemptId,
      phase: projected.phase,
      keyword: projected.keyword,
      keywordCurrent: projected.keywordCurrent,
      keywordTotal: projected.keywordTotal,
      round: projected.roundCurrent,
      roundCurrent: projected.roundCurrent,
      roundTotal: projected.roundTotal,
      attempt: projected.attemptCurrent,
      attemptCurrent: projected.attemptCurrent,
      attemptTotal: projected.attemptTotal,
      maxAttempts: projected.attemptTotal,
      nextKeyword: projected.nextKeyword,
      runStartedAt: projected.runStartedAt,
      progressScope: projected.progressScope,
      taskMeta: projected.taskMeta,
    };
    return projected;
  }

  function clearCaptureTaskProgressContext() {
    controllerState.activeCaptureTaskProgressContext = null;
  }

  return Object.freeze({
    readFiniteProgressNumber,
    readProgressText,
    isCaptureTaskWaitPhase,
    isCaptureTaskDetailPhase,
    isCaptureTaskSyncPhase,
    projectCaptureTaskProgress,
    rememberCaptureTaskProgressContext,
    clearCaptureTaskProgressContext,
  });
}
