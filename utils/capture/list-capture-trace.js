export const LIST_CAPTURE_TRACE_VERSION = 1;

const ACCEPTED_OUTCOMES = new Set([
  "accepted",
  "captured",
  "collected",
  "qualified",
  "success",
]);
const NON_ACCEPTED_OUTCOMES = new Set([
  "ai_skipped",
  "cancelled",
  "error",
  "failed",
  "filtered",
  "ignored",
  "rejected",
  "skipped",
]);

function cleanText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function normalizeIdentityId(value) {
  return cleanText(value).replace(/^#/, "").toLowerCase();
}

function extractUrlIdentity(rawUrl) {
  const raw = cleanText(rawUrl).replaceAll("&amp;", "&");
  if (!raw) return null;

  try {
    const parsed = new URL(raw, "https://universalvoice.invalid");
    const path = parsed.pathname.replace(/\/+$/u, "") || "/";
    const identityQueryKeys = [
      "modal_id",
      "note_id",
      "item_id",
      "aweme_id",
      "id",
    ];
    const identityQuery = identityQueryKeys
      .map((key) => [key, cleanText(parsed.searchParams.get(key))])
      .find(([, value]) => Boolean(value));
    const host =
      parsed.hostname === "universalvoice.invalid"
        ? ""
        : parsed.hostname.toLowerCase();
    return {
      canonical: `${host}${path}${
        identityQuery ? `?${identityQuery[0]}=${identityQuery[1]}` : ""
      }`,
      path,
      queryId: identityQuery?.[1] || "",
    };
  } catch {
    return {canonical: raw.split(/[?#]/u)[0], path: "", queryId: ""};
  }
}

function extractRouteId(rawUrl) {
  const urlIdentity = extractUrlIdentity(rawUrl);
  if (!urlIdentity) return "";
  if (urlIdentity.queryId) return normalizeIdentityId(urlIdentity.queryId);
  const match = urlIdentity.path.match(
    /\/(?:explore|discovery\/item|video|note)\/([^/?#]+)/iu,
  );
  return normalizeIdentityId(match?.[1]);
}

function addAlias(target, type, value) {
  const normalized = cleanText(value).toLowerCase();
  if (!normalized) return;
  target.add(`${type}:${normalized}`);
}

function normalizeIdentityKey(value) {
  const normalized = cleanText(value).toLowerCase();
  if (!normalized || normalized.length > 720) return "";
  if (/^(?:id|url|dom|fallback|trace):/u.test(normalized)) return normalized;
  return `trace:${normalized}`;
}

export function buildListCaptureItemAliases(
  item = {},
  {includeTraceIdentity = true} = {},
) {
  const aliases = new Set();
  const locator = item.domLocator || {};
  const hints = item.domMatchHints || {};
  const rawIds = [
    item.noteId,
    item.note_id,
    item.awemeId,
    item.aweme_id,
    item.itemId,
    item.item_id,
    locator.dataAwemeId,
    locator.dataE2eAwemeId,
  ];
  rawIds.forEach((value) => addAlias(aliases, "id", normalizeIdentityId(value)));

  const rawUrls = [
    item.url,
    item.noteUrl,
    item.detailPageUrl,
    locator.href,
    hints.noteUrl,
  ];
  rawUrls.forEach((rawUrl) => {
    const identity = extractUrlIdentity(rawUrl);
    if (!identity) return;
    addAlias(aliases, "url", identity.canonical);
    addAlias(aliases, "id", extractRouteId(rawUrl));
  });

  const traceIdentity = includeTraceIdentity
    ? normalizeIdentityKey(item.captureTrace?.identityKey)
    : "";
  const hasStableAlias =
    Array.from(aliases).some(
      (alias) => alias.startsWith("id:") || alias.startsWith("url:"),
    ) ||
    traceIdentity.startsWith("id:") ||
    traceIdentity.startsWith("url:");
  if (!hasStableAlias) {
    addAlias(aliases, "dom", item.domCaptureKey);
  }

  if (includeTraceIdentity) {
    if (
      traceIdentity &&
      (!traceIdentity.startsWith("dom:") || !hasStableAlias)
    ) {
      aliases.add(traceIdentity);
    }
  }

  if (aliases.size === 0) {
    const fallbackParts = [
      item.title || hints.titleSnippet,
      item.author || hints.authorSnippet,
      item.coverImageUrl || hints.coverImageUrl,
    ].map(cleanText);
    if (fallbackParts.some(Boolean)) {
      addAlias(aliases, "fallback", fallbackParts.join("|"));
    }
  }

  return Array.from(aliases);
}

export function hasStrongListCaptureIdentity(item = {}) {
  return buildListCaptureItemAliases(item, {includeTraceIdentity: false}).some(
    (alias) =>
      alias.startsWith("id:") ||
      alias.startsWith("url:") ||
      alias.startsWith("dom:"),
  );
}

export function hasConflictingListCaptureAliases(aliases = []) {
  const stableIds = new Set(
    (Array.isArray(aliases) ? aliases : []).filter((alias) =>
      String(alias || "").startsWith("id:"),
    ),
  );
  return stableIds.size > 1;
}

export function normalizeListCaptureTrace(trace, {runId = ""} = {}) {
  if (!trace || typeof trace !== "object") return null;
  if (Number(trace.version) !== LIST_CAPTURE_TRACE_VERSION) return null;

  const normalizedRunId = cleanText(trace.runId);
  const expectedRunId = cleanText(runId);
  const sequence = Number(trace.sequence);
  const identityKey = normalizeIdentityKey(trace.identityKey);
  const state = cleanText(trace.state).toLowerCase().replace(/[\s-]+/gu, "_");

  if (!normalizedRunId || normalizedRunId.length > 320) return null;
  if (expectedRunId && normalizedRunId !== expectedRunId) return null;
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
  if (!identityKey) return null;
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(state)) return null;

  const normalized = {
    version: LIST_CAPTURE_TRACE_VERSION,
    runId: normalizedRunId,
    sequence,
    identityKey,
    state,
  };
  const recordId = cleanText(trace.recordId);
  if (recordId) normalized.recordId = recordId;
  return normalized;
}

function resolveItemOutcome(item, fallbackOutcome = "accepted") {
  const explicit =
    item?.harvestOutcome ??
    item?.listOutcome ??
    item?.outcome ??
    item?.status ??
    "";
  const normalized = cleanText(explicit || fallbackOutcome)
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
  if (NON_ACCEPTED_OUTCOMES.has(normalized)) return normalized;
  if (ACCEPTED_OUTCOMES.has(normalized)) return "accepted";
  return "ignored";
}

export function createListCaptureAcceptanceLedger({runId = ""} = {}) {
  const normalizedRunId = cleanText(runId);
  if (!normalizedRunId) {
    throw new Error("list capture trace runId is required");
  }

  const aliasToTrace = new Map();
  const traceBySequence = new Map();
  let nextSequence = 1;

  const acceptItems = (items, {fallbackOutcome = "accepted"} = {}) =>
    (Array.isArray(items) ? items : []).map((sourceItem) => {
      const item =
        sourceItem && typeof sourceItem === "object" ? {...sourceItem} : {};
      // The acceptance ledger is the only sequence authority. Never preserve a
      // caller-supplied trace when this item cannot be accepted safely.
      delete item.captureTrace;
      if (resolveItemOutcome(item, fallbackOutcome) !== "accepted") {
        return item;
      }

      const aliases = buildListCaptureItemAliases(item, {
        includeTraceIdentity: false,
      });
      if (
        !hasStrongListCaptureIdentity(item) ||
        hasConflictingListCaptureAliases(aliases)
      ) {
        return item;
      }

      const matchedTraces = new Map();
      aliases.forEach((alias) => {
        const matched = aliasToTrace.get(alias);
        if (matched) matchedTraces.set(matched.sequence, matched);
      });
      // An item that claims aliases already owned by different notes is
      // ambiguous. Failing closed prevents A/B identities from being merged
      // and prevents future items from inheriting the wrong sequence.
      if (matchedTraces.size > 1) return item;
      const existing = matchedTraces.values().next().value || null;
      const trace =
        existing ||
        Object.freeze({
          version: LIST_CAPTURE_TRACE_VERSION,
          runId: normalizedRunId,
          sequence: nextSequence++,
          identityKey: aliases[0],
          state: "accepted",
        });

      if (!existing) traceBySequence.set(trace.sequence, trace);
      aliases.forEach((alias) => aliasToTrace.set(alias, trace));

      return {
        ...item,
        captureTrace: {...trace},
      };
    });

  return Object.freeze({
    runId: normalizedRunId,
    acceptItems,
    getAcceptedCount() {
      return traceBySequence.size;
    },
    getTraceBySequence(sequence) {
      const trace = traceBySequence.get(Number(sequence));
      return trace ? {...trace} : null;
    },
    getSnapshot() {
      return Array.from(traceBySequence.values(), (trace) => ({...trace}));
    },
  });
}

export function decorateListCheckpointProgress(progress, ledger) {
  const checkpoint =
    progress?.listCheckpoint && typeof progress.listCheckpoint === "object"
      ? progress.listCheckpoint
      : null;
  if (String(progress?.phase || "").toLowerCase() !== "list_checkpoint" || !checkpoint) {
    return progress && typeof progress === "object" ? {...progress} : {};
  }

  const tracedItems = ledger.acceptItems(checkpoint.items, {
    fallbackOutcome: "accepted",
  });
  const payload =
    checkpoint.payload && typeof checkpoint.payload === "object"
      ? {...checkpoint.payload, items: tracedItems}
      : checkpoint.payload;
  return {
    ...progress,
    listCheckpoint: {
      ...checkpoint,
      items: tracedItems,
      ...(payload ? {payload} : {}),
    },
  };
}
