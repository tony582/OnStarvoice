// L2 trace-model: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createTraceModelStage({state, ports, operations}) {



  function normalizeCaptureTraceSequence(value) {
    if (
      value === null ||
      value === undefined ||
      (typeof value === 'string' && !value.trim())
    ) {
      return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function normalizeCaptureTrace(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const sequence = normalizeCaptureTraceSequence(value.sequence);
    const runId = String(value.runId || '').trim();
    const identityKey = String(value.identityKey || '').trim();
    if (sequence === null && !runId && !identityKey) {
      return null;
    }

    return {
      ...value,
      version: value.version ?? 1,
      runId,
      sequence,
      identityKey,
      state: String(value.state || '').trim(),
      recordId: String(value.recordId || '').trim(),
    };
  }

  function normalizeCompleteCaptureTrace(value) {
    const normalized = normalizeCaptureTrace(value);
    if (
      !normalized ||
      Number(normalized.version) !== 1 ||
      !normalized.runId ||
      normalized.sequence === null ||
      !normalized.identityKey ||
      !normalized.state
    ) {
      return null;
    }
    return normalized;
  }

  function selectBestCaptureTrace(candidates = []) {
    const normalized = (Array.isArray(candidates) ? candidates : [])
      .map((candidate) => normalizeCaptureTrace(candidate))
      .filter(Boolean);
    return (
      normalized.find((candidate) => normalizeCompleteCaptureTrace(candidate)) ||
      normalized[0] ||
      null
    );
  }

  function resolveCaptureTraceFromPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const firstItem = Array.isArray(payload.items) ? payload.items[0] : null;
    return selectBestCaptureTrace([
      payload.captureTrace,
      firstItem?.captureTrace,
    ]);
  }

  function resolveCaptureTraceFromRecord(record) {
    if (!record || typeof record !== 'object') {
      return null;
    }
    return selectBestCaptureTrace([
      record.captureTrace,
      resolveCaptureTraceFromPayload(record.payload),
      resolveCaptureTraceFromPayload(record.normalizedPayload),
      resolveCaptureTraceFromPayload(record.rawPayload),
      record.meta?.captureTrace,
    ]);
  }

  function bindCaptureTrace(trace, recordId, state = 'saved') {
    const normalized = normalizeCompleteCaptureTrace(trace);
    if (!normalized) {
      return null;
    }
    return {
      ...normalized,
      recordId: String(recordId || normalized.recordId || '').trim(),
      state: String(state || normalized.state || '').trim(),
    };
  }

  function applyCaptureTraceToPayload(payload, trace) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const normalized = normalizeCompleteCaptureTrace(trace);
    if (!normalized) {
      return source;
    }

    const next = {
      ...source,
      captureTrace: {...normalized},
    };
    if (Array.isArray(source.items) && source.items.length > 0) {
      next.items = source.items.map((item, index) =>
        index === 0 && item && typeof item === 'object'
          ? {...item, captureTrace: {...normalized}}
          : item,
      );
    }
    return next;
  }

  function applyCaptureTraceToRecord(record, trace) {
    if (!record || typeof record !== 'object') {
      return record;
    }
    const normalized = normalizeCompleteCaptureTrace(trace);
    if (!normalized) {
      return record;
    }

    const nextPayload = applyCaptureTraceToPayload(
      record.payload || record.normalizedPayload,
      normalized,
    );
    const rawPayload =
      record.rawPayload && typeof record.rawPayload === 'object'
        ? record.rawPayload
        : {};
    const nextRawPayload =
      Object.keys(rawPayload).length > 0
        ? applyCaptureTraceToPayload(rawPayload, normalized)
        : rawPayload;
    return {
      ...record,
      rawPayload: nextRawPayload,
      normalizedPayload: nextPayload,
      payload: nextPayload,
    };
  }

  function buildCaptureTraceBinding(trace) {
    const normalized = normalizeCompleteCaptureTrace(trace);
    if (!normalized || !normalized.recordId) {
      return null;
    }
    return {
      version: normalized.version,
      runId: normalized.runId,
      sequence: normalized.sequence,
      identityKey: normalized.identityKey,
      recordId: normalized.recordId,
      state: normalized.state,
    };
  }

  function compareCaptureTraceBindings(left, right) {
    const leftSequence = normalizeCaptureTraceSequence(left?.sequence);
    const rightSequence = normalizeCaptureTraceSequence(right?.sequence);
    if (leftSequence !== null || rightSequence !== null) {
      if (leftSequence === null) return 1;
      if (rightSequence === null) return -1;
      if (leftSequence !== rightSequence) return leftSequence - rightSequence;
    }
    const runCompare = String(left?.runId || '').localeCompare(
      String(right?.runId || ''),
    );
    if (runCompare !== 0) return runCompare;
    return String(left?.identityKey || '').localeCompare(
      String(right?.identityKey || ''),
    );
  }

  function mergeCaptureTraceBinding(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    const sameRun =
      String(existing.runId || '') === String(incoming.runId || '');
    const sameIdentity =
      String(existing.identityKey || '') === String(incoming.identityKey || '');
    if (!sameRun || !sameIdentity) {
      return incoming;
    }
    const existingSequence = normalizeCaptureTraceSequence(existing.sequence);
    const incomingSequence = normalizeCaptureTraceSequence(incoming.sequence);
    return {
      ...existing,
      ...incoming,
      sequence:
        existingSequence !== null && incomingSequence !== null
          ? Math.min(existingSequence, incomingSequence)
          : incomingSequence ?? existingSequence,
    };
  }

  function sortCaptureTraceBindings(bindings = []) {
    const byRecordId = new Map();
    (Array.isArray(bindings) ? bindings : []).forEach((binding) => {
      const normalized = buildCaptureTraceBinding(binding);
      if (!normalized) return;
      const key = normalized.recordId;
      byRecordId.set(
        key,
        mergeCaptureTraceBinding(byRecordId.get(key), normalized),
      );
    });
    return [...byRecordId.values()].sort(compareCaptureTraceBindings);
  }

  function upsertCaptureTraceBindings(target, bindings = []) {
    if (!Array.isArray(target)) return [];
    const sorted = sortCaptureTraceBindings([...target, ...bindings]);
    target.splice(0, target.length, ...sorted);
    return target;
  }

  function orderRecordIdsByCaptureTrace(recordIds = [], bindings = []) {
    const uniqueRecordIds = [
      ...new Set(
        (Array.isArray(recordIds) ? recordIds : [])
          .map((recordId) => String(recordId || '').trim())
          .filter(Boolean),
      ),
    ];
    const recordIdSet = new Set(uniqueRecordIds);
    const ordered = sortCaptureTraceBindings(bindings)
      .map((binding) => binding.recordId)
      .filter((recordId) => recordIdSet.has(recordId));
    const orderedSet = new Set(ordered);
    uniqueRecordIds.forEach((recordId) => {
      if (!orderedSet.has(recordId)) {
        ordered.push(recordId);
      }
    });
    return ordered;
  }

  return Object.freeze({
    normalizeCaptureTraceSequence,
    normalizeCaptureTrace,
    normalizeCompleteCaptureTrace,
    selectBestCaptureTrace,
    resolveCaptureTraceFromPayload,
    resolveCaptureTraceFromRecord,
    bindCaptureTrace,
    applyCaptureTraceToPayload,
    applyCaptureTraceToRecord,
    buildCaptureTraceBinding,
    compareCaptureTraceBindings,
    mergeCaptureTraceBinding,
    sortCaptureTraceBindings,
    upsertCaptureTraceBindings,
    orderRecordIdsByCaptureTrace,
  });
}
