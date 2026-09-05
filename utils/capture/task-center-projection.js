(function installCaptureTaskCenterProjection(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module?.exports) {
    module.exports = api;
  }
  root.OnStarvoiceCaptureTaskCenterProjection = api;
})(
  typeof globalThis !== 'undefined' ? globalThis : self,
  function createCaptureTaskCenterProjectionApi() {
    function buildTaskCenterCheckpointFromUnattendedRequest(request) {
      const source =
        request?.checkpoint && typeof request.checkpoint === 'object'
          ? request.checkpoint
          : {};
      const keywordResults = Array.isArray(source.keywordResults)
        ? source.keywordResults
        : [];
      const collect = (statuses) =>
        Array.from(
          new Set(
            keywordResults
              .filter((entry) => statuses.has(String(entry?.status || '')))
              .map((entry) => String(entry?.keyword || '').trim())
              .filter(Boolean),
          ),
        );
      const attempts = keywordResults.reduce((result, entry) => {
        const keyword = String(entry?.keyword || '').trim();
        if (keyword) {
          result[keyword] = Math.max(0, Number(entry?.attemptCount) || 0);
        }
        return result;
      }, {});
      return {
        round: Math.max(1, Number(source.round) || 1),
        keywordIndex: Math.max(
          0,
          Number(source.keywordIndex ?? source.activeKeywordIndex) || 0,
        ),
        currentKeyword: String(
          source.currentKeyword || source.activeKeyword || request?.progress?.keyword || '',
        ),
        phase: String(source.phase || source.activePhase || request?.progress?.phase || ''),
        completedKeywords:
          keywordResults.length > 0
            ? collect(new Set(['completed']))
            : Array.isArray(source.completedKeywords)
              ? source.completedKeywords
              : [],
        failedKeywords:
          keywordResults.length > 0
            ? collect(new Set(['failed', 'partial']))
            : Array.isArray(source.failedKeywords)
              ? source.failedKeywords
              : [],
        skippedKeywords:
          keywordResults.length > 0
            ? collect(new Set(['skipped']))
            : Array.isArray(source.skippedKeywords)
              ? source.skippedKeywords
              : [],
        keywordResults: keywordResults.slice(0, 500).map((entry) => ({
          round: Math.max(1, Number(entry?.round) || 1),
          index: Math.max(0, Number(entry?.index) || 0),
          keyword: String(entry?.keyword || '').trim(),
          status: String(entry?.status || '').trim(),
          attemptCount: Math.max(0, Number(entry?.attemptCount) || 0),
          savedCount: Math.max(0, Number(entry?.savedCount) || 0),
          noResults: entry?.noResults === true,
          resultKind: String(entry?.resultKind || '').trim(),
          candidateCount: Math.max(0, Number(entry?.candidateCount) || 0),
          scanComplete: entry?.scanComplete === true,
          error: String(entry?.error || '').trim(),
          errorCode: String(entry?.errorCode || '').trim(),
          errorCategory: String(entry?.errorCategory || '').trim(),
          securityBlocked: entry?.securityBlocked === true,
          requiresManualAction: entry?.requiresManualAction === true,
          finishedAt: String(entry?.finishedAt || ''),
        })),
        attempts:
          keywordResults.length > 0
            ? attempts
            : source.attempts && typeof source.attempts === 'object'
              ? source.attempts
              : {},
      };
    }

    function buildUnattendedTaskCounts(request, previousCounts = {}) {
      const summary =
        request?.summary && typeof request.summary === 'object'
          ? request.summary
          : {};
      const counts =
        request?.counts && typeof request.counts === 'object'
          ? request.counts
          : {};
      const read = (name, aliases = []) => {
        const values = [counts[name], ...aliases.map((alias) => summary[alias])];
        const value = values.find((candidate) => Number.isFinite(Number(candidate)));
        return value == null
          ? Math.max(0, Number(previousCounts?.[name]) || 0)
          : Math.max(0, Math.floor(Number(value)));
      };
      const completed = read('success', ['success', 'completed']);
      const failed = read('failed', ['failed']);
      const skipped = read('skipped', ['skipped']);
      const warnings = read('warnings', ['partial', 'warnings']);
      const total = read('total', ['total']);
      return {
        total,
        processed: read('processed', ['processed']) ||
          Math.min(total || Number.MAX_SAFE_INTEGER, completed + failed + skipped + warnings),
        saved: read('saved', ['saved']),
        success: completed,
        failed,
        skipped,
        retried: read('retried', ['retries', 'retried']),
        warnings,
      };
    }

    return {
      buildTaskCenterCheckpointFromUnattendedRequest,
      buildUnattendedTaskCounts,
    };
  },
);
