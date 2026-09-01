import {
  isStorageQuotaError,
  runWithControlStorageReserveRetry,
  scheduleControlStorageReserveRestore,
} from "./storage.js";

const STORAGE_KEY_PREFIX =
  "onstarvoice.unattendedCheckpointReportOutbox.v2.";
const MAX_OUTBOX_ENTRIES = 20;
const MAX_PATCH_BYTES = 512 * 1024;
const TERMINAL_REJECTION_REASONS = new Set([
  "attempt_mismatch",
  "not_found",
  "stale_progress",
  "terminal",
]);
const ACKNOWLEDGED_DELIVERY_STATUSES = new Set([
  "acked",
  "acknowledged",
  "delivered",
]);
const OUTBOX_MUTATION_LOCK_NAME =
  "onstarvoice.unattendedCheckpointReportOutbox.v2.mutation";
const OUTBOX_MUTATION_QUEUE = Symbol.for(
  "onstarvoice.unattendedCheckpointReportOutbox.v2.mutationQueue",
);
const fallbackMutationQueues = new WeakMap();

let revisionCounter = 0;

function resolveStorageArea(storage) {
  const area = storage || globalThis.chrome?.storage?.local;
  if (
    !area ||
    typeof area.get !== "function" ||
    typeof area.set !== "function" ||
    typeof area.remove !== "function"
  ) {
    throw new Error("Chrome local storage is unavailable");
  }
  return area;
}

function normalizeIdentity(value) {
  return String(value || "").trim().slice(0, 160);
}

