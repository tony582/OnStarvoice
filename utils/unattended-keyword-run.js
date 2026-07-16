const DEFAULT_MAX_ATTEMPTS = 2;

function text(value) {
  return String(value == null ? "" : value).trim();
}

function positiveInt(value, fallback = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function buildCheckpointKeywordKey(round, keyword) {
  return `${positiveInt(round)}:${text(keyword)}`;
}

export function normalizeUnattendedKeywordCheckpoint(
  request = {},
  keywords = [],
  {maxRounds = Number.MAX_SAFE_INTEGER} = {},
) {
  const source =
    request?.checkpoint && typeof request.checkpoint === "object"
      ? request.checkpoint
      : request && typeof request === "object"
        ? request
        : {};
  const normalizedKeywords = keywords.map(text).filter(Boolean);
  const keywordSet = new Set(normalizedKeywords);
  const normalizedMaxRounds = positiveInt(maxRounds, Number.MAX_SAFE_INTEGER);
  const seen = new Set();
  const keywordResults = [];

  for (const rawEntry of Array.isArray(source.keywordResults)
    ? source.keywordResults
    : []) {
    const keyword = text(rawEntry?.keyword);
    const round = positiveInt(rawEntry?.round);
    if (round > normalizedMaxRounds) continue;
    const key = buildCheckpointKeywordKey(round, keyword);
    if (!keyword || !keywordSet.has(keyword) || seen.has(key)) continue;
    seen.add(key);
    keywordResults.push({
      round,
      // 旧快照中的 DOM/index 可能已经失真；永远按当前计划关键词顺序重算。
      index: Math.max(0, normalizedKeywords.indexOf(keyword)),
      keyword,
      status: text(rawEntry?.status) || "failed",
      attemptCount: nonNegativeInt(rawEntry?.attemptCount),
      savedCount: nonNegativeInt(rawEntry?.savedCount),
      error: text(rawEntry?.error),
      finishedAt: text(rawEntry?.finishedAt),
    });
  }

  const activeKeyword = text(source.activeKeyword);
  return {
    schemaVersion: 1,
    round: Math.min(positiveInt(source.round), normalizedMaxRounds),
    activeKeywordIndex: Math.max(0, normalizedKeywords.indexOf(activeKeyword)),
    activeKeyword,
    activePhase: text(source.activePhase) || "pending",
    keywordResults,
    updatedAt: text(source.updatedAt) || new Date().toISOString(),
  };
}

export function resolveCompletedCheckpointKeywords(checkpoint = {}, round = 1) {
  const normalizedRound = positiveInt(round);
  return new Set(
    (Array.isArray(checkpoint?.keywordResults) ? checkpoint.keywordResults : [])
      .filter(
        (entry) =>
          positiveInt(entry?.round) === normalizedRound &&
          text(entry?.status) === "completed",
      )
      .map((entry) => text(entry?.keyword))
      .filter(Boolean),
  );
}

export function findUnattendedResumeKeyword(
  checkpoint,
  keywords,
  {maxAttempts = DEFAULT_MAX_ATTEMPTS} = {},
) {
  const normalizedKeywords = keywords.map(text).filter(Boolean);
  const round = positiveInt(checkpoint?.round);
  const completed = resolveCompletedCheckpointKeywords(checkpoint, round);
  const exhausted = new Set(
    (Array.isArray(checkpoint?.keywordResults) ? checkpoint.keywordResults : [])
      .filter(
        (entry) =>
          positiveInt(entry?.round) === round &&
          text(entry?.status) === "failed" &&
          nonNegativeInt(entry?.attemptCount) >= positiveInt(maxAttempts),
      )
      .map((entry) => text(entry?.keyword))
      .filter(Boolean),
  );
  return (
    normalizedKeywords.find(
      (keyword) => !completed.has(keyword) && !exhausted.has(keyword),
    ) || ""
  );
}

export function advanceUnattendedCheckpointRound({
  checkpoint = {},
  keywords = [],
  completedRound = 1,
  maxRounds = Number.MAX_SAFE_INTEGER,
  now = new Date(),
} = {}) {
  const normalizedMaxRounds = positiveInt(maxRounds, Number.MAX_SAFE_INTEGER);
  const normalizedCompletedRound = Math.min(
    positiveInt(completedRound),
    normalizedMaxRounds,
  );
  const nextCheckpoint = normalizeUnattendedKeywordCheckpoint(
    checkpoint,
    keywords,
    {maxRounds: normalizedMaxRounds},
  );
  const nextRound = Math.min(
    normalizedMaxRounds,
    Math.max(positiveInt(nextCheckpoint.round), normalizedCompletedRound + 1),
  );
  const updatedAt =
    now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  nextCheckpoint.round = nextRound;
  nextCheckpoint.activeKeywordIndex = 0;
  nextCheckpoint.activeKeyword = "";
  nextCheckpoint.activePhase =
    nextRound > normalizedCompletedRound ? "waiting_next_round" : "completed";
  nextCheckpoint.updatedAt = updatedAt;
  return nextCheckpoint;
}

export function summarizeUnattendedKeywordCheckpoint(checkpoint = {}) {
  return (Array.isArray(checkpoint?.keywordResults)
    ? checkpoint.keywordResults
    : []
  ).reduce(
    (summary, entry) => {
      const status = text(entry?.status);
      if (status === "completed") summary.completed += 1;
      else if (status === "partial") summary.partial += 1;
      else if (status === "failed") summary.failed += 1;
      else if (status === "skipped") summary.skipped += 1;
      summary.saved += nonNegativeInt(entry?.savedCount);
      summary.retries += Math.max(0, nonNegativeInt(entry?.attemptCount) - 1);
      return summary;
    },
    {completed: 0, partial: 0, failed: 0, skipped: 0, saved: 0, retries: 0},
  );
}

export function isUnattendedSafetyBlock(value) {
  const valueText = text(value?.message || value).toLowerCase();
  const codeText = text(value?.code || value?.reason).toLowerCase();
  return (
    /(captcha|login|auth|security|risk|forbidden|account|challenge)/i.test(
      codeText,
    ) ||
    /(验证码|人机验证|安全限制|安全验证|访问频繁|访问受限|风控|登录失效|请(?:先|重新)?登录|重新登录|账号异常|账号限制|captcha|security.?block|security.?check|login.?required|risk.?control|challenge)/i.test(
      valueText,
    )
  );
}

export function mergeKeywordAttemptResults({
  previous = null,
  next = null,
  allKeywords = [],
  completedBeforeRun = new Set(),
} = {}) {
  const resultByKeyword = new Map();
  for (const item of [
    ...(Array.isArray(previous?.results) ? previous.results : []),
    ...(Array.isArray(next?.results) ? next.results : []),
  ]) {
    const keyword = text(item?.keyword);
    if (!keyword) continue;
    const existing = resultByKeyword.get(keyword);
    if (!existing || existing.ok !== true || item?.ok === true) {
      resultByKeyword.set(keyword, item);
    }
  }

  const results = Array.from(resultByKeyword.values());
  const success =
    completedBeforeRun.size + results.filter((item) => item?.ok === true).length;
  const failed = results.filter((item) => item?.ok !== true).length;
  return {
    ok: !next?.canceled && !next?.securityBlocked && failed === 0,
    canceled: Boolean(previous?.canceled || next?.canceled),
    securityBlocked: Boolean(
      previous?.securityBlocked ||
        next?.securityBlocked ||
        results.some((item) => item?.securityBlocked),
    ),
    results,
    stats: {
      total: allKeywords.length,
      processed: Math.min(allKeywords.length, success + failed),
      success,
      failed,
    },
  };
}

export function reconcileEnhancementRetryCheckpoint({
  checkpoint = {},
  keywords = [],
  round = 1,
  batchResults = [],
  successRecordIds = [],
  now = new Date(),
} = {}) {
  const nextCheckpoint = normalizeUnattendedKeywordCheckpoint(
    checkpoint,
    keywords,
  );
  const successfulIds = new Set(
    (Array.isArray(successRecordIds) ? successRecordIds : [])
      .map(text)
      .filter(Boolean),
  );
  const normalizedRound = positiveInt(round);
  const finishedAt =
    now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const completedKeywords = [];

  for (const keywordResult of Array.isArray(batchResults) ? batchResults : []) {
    const keyword = text(keywordResult?.keyword);
    if (!keyword || keywordResult?.enhanceStatus !== "failed") continue;
    const detailResults = Array.isArray(keywordResult?.enhanceResult?.results)
      ? keywordResult.enhanceResult.results
      : [];
    const failedItems = detailResults.filter((item) => item?.ok !== true);
    if (
      failedItems.length === 0 ||
      failedItems.some((item) => {
        const recordId = text(item?.recordId);
        return !recordId || !successfulIds.has(recordId);
      })
    ) {
      continue;
    }

    keywordResult.enhanceStatus = "done";
    keywordResult.partial = false;
    keywordResult.warning = "";
    const entry = nextCheckpoint.keywordResults.find(
      (candidate) =>
        positiveInt(candidate?.round) === normalizedRound &&
        text(candidate?.keyword) === keyword,
    );
    if (!entry) continue;
    entry.status = "completed";
    entry.error = "";
    entry.finishedAt = finishedAt;
    entry.savedCount = Math.max(
      nonNegativeInt(entry.savedCount),
      Array.isArray(keywordResult?.recordIds)
        ? keywordResult.recordIds.length
        : 0,
    );
    completedKeywords.push(keyword);
  }

  if (completedKeywords.length > 0) {
    nextCheckpoint.activePhase = "completed";
    nextCheckpoint.updatedAt = finishedAt;
  }
  return {
    checkpoint: nextCheckpoint,
    changed: completedKeywords.length > 0,
    completedKeywords,
    summary: summarizeUnattendedKeywordCheckpoint(nextCheckpoint),
  };
}

export function settleUnattendedKeywordCheckpoint({
  checkpoint,
  keywords = [],
  round = 1,
  originalIndex = 0,
  keyword = "",
  result = {},
  recordIds = [],
  attempt = 1,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  securityBlocked = false,
  canceled = false,
  now = new Date(),
} = {}) {
  const nextCheckpoint = normalizeUnattendedKeywordCheckpoint(
    checkpoint || {},
    keywords,
  );
  const normalizedKeyword = text(keyword);
  if (!normalizedKeyword) {
    return {
      checkpoint: nextCheckpoint,
      entry: null,
      summary: summarizeUnattendedKeywordCheckpoint(nextCheckpoint),
    };
  }

  const normalizedRound = positiveInt(round);
  const entryKey = buildCheckpointKeywordKey(
    normalizedRound,
    normalizedKeyword,
  );
  const previousIndex = nextCheckpoint.keywordResults.findIndex(
    (entry) =>
      buildCheckpointKeywordKey(entry.round, entry.keyword) === entryKey,
  );
  const previous =
    previousIndex >= 0 ? nextCheckpoint.keywordResults[previousIndex] : null;
  const attemptCount = Math.max(
    nonNegativeInt(previous?.attemptCount) + 1,
    positiveInt(attempt),
  );
  const partial = Boolean(
    result?.partial ||
      result?.enhanceStatus === "failed" ||
      result?.commentsResult?.phase === "comments_partial",
  );
  const status = securityBlocked
    ? "failed"
    : canceled
      ? "partial"
      : result?.ok === true && !partial
        ? "completed"
      : result?.ok === true
          ? attemptCount >= positiveInt(maxAttempts)
            ? "failed"
            : "partial"
          : attemptCount >= positiveInt(maxAttempts)
            ? "failed"
            : "retrying";
  const finishedAt =
    now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const entry = {
    round: normalizedRound,
    index: nonNegativeInt(
      originalIndex,
      Math.max(0, keywords.map(text).indexOf(normalizedKeyword)),
    ),
    keyword: normalizedKeyword,
    status,
    attemptCount,
    savedCount: Math.max(
      nonNegativeInt(previous?.savedCount),
      Array.isArray(recordIds) ? recordIds.length : 0,
    ),
    error: text(
      result?.error?.message ||
        result?.error ||
        result?.warning ||
        (securityBlocked ? "触发平台安全限制" : ""),
    ),
    finishedAt,
  };

  if (previousIndex >= 0) nextCheckpoint.keywordResults[previousIndex] = entry;
  else nextCheckpoint.keywordResults.push(entry);
  nextCheckpoint.round = normalizedRound;
  nextCheckpoint.activeKeywordIndex = entry.index;
  nextCheckpoint.activeKeyword = normalizedKeyword;
  nextCheckpoint.activePhase = status;
  nextCheckpoint.updatedAt = finishedAt;

  return {
    checkpoint: nextCheckpoint,
    entry,
    summary: summarizeUnattendedKeywordCheckpoint(nextCheckpoint),
  };
}
