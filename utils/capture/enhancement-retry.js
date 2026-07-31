const RETRYABLE_FAILURE_CODES = new Set([
  "PAGE_OPEN_TIMEOUT",
  "PAGE_OPEN_FAILED",
  "NOTE_CAPTURE_FAILED",
  "COMMENTS_CAPTURE_FAILED",
  "BLOGGER_METRICS_FAILED",
  "UNEXPECTED_ERROR",
  "UNKNOWN",
  "CONTEXT_INTERRUPTED",
  "RUNNER_INTERRUPTED",
  "RUNNER_TAB_UNAVAILABLE",
  "TASK_TAB_GROUP_UNAVAILABLE",
  "TAB_NOT_FOUND",
]);

const RUNNER_CONTEXT_FAILURE_CODES = new Set([
  "CONTEXT_INTERRUPTED",
  "RUNNER_INTERRUPTED",
  "RUNNER_TAB_UNAVAILABLE",
  "TASK_TAB_GROUP_UNAVAILABLE",
  "TAB_NOT_FOUND",
  "RETRY_RESULT_MISSING",
]);

const NON_RETRYABLE_FAILURE_CATEGORIES = new Set([
  "invalid_record",
  "link_missing",
  "security_blocked",
  "integrity_blocked",
  "user_canceled",
]);

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeCode(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeCategory(value) {
  return normalizeText(value).toLowerCase();
}

function readFailureCode(item = {}) {
  return normalizeCode(
    item.reason || item.code || item.error?.code || item.failureCode,
  );
}

function readFailureCategory(item = {}) {
  return normalizeCategory(
    item.category || item.error?.category || item.failureCategory,
  );
}

function readTopLevelFailureCode(result = {}) {
  return normalizeCode(
    result?.error?.code || result?.code || result?.reason,
  );
}

function isRunnerContextFailure(value = {}) {
  const code = readTopLevelFailureCode(value);
  const category = normalizeCategory(
    value?.category || value?.error?.category,
  );
  return Boolean(
    value?.runnerInterrupted === true ||
      value?.recoveryRequired === true ||
      category === "context_interrupted" ||
      RUNNER_CONTEXT_FAILURE_CODES.has(code),
  );
}

function isNonRetryableFailure(item = {}) {
  const code = readFailureCode(item);
  const category = readFailureCategory(item);
  return Boolean(
    item?.canceled === true ||
      item?.securityBlocked === true ||
      NON_RETRYABLE_FAILURE_CATEGORIES.has(category) ||
      code === "CANCELED" ||
      code === "DETAIL_CAPTURE_CANCELED" ||
      code === "XHS_SECURITY_BLOCK" ||
      code === "IDENTITY_MISMATCH" ||
      code === "DOUYIN_DETAIL_ID_MISMATCH" ||
      code === "DOUYIN_COMMENT_ID_MISMATCH" ||
      code === "DOUYIN_COMMENT_ID_CONFLICT" ||
      code === "CONTENT_UNAVAILABLE" ||
      code === "LINK_MISSING" ||
      code === "INVALID_RECORD",
  );
}

function isFilteredOrAlreadyCaptured(item = {}) {
  const reason = normalizeText(item?.reason).toLowerCase();
  const category = readFailureCategory(item);
  return Boolean(
    item?.filtered === true ||
      item?.skipped === true ||
      category === "filtered" ||
      category === "already_captured" ||
      reason === "already_captured" ||
      reason === "ai_relevance_filtered" ||
      reason === "low_follower_filtered" ||
      reason === "detail_keyword_filtered",
  );
}

export function isRetryableEnhancementFailure(item = {}) {
  if (!item || item.ok !== false || !normalizeText(item.recordId)) {
    return false;
  }
  if (isNonRetryableFailure(item) || isFilteredOrAlreadyCaptured(item)) {
    return false;
  }

  const code = readFailureCode(item);
  const category = readFailureCategory(item);
  return (
    RETRYABLE_FAILURE_CODES.has(code) ||
    category === "page_failed" ||
    category === "context_interrupted"
  );
}

export function collectRetryableEnhancementRecordIds(
  result = {},
  {fallbackRecordIds = []} = {},
) {
  if (
    !result ||
    result.canceled === true ||
    result.securityBlocked === true ||
    result.integrityBlocked === true ||
    result.fatal === true ||
    result.stopBatch === true ||
    result.fatalError ||
    (Array.isArray(result.results) &&
      result.results.some(
        (item) =>
          item?.integrityBlocked === true ||
          item?.fatal === true ||
          item?.stopBatch === true,
      ))
  ) {
    return [];
  }

  const seen = new Set();
  const recordIds = [];
  for (const item of Array.isArray(result.results) ? result.results : []) {
    if (!isRetryableEnhancementFailure(item)) continue;
    const recordId = normalizeText(item.recordId);
    if (!recordId || seen.has(recordId)) continue;
    seen.add(recordId);
    recordIds.push(recordId);
  }

  const topLevelCode = readTopLevelFailureCode(result);
  const needsFreshRunnerRecovery =
    isRunnerContextFailure(result) || topLevelCode === "UNEXPECTED_ERROR";
  if (needsFreshRunnerRecovery) {
    const settledWithoutRetryIds = new Set(
      (Array.isArray(result.results) ? result.results : [])
        .filter(
          (item) =>
            item?.ok === true ||
            isFilteredOrAlreadyCaptured(item) ||
            isNonRetryableFailure(item),
        )
        .map((item) => normalizeText(item?.recordId))
        .filter(Boolean),
    );
    for (const candidateId of Array.isArray(fallbackRecordIds)
      ? fallbackRecordIds
      : []) {
      const recordId = normalizeText(candidateId);
      if (
        !recordId ||
        settledWithoutRetryIds.has(recordId) ||
        seen.has(recordId)
      ) {
        continue;
      }
      seen.add(recordId);
      recordIds.push(recordId);
    }
  }
  return recordIds;
}

function isSkippedSuccess(item = {}) {
  const reason = normalizeText(item.reason).toLowerCase();
  return (
    item?.ok === true &&
    item?.filtered !== true &&
    (item?.skipped === true || reason === "already_captured")
  );
}

function countEnhancementResults(results = []) {
  const normalizedResults = Array.isArray(results) ? results : [];
  const filteredCount = normalizedResults.filter(
    (item) => item?.ok === true && item?.filtered === true,
  ).length;
  const skippedCount = normalizedResults.filter(isSkippedSuccess).length;
  const successCount = normalizedResults.filter(
    (item) =>
      item?.ok === true && item?.filtered !== true && !isSkippedSuccess(item),
  ).length;
  const failedCount = normalizedResults.filter(
    (item) => item?.ok === false,
  ).length;
  return {successCount, failedCount, filteredCount, skippedCount};
}

function buildSyntheticFailureItem(recordId, result = {}, fallbackCode = "") {
  const code =
    readTopLevelFailureCode(result) ||
    normalizeCode(fallbackCode) ||
    "UNEXPECTED_ERROR";
  const runnerContextFailure =
    isRunnerContextFailure(result) ||
    RUNNER_CONTEXT_FAILURE_CODES.has(code);
  return {
    recordId,
    ok: false,
    reason: code,
    code,
    category: runnerContextFailure
      ? "context_interrupted"
      : "page_failed",
    stage: runnerContextFailure ? "runner_context" : "retry_result",
    message:
      normalizeText(result?.error?.message || result?.message) ||
      (code === "RETRY_RESULT_MISSING"
        ? "采集增强重试未返回当前作品结果"
        : "采集增强执行失败"),
  };
}

function normalizeAttemptResult(
  rawResult,
  expectedRecordIds,
  {
    thrownError = null,
    synthesizeMissing = false,
    missingMeansRecovery = false,
  } = {},
) {
  const expectedIds = Array.isArray(expectedRecordIds)
    ? expectedRecordIds.map(normalizeText).filter(Boolean)
    : [];
  const thrownCode = normalizeCode(thrownError?.code) || "UNEXPECTED_ERROR";
  const baseResult =
    rawResult && typeof rawResult === "object"
      ? {...rawResult}
      : {
          ok: false,
          canceled: false,
          runnerInterrupted: false,
          securityBlocked: false,
          error: {
            code: thrownCode,
            message:
              normalizeText(thrownError?.message) ||
              "采集增强执行未返回有效结果",
          },
        };
  if (thrownError) {
    baseResult.ok = false;
    baseResult.error = {
      code: thrownCode,
      message:
        normalizeText(thrownError?.message) || "采集增强执行发生异常",
    };
    baseResult.canceled = Boolean(
      thrownError?.canceled === true ||
        thrownCode === "CANCELED" ||
        thrownCode === "DETAIL_CAPTURE_CANCELED",
    );
    baseResult.securityBlocked = Boolean(
      thrownError?.securityBlocked === true ||
        thrownCode === "XHS_SECURITY_BLOCK",
    );
  }

  const results = Array.isArray(baseResult.results)
    ? baseResult.results.map((item) => ({...item}))
    : [];
  const resultIds = new Set(
    results
      .map((item) => normalizeText(item?.recordId))
      .filter(Boolean),
  );
  let missingCount = 0;
  if (synthesizeMissing) {
    for (const recordId of expectedIds) {
      if (resultIds.has(recordId)) continue;
      missingCount += 1;
      results.push(
        buildSyntheticFailureItem(
          recordId,
          baseResult,
          missingMeansRecovery ? "RETRY_RESULT_MISSING" : thrownCode,
        ),
      );
      resultIds.add(recordId);
    }
  }

  const topLevelRunnerFailure = isRunnerContextFailure(baseResult);
  const unresolvedMissingResult = missingMeansRecovery && missingCount > 0;
  const runnerInterrupted = Boolean(
    topLevelRunnerFailure || unresolvedMissingResult,
  );
  const recoveryRequired = Boolean(
    baseResult.recoveryRequired === true ||
      runnerInterrupted ||
      unresolvedMissingResult,
  );
  const counts = countEnhancementResults(results);
  let error = baseResult.error || null;
  if (unresolvedMissingResult && !error) {
    error = {
      code: "RETRY_RESULT_MISSING",
      message: `采集增强重试有 ${missingCount} 条未返回结果`,
    };
  }
  return {
    ...baseResult,
    ok:
      baseResult.canceled !== true &&
      baseResult.securityBlocked !== true &&
      !runnerInterrupted &&
      !error &&
      counts.failedCount === 0,
    runnerInterrupted,
    recoveryRequired,
    total: Math.max(
      Number(baseResult.total) || 0,
      expectedIds.length,
      results.length,
    ),
    processedCount: results.length,
    ...counts,
    results,
    error,
  };
}

function normalizeThrownAttemptError(error, recordIds) {
  return normalizeAttemptResult(null, recordIds, {
    thrownError: error,
    synthesizeMissing: true,
  });
}

function mergeDiagnostics(initialResult = {}, retryResult = {}) {
  const stageTrace = [
    ...(Array.isArray(initialResult?.diagnostics?.stageTrace)
      ? initialResult.diagnostics.stageTrace
      : []),
    ...(Array.isArray(retryResult?.diagnostics?.stageTrace)
      ? retryResult.diagnostics.stageTrace
      : []),
  ];
  return stageTrace.length > 0 ? {stageTrace} : initialResult.diagnostics;
}

export function mergeEnhancementAttemptResults({
  initialResult = {},
  retryResult = {},
  retryRecordIds = [],
} = {}) {
  const retryIdSet = new Set(
    (Array.isArray(retryRecordIds) ? retryRecordIds : [])
      .map(normalizeText)
      .filter(Boolean),
  );
  retryResult = normalizeAttemptResult(retryResult, [...retryIdSet], {
    synthesizeMissing: true,
    missingMeansRecovery: true,
  });
  const retryItemById = new Map();
  for (const item of Array.isArray(retryResult?.results)
    ? retryResult.results
    : []) {
    const recordId = normalizeText(item?.recordId);
    if (recordId) retryItemById.set(recordId, item);
  }

  const mergedResults = [];
  const mergedIds = new Set();
  for (const initialItem of Array.isArray(initialResult?.results)
    ? initialResult.results
    : []) {
    const recordId = normalizeText(initialItem?.recordId);
    const replacement =
      recordId && retryIdSet.has(recordId) && retryItemById.has(recordId)
        ? retryItemById.get(recordId)
        : initialItem;
    mergedResults.push(replacement);
    if (recordId) mergedIds.add(recordId);
  }
  for (const retryItem of Array.isArray(retryResult?.results)
    ? retryResult.results
    : []) {
    const recordId = normalizeText(retryItem?.recordId);
    if (recordId && mergedIds.has(recordId)) continue;
    mergedResults.push(retryItem);
    if (recordId) mergedIds.add(recordId);
  }

  const {successCount, failedCount, filteredCount, skippedCount} =
    countEnhancementResults(mergedResults);
  const recoveredIds = [];
  const stillFailedIds = [];
  for (const recordId of retryIdSet) {
    const finalItem = mergedResults.find(
      (item) => normalizeText(item?.recordId) === recordId,
    );
    if (finalItem?.ok === true) recoveredIds.push(recordId);
    else stillFailedIds.push(recordId);
  }

  const canceled = retryResult?.canceled === true;
  const runnerInterrupted = Boolean(
    retryResult?.runnerInterrupted === true ||
      retryResult?.recoveryRequired === true ||
      retryResult?.results?.some(
        (item) =>
          item?.ok === false &&
          RUNNER_CONTEXT_FAILURE_CODES.has(readFailureCode(item)),
      ),
  );
  const recoveryRequired = Boolean(
    retryResult?.recoveryRequired === true || runnerInterrupted,
  );
  const securityBlocked = retryResult?.securityBlocked === true;
  const integrityBlocked = Boolean(
    initialResult?.integrityBlocked === true ||
      retryResult?.integrityBlocked === true ||
      mergedResults.some((item) => item?.integrityBlocked === true),
  );
  const fatal = Boolean(
    initialResult?.fatal === true ||
      retryResult?.fatal === true ||
      integrityBlocked,
  );
  const stopBatch = Boolean(
    initialResult?.stopBatch === true ||
      retryResult?.stopBatch === true ||
      fatal,
  );
  const error = retryResult?.error || null;

  return {
    ...initialResult,
    ok:
      !canceled &&
      !runnerInterrupted &&
      !securityBlocked &&
      !integrityBlocked &&
      !fatal &&
      !stopBatch &&
      !error &&
      failedCount === 0,
    canceled,
    runnerInterrupted,
    recoveryRequired,
    securityBlocked,
    integrityBlocked,
    fatal,
    stopBatch,
    total: Math.max(
      Number(initialResult?.total) || 0,
      mergedResults.length,
    ),
    processedCount: mergedResults.length,
    successCount,
    failedCount,
    filteredCount,
    skippedCount,
    results: mergedResults,
    diagnostics: mergeDiagnostics(initialResult, retryResult),
    error,
    autoRetryHandled: true,
    autoRetryAttempted: true,
    autoRetryCount: 1,
    autoRetryRecordIds: [...retryIdSet],
    autoRetryRecoveredIds: recoveredIds,
    autoRetryStillFailedIds: stillFailedIds,
    autoRetryInitialRunnerInterrupted:
      initialResult?.runnerInterrupted === true,
    autoRetryInitialRecoveryRequired:
      initialResult?.recoveryRequired === true,
  };
}

export async function runEnhancementWithSingleRetry({
  recordIds = [],
  runAttempt,
  onRetryScheduled = null,
  onRetryStarted = null,
  prepareRetry = null,
  waitBeforeRetry = null,
  shouldStop = null,
} = {}) {
  if (typeof runAttempt !== "function") {
    throw new TypeError("enhancement retry requires runAttempt");
  }

  const normalizedRecordIds = [
    ...new Set(
      (Array.isArray(recordIds) ? recordIds : [])
        .map(normalizeText)
        .filter(Boolean),
    ),
  ];
  let initialResult;
  try {
    const rawInitialResult = await runAttempt(normalizedRecordIds, {
      attempt: 1,
      isRetry: false,
    });
    const shouldSynthesizeMissing = Boolean(
      !rawInitialResult ||
        isRunnerContextFailure(rawInitialResult) ||
        readTopLevelFailureCode(rawInitialResult) === "UNEXPECTED_ERROR",
    );
    initialResult = normalizeAttemptResult(
      rawInitialResult,
      normalizedRecordIds,
      {synthesizeMissing: shouldSynthesizeMissing},
    );
  } catch (error) {
    initialResult = normalizeThrownAttemptError(error, normalizedRecordIds);
  }
  const retryRecordIds = collectRetryableEnhancementRecordIds(initialResult, {
    fallbackRecordIds: normalizedRecordIds,
  });
  if (retryRecordIds.length === 0) {
    return {
      ...initialResult,
      autoRetryHandled: true,
      autoRetryAttempted: false,
      autoRetryCount: 0,
      autoRetryRecordIds: [],
      autoRetryRecoveredIds: [],
      autoRetryStillFailedIds: [],
      autoRetryScheduled: false,
    };
  }

  const stopRequested = () => {
    if (typeof shouldStop !== "function") return false;
    try {
      return shouldStop() === true;
    } catch {
      return true;
    }
  };
  if (stopRequested()) {
    return {
      ...initialResult,
      autoRetryHandled: true,
      autoRetryAttempted: false,
      autoRetryCount: 0,
      autoRetryRecordIds: retryRecordIds,
      autoRetryRecoveredIds: [],
      autoRetryStillFailedIds: retryRecordIds,
      autoRetrySkippedReason: "stopped_before_retry",
      autoRetryScheduled: false,
    };
  }

  const retryMetadata = {
    recordIds: retryRecordIds,
    retryCount: 1,
    maxRetries: 1,
    initialResult,
    requiresContextRebuild: isRunnerContextFailure(initialResult),
    initialFailureCode: readTopLevelFailureCode(initialResult),
  };
  try {
    await onRetryScheduled?.(retryMetadata);
  } catch (error) {
    console.warn("[EnhancementRetry] retry scheduled hook failed:", error);
  }
  try {
    await waitBeforeRetry?.(retryMetadata);
  } catch (error) {
    console.warn("[EnhancementRetry] retry wait hook failed:", error);
  }
  if (stopRequested()) {
    return {
      ...initialResult,
      canceled: true,
      autoRetryHandled: true,
      autoRetryAttempted: false,
      autoRetryCount: 0,
      autoRetryRecordIds: retryRecordIds,
      autoRetryRecoveredIds: [],
      autoRetryStillFailedIds: retryRecordIds,
      autoRetrySkippedReason: "stopped_during_retry_wait",
      autoRetryScheduled: true,
    };
  }

  try {
    await onRetryStarted?.(retryMetadata);
  } catch (error) {
    console.warn("[EnhancementRetry] retry started hook failed:", error);
  }
  let retryResult;
  if (typeof prepareRetry === "function") {
    try {
      await prepareRetry(retryMetadata);
    } catch (error) {
      retryResult = normalizeAttemptResult(null, retryRecordIds, {
        thrownError: error,
        synthesizeMissing: true,
        missingMeansRecovery: true,
      });
      return {
        ...mergeEnhancementAttemptResults({
          initialResult,
          retryResult,
          retryRecordIds,
        }),
        autoRetryScheduled: true,
        autoRetryPreparationFailed: true,
      };
    }
  }
  try {
    const rawRetryResult = await runAttempt(retryRecordIds, {
      attempt: 2,
      isRetry: true,
    });
    retryResult = normalizeAttemptResult(rawRetryResult, retryRecordIds, {
      synthesizeMissing: true,
      missingMeansRecovery: true,
    });
  } catch (error) {
    retryResult = normalizeAttemptResult(null, retryRecordIds, {
      thrownError: error,
      synthesizeMissing: true,
      missingMeansRecovery: true,
    });
  }
  return {
    ...mergeEnhancementAttemptResults({
      initialResult,
      retryResult,
      retryRecordIds,
    }),
    autoRetryScheduled: true,
  };
}