function cloneCheckpointPatch(patch) {
  const source =
    patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  if (
    !source.checkpoint ||
    typeof source.checkpoint !== "object" ||
    Array.isArray(source.checkpoint)
  ) {
    return null;
  }
  const allowedFields = [
    "status",
    "message",
    "checkpoint",
    "summary",
    "counts",
    "progressSeq",
    "businessProgressAt",
    "waitUntil",
    "recoveryWaitUntil",
  ];
  const safePatch = Object.fromEntries(
    allowedFields
      .filter((field) => Object.prototype.hasOwnProperty.call(source, field))
      .map((field) => [field, source[field]]),
  );
  try {
    const serialized = JSON.stringify(safePatch);
    if (!serialized || serialized.length > MAX_PATCH_BYTES) {
      return null;
    }
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function buildEntryId(requestId, attemptId) {
  return `${normalizeIdentity(requestId)}:${normalizeIdentity(attemptId)}`;
}

function nextRevision(nowMs) {
  revisionCounter = (revisionCounter + 1) % Number.MAX_SAFE_INTEGER;
  let nonce = "";
  try {
    nonce = globalThis.crypto?.randomUUID?.() || "";
  } catch {
    nonce = "";
  }
  if (!nonce) {
    nonce = `${Math.random().toString(36).slice(2)}-${Math.random()
      .toString(36)
      .slice(2)}`;
  }
  return `${Math.max(0, Number(nowMs) || 0)}-${revisionCounter}-${nonce}`;
}

function buildStorageKey(revision) {
  return `${STORAGE_KEY_PREFIX}${revision}`;
}

function normalizeEntry(value, storageKey = "") {
  const source = value && typeof value === "object" ? value : {};
  const entry = {
    storageKey: String(storageKey || ""),
    id: normalizeIdentity(source.id),
    requestId: normalizeIdentity(source.requestId),
    attemptId: normalizeIdentity(source.attemptId),
    patch: cloneCheckpointPatch(source.patch),
    revision: normalizeIdentity(source.revision),
    createdAt: String(source.createdAt || ""),
    updatedAt: String(source.updatedAt || ""),
    deliveryStatus: String(
      source.deliveryStatus || source.outboxStatus || "",
    )
      .trim()
      .toLowerCase(),
    acknowledgedAt: String(
      source.acknowledgedAt || source.ackedAt || source.deliveredAt || "",
    ).trim(),
    acknowledged:
      source.acknowledged === true ||
      source.acked === true ||
      source.delivered === true,
  };
  return entry.storageKey.startsWith(STORAGE_KEY_PREFIX) &&
    entry.id &&
    entry.requestId &&
    entry.attemptId &&
    entry.patch &&
    entry.revision
    ? entry
    : null;
}

function storedEntryValue(entry) {
  const value = {
    id: entry.id,
    requestId: entry.requestId,
    attemptId: entry.attemptId,
    patch: entry.patch,
    revision: entry.revision,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
  if (entry.deliveryStatus) value.deliveryStatus = entry.deliveryStatus;
  if (entry.acknowledgedAt) value.acknowledgedAt = entry.acknowledgedAt;
  if (entry.acknowledged) value.acknowledged = true;
  return value;
}

function entryWasAcknowledged(entry) {
  return Boolean(
    entry?.acknowledged ||
      entry?.acknowledgedAt ||
      ACKNOWLEDGED_DELIVERY_STATUSES.has(entry?.deliveryStatus),
  );
}

async function runStorageMutation(storage, mutation) {
  const lockManager = globalThis.navigator?.locks;
  if (lockManager && typeof lockManager.request === "function") {
    return await lockManager.request(
      OUTBOX_MUTATION_LOCK_NAME,
      {mode: "exclusive"},
      mutation,
    );
  }

  let previous = fallbackMutationQueues.get(storage) || Promise.resolve();
  try {
    previous = storage[OUTBOX_MUTATION_QUEUE] || previous;
  } catch {
    // Some browser API proxy objects do not allow expando properties.
  }
  const result = previous.then(mutation, mutation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  fallbackMutationQueues.set(storage, settled);
  try {
    storage[OUTBOX_MUTATION_QUEUE] = settled;
  } catch {
    // The module-local WeakMap still serializes this document. Real Extension
    // documents use the origin-wide Web Locks path above.
  }
  return await result;
}

async function readEntries(storage) {
  const result = await storage.get(null);
  return Object.entries(result && typeof result === "object" ? result : {})
    .filter(([key]) => key.startsWith(STORAGE_KEY_PREFIX))
    .map(([key, value]) => normalizeEntry(value, key))
    .filter(Boolean);
}

function progressSequence(entry) {
  const parsed = Number(entry?.patch?.progressSeq);
  return Number.isFinite(parsed) ? Math.floor(parsed) : -1;
}

function timestamp(entry) {
  const parsed = Date.parse(String(entry?.updatedAt || entry?.createdAt || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareNewest(left, right) {
  const sequenceDifference = progressSequence(left) - progressSequence(right);
  if (sequenceDifference !== 0) return sequenceDifference;
  const timestampDifference = timestamp(left) - timestamp(right);
  if (timestampDifference !== 0) return timestampDifference;
  return String(left?.revision || "").localeCompare(
    String(right?.revision || ""),
  );
}

async function removeExactKeys(storage, keys) {
  const normalized = Array.from(
    new Set((Array.isArray(keys) ? keys : [keys]).filter(Boolean)),
  );
  if (normalized.length === 0) return 0;
  await storage.remove(normalized);
  scheduleControlStorageReserveRestore({storage});
  return normalized.length;
}

async function pruneEntries(storage) {
  const entries = await readEntries(storage);
  const newestByAttempt = new Map();
  for (const entry of entries) {
    const existing = newestByAttempt.get(entry.id);
    if (!existing || compareNewest(entry, existing) > 0) {
      newestByAttempt.set(entry.id, entry);
    }
  }
  const duplicateKeys = entries
    .filter(
      (entry) => newestByAttempt.get(entry.id)?.storageKey !== entry.storageKey,
    )
    .map((entry) => entry.storageKey);
  const acknowledgedKeys = entries
    .filter(entryWasAcknowledged)
    .map((entry) => entry.storageKey);
  // A distinct, unacknowledged attempt is durable business evidence. Capacity
  // pressure may reject a new attempt, but must never evict an existing active,
  // unsynced, failed, or needs_action checkpoint. Only a superseded snapshot
  // for the same attempt, or an explicitly ACKed row, is safe to remove.
  await removeExactKeys(storage, duplicateKeys.concat(acknowledgedKeys));
  return await readEntries(storage);
}

async function setEntryWithOneQuotaRetry(storage, storageKey, entry) {
  const value = storedEntryValue(entry);
  let writeAttempts = 0;
  let initialWriteError = null;
  try {
    const result = await runWithControlStorageReserveRetry(
      async () => {
        writeAttempts += 1;
        try {
          await storage.set({[storageKey]: value});
        } catch (error) {
          if (writeAttempts === 1) initialWriteError = error;
          throw error;
        }
      },
      {storage},
    );
    return {ok: true, retried: result.retried};
  } catch (error) {
    return {
      ok: false,
      reason: isStorageQuotaError(error)
        ? "storage_quota"
        : "storage_error",
      error,
      retried: writeAttempts > 1,
      ...(writeAttempts > 1 ? {initialError: initialWriteError} : {}),
    };
  }
}

async function removeEntryIfRevisionMatches(storage, entry) {
  const stored = await storage.get(entry.storageKey);
  const current = normalizeEntry(stored?.[entry.storageKey], entry.storageKey);
  if (!current || current.revision !== entry.revision) return false;
  await storage.remove(entry.storageKey);
  scheduleControlStorageReserveRestore({storage});
  return true;
}

export async function enqueueUnattendedCheckpointReport(
  {requestId = "", attemptId = "", patch = {}} = {},
  {storage = null, now = () => Date.now()} = {},
) {
  const normalizedRequestId = normalizeIdentity(requestId);
  const normalizedAttemptId = normalizeIdentity(attemptId);
  const safePatch = cloneCheckpointPatch(patch);
  if (!normalizedRequestId || !normalizedAttemptId || !safePatch) {
    return {ok: false, reason: "invalid_checkpoint_report"};
  }
  try {
    const area = resolveStorageArea(storage);
    const nowMs = Math.max(0, Number(now()) || Date.now());
    const timestampText = new Date(nowMs).toISOString();
    const revision = nextRevision(nowMs);
    const immutableStorageKey = buildStorageKey(revision);
    const candidate = {
      storageKey: immutableStorageKey,
      id: buildEntryId(normalizedRequestId, normalizedAttemptId),
      requestId: normalizedRequestId,
      attemptId: normalizedAttemptId,
      patch: safePatch,
      revision,
      createdAt: timestampText,
      updatedAt: timestampText,
    };
    return await runStorageMutation(area, async () => {
      // Compact before the write. In particular, updating an existing attempt
      // reuses its storage key, so a full store does not need room for a
      // transient twenty-first immutable document.
      const retainedBeforeWrite = await pruneEntries(area);
      const existing = retainedBeforeWrite.find(
        (entry) => entry.id === candidate.id,
      );
      if (existing && compareNewest(candidate, existing) <= 0) {
        return {ok: true, reason: "superseded", entry: existing};
      }
      if (!existing && retainedBeforeWrite.length >= MAX_OUTBOX_ENTRIES) {
        return {ok: false, reason: "outbox_capacity"};
      }

      const storageKey = existing?.storageKey || immutableStorageKey;
      const entry = {
        ...candidate,
        storageKey,
        // Preserve fields not present in a partial checkpoint patch, while the
        // new checkpoint itself replaces the old cumulative checkpoint.
        patch: existing
          ? cloneCheckpointPatch({...existing.patch, ...candidate.patch}) ||
            candidate.patch
          : candidate.patch,
      };
      const written = await setEntryWithOneQuotaRetry(
        area,
        storageKey,
        entry,
      );
      if (!written.ok) return written;

      const stored = await area.get(storageKey);
      const durable = normalizeEntry(stored?.[storageKey], storageKey);
      if (!durable) {
        return {ok: false, reason: "storage_error"};
      }
      if (durable.revision !== entry.revision) {
        return compareNewest(durable, entry) >= 0
          ? {ok: true, reason: "superseded", entry: durable}
          : {ok: false, reason: "storage_conflict"};
      }
      return {
        ok: true,
        reason: "queued",
        entry: durable,
        retried: written.retried,
      };
    });
  } catch (error) {
    return {
      ok: false,
      reason: isStorageQuotaError(error) ? "storage_quota" : "storage_error",
      error,
    };
  }
}

export async function discardUnattendedCheckpointReports(
  {requestId = "", attemptId = ""} = {},
  {storage = null} = {},
) {
  const normalizedRequestId = normalizeIdentity(requestId);
  const normalizedAttemptId = normalizeIdentity(attemptId);
  if (!normalizedRequestId) return {ok: false, removed: 0};
  try {
    const area = resolveStorageArea(storage);
    return await runStorageMutation(area, async () => {
      const entries = await readEntries(area);
      const keys = entries
        .filter(
          (entry) =>
            entry.requestId === normalizedRequestId &&
            (!normalizedAttemptId || entry.attemptId === normalizedAttemptId),
        )
        .map((entry) => entry.storageKey);
      await removeExactKeys(area, keys);
      return {ok: true, removed: keys.length};
    });
  } catch (error) {
    return {ok: false, removed: 0, error};
  }
}

export async function flushUnattendedCheckpointReportOutbox(
  {send, limit = MAX_OUTBOX_ENTRIES} = {},
  {storage = null} = {},
) {
  if (typeof send !== "function") {
    throw new TypeError("outbox send must be a function");
  }
  const area = resolveStorageArea(storage);
  const entries = (await runStorageMutation(
    area,
    () => pruneEntries(area),
  )).sort((left, right) => {
    const timeDifference = timestamp(left) - timestamp(right);
    return timeDifference || compareNewest(left, right);
  });
  const selected = entries.slice(0, Math.max(1, Number(limit) || 1));
  let delivered = 0;
  let discarded = 0;
  for (const entry of selected) {
    let response;
    try {
      response = await send({
        type: "onstarvoice:update-unattended-keyword-run",
        requestId: entry.requestId,
        attemptId: entry.attemptId,
        patch: entry.patch,
      });
    } catch (error) {
      return {
        ok: false,
        reason: "transport_error",
        delivered,
        discarded,
        retained: (await readEntries(area)).length,
        error,
      };
    }
    const accepted =
      response?.accepted === true && response?.ok !== false;
    const explicitRejection = response?.accepted === false;
    const reason = String(response?.reason || "");
    if (
      accepted ||
      (explicitRejection && TERMINAL_REJECTION_REASONS.has(reason))
    ) {
      await runStorageMutation(
        area,
        () => removeEntryIfRevisionMatches(area, entry),
      );
      if (accepted) delivered += 1;
      else discarded += 1;
      continue;
    }
    return {
      ok: false,
      reason: reason || (explicitRejection ? "rejected" : "no_response"),
      delivered,
      discarded,
      retained: (await readEntries(area)).length,
    };
  }
  return {
    ok: true,
    reason: "drained",
    delivered,
    discarded,
    retained: (await readEntries(area)).length,
  };
}

export const UNATTENDED_CHECKPOINT_REPORT_OUTBOX_STORAGE_KEY =
  STORAGE_KEY_PREFIX;
export const UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES =
  MAX_OUTBOX_ENTRIES;
