import {
  buildListCaptureItemAliases as buildListHarvestItemAliases,
  hasConflictingListCaptureAliases,
  hasStrongListCaptureIdentity,
  normalizeListCaptureTrace,
} from "./list-capture-trace.js";

export {
  buildListCaptureItemAliases as buildListHarvestItemAliases,
} from "./list-capture-trace.js";

const HOST_ATTRIBUTE = "data-osv-list-harvest-host";
const CAPTURE_SEQUENCE_ATTRIBUTE = "data-osv-capture-sequence";
const CAPTURE_RUN_ATTRIBUTE = "data-osv-capture-run";
const CAPTURE_STATE_ATTRIBUTE = "data-osv-capture-state";
const CAPTURE_IDENTITY_ATTRIBUTE = "data-osv-capture-identity";
const CAPTURE_ATTRIBUTES = Object.freeze([
  CAPTURE_SEQUENCE_ATTRIBUTE,
  CAPTURE_RUN_ATTRIBUTE,
  CAPTURE_STATE_ATTRIBUTE,
  CAPTURE_IDENTITY_ATTRIBUTE,
]);

export const LIST_HARVEST_STATES = Object.freeze([
  "idle",
  "running",
  "backoff",
  "completed",
  "failed",
  "cancelled",
]);

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const NON_NUMBERED_OUTCOMES = new Set([
  "ai_skipped",
  "cancelled",
  "error",
  "failed",
  "filtered",
  "ignored",
  "rejected",
  "skipped",
]);
const ACCEPTED_OUTCOMES = new Set([
  "accepted",
  "captured",
  "collected",
  "qualified",
  "success",
]);
const IDENTITY_QUERY_ATTRIBUTES = Object.freeze([
  "data-note-id",
  "data-aweme-id",
  "data-e2e-aweme-id",
  "data-awemeid",
  "data-item-id",
  "data-modal-id",
  "data-id",
]);
const URL_QUERY_ATTRIBUTES = Object.freeze(["href", "data-href", "data-url"]);
const CARD_CONTAINER_SELECTOR = [
  "[data-osv-harvest-card]",
  "[data-osv-capture-key]",
  ".note-card",
  ".note-item",
  ".feed-item",
  "[data-e2e='search-result-card']",
  "[data-e2e='user-post-item']",
  "[id^='waterfall_item_']",
  "[data-aweme-id]",
  "[data-e2e-aweme-id]",
  "[data-item-id]",
  "article",
].join(",");
const FALLBACK_CARD_SELECTOR = [
  CARD_CONTAINER_SELECTOR,
  "a[href*='/explore/']",
  "a[href*='/discovery/item/']",
  "a[href*='/video/']",
  "a[href*='/note/']",
  "a[data-href*='/video/']",
  "a[data-href*='/note/']",
].join(",");

const OVERLAY_STYLES = `
  :host {
    all: initial;
    pointer-events: none !important;
  }
  *, *::before, *::after {
    box-sizing: border-box;
    pointer-events: none !important;
  }
  .root {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    overflow: hidden;
    pointer-events: none;
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  }
  .marker-layer {
    position: fixed;
    inset: 0;
    z-index: 1;
    pointer-events: none;
  }
  .marker {
    --trace-color: #007aff;
    --trace-fill: rgba(0, 122, 255, 0.1);
    position: fixed;
    border: 2px solid var(--trace-color);
    border-radius: 0;
    background: var(--trace-fill);
    box-shadow: none;
    pointer-events: none;
    animation: none !important;
    transition: none !important;
    will-change: left, top, width, height;
  }
  .marker[hidden] {
    display: none !important;
  }
  .marker-index {
    position: absolute;
    top: -2px;
    left: -2px;
    right: auto;
    bottom: auto;
    display: inline-block;
    min-width: 20px;
    height: 18px;
    padding: 1px 4px;
    border: 0;
    border-radius: 4px;
    background: var(--trace-color);
    color: #fff;
    box-shadow: none;
    font: 700 12px/16px ui-monospace, "SFMono-Regular", Menlo, Monaco, "Courier New", monospace;
    text-align: center;
    white-space: nowrap;
    animation: none !important;
    transition: none !important;
  }
  .takeover {
    position: fixed;
    left: 50%;
    bottom: 24px;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 5px 18px 5px 5px;
    border: 2px solid #4b4b55;
    border-right-color: #b547d9;
    border-radius: 999px;
    background: rgba(35, 35, 41, 0.96);
    color: #fff;
    box-shadow: 0 12px 32px rgba(22, 16, 32, 0.24);
    transform: translateX(-50%);
    font: 700 16px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: 0.01em;
    pointer-events: none;
    animation: none !important;
    transition: none !important;
  }
  .takeover[hidden] {
    display: none !important;
  }
  .takeover-icon {
    display: grid;
    width: 38px;
    height: 38px;
    place-items: center;
    border-radius: 50%;
    background: #17171d;
    color: #c957ff;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
    font: 700 20px/1 sans-serif;
  }
`;

// Matches StarVoice2.0's readable per-index overlay palette. Sequence colors
// carry identity; terminal states no longer turn the whole page into green boxes.
const TRACE_COLORS = Object.freeze([
  "#ff3b30",
  "#007aff",
  "#ff9500",
  "#af52de",
  "#ff2d55",
  "#5ac8fa",
  "#ffcc00",
  "#30b0c7",
  "#8e8e93",
  "#ff6482",
  "#bf5af2",
  "#ffd60a",
  "#64d2ff",
  "#ff453a",
]);

const TRACE_ERROR_STATES = new Set([
  "failed",
  "detail_failed",
  "error",
]);
const TRACE_MUTED_STATES = new Set([
  "filtered",
  "detail_filtered",
  "skipped",
  "detail_skipped",
  "cancelled",
]);

function traceColorFor(sequence, state) {
  if (TRACE_ERROR_STATES.has(state)) return "#ff3b30";
  if (TRACE_MUTED_STATES.has(state)) return "#8e8e93";
  const index = Math.abs(Number(sequence) || 0) % TRACE_COLORS.length;
  return TRACE_COLORS[index];
}

function traceFillFor(color) {
  const normalized = String(color || "").trim();
  return /^#[\da-f]{6}$/iu.test(normalized)
    ? `${normalized}1a`
    : "rgba(0, 122, 255, 0.1)";
}

function rectanglesOverlap(first, second) {
  return !(
    first.right <= second.left ||
    first.left >= second.right ||
    first.bottom <= second.top ||
    first.top >= second.bottom
  );
}

function cleanText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function normalizeStateName(value, fallback = "running") {
  const normalized = cleanText(value).toLowerCase();
  return LIST_HARVEST_STATES.includes(normalized) ? normalized : fallback;
}

export function normalizeListHarvestItemOutcome(value, fallback = "accepted") {
  const normalized = cleanText(value).toLowerCase().replace(/[\s-]+/gu, "_");
  if (!normalized) {
    const normalizedFallback = cleanText(fallback)
      .toLowerCase()
      .replace(/[\s-]+/gu, "_");
    if (NON_NUMBERED_OUTCOMES.has(normalizedFallback)) {
      return normalizedFallback;
    }
    return ACCEPTED_OUTCOMES.has(normalizedFallback)
      ? "accepted"
      : "ignored";
  }
  if (NON_NUMBERED_OUTCOMES.has(normalized)) return normalized;
  if (ACCEPTED_OUTCOMES.has(normalized)) return "accepted";
  return "ignored";
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

function buildEmptyOutcomeCounts() {
  return {
    aiSkipped: 0,
    failed: 0,
    skipped: 0,
  };
}

export function createListHarvestState({
  sessionId = "",
  status = "idle",
  platform = "",
  label = "",
  message = "",
  now = 0,
} = {}) {
  return {
    sessionId: cleanText(sessionId),
    status: normalizeStateName(status, "idle"),
    platform: cleanText(platform),
    label: cleanText(label),
    message: cleanText(message),
    detectedCount: 0,
    acceptedCount: 0,
    entries: [],
    identityToSequence: new Map(),
    outcomeCounts: buildEmptyOutcomeCounts(),
    startedAt: Number(now) || 0,
    updatedAt: Number(now) || 0,
  };
}

function resolveEventOutcome(item, fallback) {
  const explicit =
    item?.harvestOutcome ??
    item?.listOutcome ??
    item?.outcome ??
    item?.status ??
    "";
  return normalizeListHarvestItemOutcome(explicit, fallback);
}

function mergeDefinedItemFields(previous = {}, incoming = {}) {
  const merged = {...previous};
  Object.entries(incoming || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      merged[key] = value;
    }
  });
  return merged;
}

function recordIgnoredOutcome(counts, outcome) {
  const next = {...counts};
  if (outcome === "ai_skipped") next.aiSkipped += 1;
  else if (outcome === "failed" || outcome === "error") next.failed += 1;
  else next.skipped += 1;
  return next;
}

function applyAcceptedItems(state, items, fallbackOutcome = "accepted") {
  let entries = state.entries.slice();
  let identityToSequence = new Map(state.identityToSequence);
  let outcomeCounts = {...state.outcomeCounts};

  for (const item of Array.isArray(items) ? items : []) {
    const outcome = resolveEventOutcome(item, fallbackOutcome);
    if (NON_NUMBERED_OUTCOMES.has(outcome)) {
      outcomeCounts = recordIgnoredOutcome(outcomeCounts, outcome);
      continue;
    }

    const captureTrace = normalizeListCaptureTrace(item?.captureTrace, {
      runId: state.sessionId,
    });
    if (!captureTrace || captureTrace.state === "ignored") {
      outcomeCounts = recordIgnoredOutcome(outcomeCounts, "skipped");
      continue;
    }

    const aliases = buildListHarvestItemAliases({...item, captureTrace});
    if (
      aliases.length === 0 ||
      !hasStrongListCaptureIdentity({...item, captureTrace}) ||
      hasConflictingListCaptureAliases(aliases)
    ) {
      outcomeCounts = recordIgnoredOutcome(outcomeCounts, "skipped");
      continue;
    }

    const aliasedSequences = new Set(
      aliases
        .map((alias) => identityToSequence.get(alias))
        .filter(Number.isInteger),
    );
    if (aliasedSequences.size > 1) {
      outcomeCounts = recordIgnoredOutcome(outcomeCounts, "skipped");
      continue;
    }
    const aliasedSequence = aliasedSequences.values().next().value;
    const sequenceEntry = entries.find(
      (entry) => entry.sequence === captureTrace.sequence,
    );
    const existingSequence = aliasedSequence || sequenceEntry?.sequence;

    if (existingSequence) {
      if (
        existingSequence !== captureTrace.sequence ||
        (sequenceEntry && !aliasedSequence)
      ) {
        outcomeCounts = recordIgnoredOutcome(outcomeCounts, "skipped");
        continue;
      }
      const index = entries.findIndex(
        (entry) => entry.sequence === existingSequence,
      );
      const existingEntry = entries[index];
      if (!existingEntry) {
        outcomeCounts = recordIgnoredOutcome(outcomeCounts, "skipped");
        continue;
      }
      const mergedAliases = Array.from(
        new Set([...(existingEntry?.aliases || []), ...aliases]),
      );
      entries[index] = {
        ...existingEntry,
        item: mergeDefinedItemFields(existingEntry?.item, {
          ...item,
          captureTrace,
        }),
        aliases: mergedAliases,
      };
      mergedAliases.forEach((alias) => {
        if (!identityToSequence.has(alias)) {
          identityToSequence.set(alias, existingSequence);
        }
      });
      continue;
    }

    entries.push({
      sequence: captureTrace.sequence,
      aliases,
      item: {...item, captureTrace},
    });
    aliases.forEach((alias) =>
      identityToSequence.set(alias, captureTrace.sequence),
    );
  }

  return {
    ...state,
    entries,
    identityToSequence,
    outcomeCounts,
    acceptedCount: entries.length,
  };
}

function normalizeBindingIdentity(value) {
  return cleanText(value).toLowerCase();
}

function applyTraceBindingsToState(state, bindings) {
  let entries = state.entries.slice();
  let updatedCount = 0;
  let ignoredCount = 0;

  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const bindingRunId = cleanText(
      binding?.runId || binding?.captureTrace?.runId,
    );
    const bindingSequence = Number(
      binding?.sequence ?? binding?.captureTrace?.sequence,
    );
    const bindingIdentity = normalizeBindingIdentity(
      binding?.identityKey || binding?.identity || binding?.captureTrace?.identityKey,
    );

    if (
      !bindingRunId ||
      bindingRunId !== state.sessionId ||
      (!Number.isSafeInteger(bindingSequence) && !bindingIdentity)
    ) {
      ignoredCount += 1;
      continue;
    }

    const index = entries.findIndex((entry) => {
      const trace = entry.item?.captureTrace || {};
      const sequenceMatches =
        Number.isSafeInteger(bindingSequence) &&
        bindingSequence > 0 &&
        entry.sequence === bindingSequence;
      const identityMatches =
        Boolean(bindingIdentity) &&
        (normalizeBindingIdentity(trace.identityKey) === bindingIdentity ||
          entry.aliases?.some(
            (alias) => normalizeBindingIdentity(alias) === bindingIdentity,
          ));
      if (Number.isSafeInteger(bindingSequence) && bindingIdentity) {
        return sequenceMatches && identityMatches;
      }
      return sequenceMatches || identityMatches;
    });

    if (index < 0) {
      ignoredCount += 1;
      continue;
    }

    const entry = entries[index];
    const previousTrace = entry.item?.captureTrace || {};
    const nextTrace = normalizeListCaptureTrace(
      {
        ...previousTrace,
        version: 1,
        runId: state.sessionId,
        sequence: entry.sequence,
        identityKey: previousTrace.identityKey,
        state:
          binding?.state ||
          binding?.captureTrace?.state ||
          previousTrace.state,
        recordId:
          binding?.recordId ??
          binding?.captureTrace?.recordId ??
          previousTrace.recordId,
      },
      {runId: state.sessionId},
    );
    if (!nextTrace) {
      ignoredCount += 1;
      continue;
    }

    entries[index] = {
      ...entry,
      item: {
        ...entry.item,
        captureTrace: nextTrace,
      },
    };
    updatedCount += 1;
  }

  return {
    state: updatedCount > 0 ? {...state, entries, updatedAt: Date.now()} : state,
    updatedCount,
    ignoredCount,
  };
}

export function reduceListHarvestState(state, event = {}) {
  const current = state || createListHarvestState();
  const type = cleanText(event.type).toLowerCase();
  const now = Number(event.now) || current.updatedAt || 0;

  if (type === "start") {
    const requestedSessionId = cleanText(event.sessionId);
    const isNewSession =
      !current.sessionId ||
      !requestedSessionId ||
      requestedSessionId !== current.sessionId;
    if (isNewSession) {
      return createListHarvestState({
        sessionId: requestedSessionId,
        status: "running",
        platform: event.platform,
        label: event.label,
        message: event.message,
        now,
      });
    }
    return {
      ...current,
      status: "running",
      platform: cleanText(event.platform) || current.platform,
      label: cleanText(event.label) || current.label,
      message: cleanText(event.message) || current.message,
      updatedAt: now,
    };
  }

  if (TERMINAL_STATES.has(current.status)) {
    return current;
  }

  if (type === "checkpoint" || type === "items") {
    const withItems = applyAcceptedItems(
      current,
      event.items,
      event.outcome || "accepted",
    );
    const detectedCount = Math.max(
      Number(current.detectedCount) || 0,
      Number(event.detectedCount) || 0,
      Number(event.rawDetectedCount) || 0,
    );
    return {
      ...withItems,
      status: "running",
      detectedCount,
      message: cleanText(event.message) || current.message,
      updatedAt: now,
    };
  }

  if (["running", "backoff", "completed", "failed", "cancelled"].includes(type)) {
    return {
      ...current,
      status: type,
      detectedCount: Math.max(
        Number(current.detectedCount) || 0,
        Number(event.detectedCount) || 0,
      ),
      message: cleanText(event.message) || current.message,
      updatedAt: now,
    };
  }

  return current;
}

export function buildListHarvestEventFromProgress(progress = {}) {
  const phase = cleanText(progress.phase).toLowerCase();
  const common = {
    message: progress.message,
    detectedCount:
      progress.detectedCount ??
      progress.currentContentCount ??
      progress.rawTotalCount ??
      0,
    now: progress.now,
  };

  if (phase === "list_checkpoint") {
    return {
      type: "checkpoint",
      items: progress.listCheckpoint?.items || [],
      ...common,
    };
  }
  if (phase === "waiting" || phase.includes("backoff")) {
    return {type: "backoff", ...common};
  }
  if (phase === "canceled" || phase === "cancelled") {
    return {type: "cancelled", ...common};
  }
  if (phase === "failed" || phase === "error") {
    return {type: "failed", ...common};
  }
  return {type: "running", ...common};
}

export function describeListHarvestState(state = {}) {
  const status = normalizeStateName(state.status, "idle");
  const count = Number(state.acceptedCount) || 0;
  const message = cleanText(state.message);
  const copies = {
    idle: {
      eyebrow: "LIST TRACE",
      title: "等待列表采集",
      detail: "开始后会按实际采集顺序标记卡片",
    },
    running: {
      eyebrow: "LIST TRACE · RUNNING",
      title: "正在采集并核对列表",
      detail: message || `已确认 ${count} 条；页面编号会持续同步`,
    },
    backoff: {
      eyebrow: "LIST TRACE · SAFE WAIT",
      title: "正在安全等待",
      detail: message || `已保留 ${count} 个编号；降低频率后继续`,
    },
    completed: {
      eyebrow: "LIST TRACE · COMPLETE",
      title: "列表采集完成",
      detail: `已采集并标记 ${count} 条；编号保留到下一次采集`,
    },
    failed: {
      eyebrow: "LIST TRACE · INTERRUPTED",
      title: "列表采集中断",
      detail: message
        ? `已保留 ${count} 个编号 · ${message}`
        : `已保留 ${count} 个编号；可处理问题后重新开始`,
    },
    cancelled: {
      eyebrow: "LIST TRACE · STOPPED",
      title: "列表采集已停止",
      detail: message
        ? `已保留 ${count} 个编号 · ${message}`
        : `已保留 ${count} 个编号；不会继续滚动页面`,
    },
  };
  return copies[status];
}

function escapeCssString(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\n\r\f]/gu, " ");
}

function safeQueryAll(documentRef, selector) {
  try {
    return Array.from(documentRef.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function collectRawItemIds(item = {}) {
  const locator = item.domLocator || {};
  const urls = [
    item.url,
    item.noteUrl,
    item.detailPageUrl,
    locator.href,
    item.domMatchHints?.noteUrl,
  ];
  return Array.from(
    new Set(
      [
        item.noteId,
        item.note_id,
        item.awemeId,
        item.aweme_id,
        item.itemId,
        item.item_id,
        locator.dataAwemeId,
        locator.dataE2eAwemeId,
        ...urls.map(extractRouteId),
      ]
        .map(normalizeIdentityId)
        .filter(Boolean),
    ),
  );
}

function collectRawItemUrls(item = {}) {
  return Array.from(
    new Set(
      [
        item.url,
        item.noteUrl,
        item.detailPageUrl,
        item.domLocator?.href,
        item.domMatchHints?.noteUrl,
      ]
        .map(cleanText)
        .filter(Boolean),
    ),
  );
}

function resolveCardContainer(node, windowRef) {
  const ElementCtor = windowRef?.Element;
  if (!ElementCtor || !(node instanceof ElementCtor)) return null;
  const structural = node.closest?.(CARD_CONTAINER_SELECTOR);
  if (structural) return structural;
  const link = node.closest?.(
    "a[href*='/explore/'],a[href*='/discovery/item/'],a[href*='/video/'],a[href*='/note/'],a[data-href*='/video/'],a[data-href*='/note/']",
  );
  return link || node;
}

function collectElementIdentityValues(element) {
  const values = [];
  const nodes = [
    element,
    ...Array.from(
      element.querySelectorAll?.(
        "a,[data-osv-capture-key],[data-note-id],[data-aweme-id],[data-e2e-aweme-id],[data-awemeid],[data-item-id],[data-modal-id],[data-id]",
      ) || [],
    ).slice(0, 80),
  ];
  nodes.forEach((node) => {
    const domCaptureKey = cleanText(node.getAttribute?.("data-osv-capture-key"));
    if (domCaptureKey) {
      values.push({type: "dom", value: domCaptureKey.toLowerCase()});
    }
    IDENTITY_QUERY_ATTRIBUTES.forEach((attribute) => {
      const value = cleanText(node.getAttribute?.(attribute));
      if (value) values.push({type: "id", value: normalizeIdentityId(value)});
    });
    URL_QUERY_ATTRIBUTES.forEach((attribute) => {
      const value = cleanText(node.getAttribute?.(attribute));
      if (!value) return;
      const identity = extractUrlIdentity(value);
      if (identity) values.push({type: "url", value: identity.canonical.toLowerCase()});
      const routeId = extractRouteId(value);
      if (routeId) values.push({type: "id", value: routeId});
    });
  });
  return values;
}

export function evaluateListCaptureElementIdentity(element, item = {}) {
  const expectedDomCaptureKey = cleanText(item.domCaptureKey).toLowerCase();
  const expectedIds = new Set(collectRawItemIds(item));
  const expectedUrls = new Set(
    collectRawItemUrls(item)
      .map(extractUrlIdentity)
      .filter(Boolean)
      .map((identity) => identity.canonical.toLowerCase()),
  );
  const traceIdentity = cleanText(item.captureTrace?.identityKey).toLowerCase();
  if (traceIdentity.startsWith("id:")) {
    expectedIds.add(normalizeIdentityId(traceIdentity.slice(3)));
  } else if (traceIdentity.startsWith("url:")) {
    expectedUrls.add(traceIdentity.slice(4));
  }
  const actual = collectElementIdentityValues(element);
  const domCaptureKeyMatched = actual.some(
    ({type, value}) =>
      type === "dom" &&
      Boolean(expectedDomCaptureKey) &&
      expectedDomCaptureKey === value,
  );
  const stableIdMatched = actual.some(
    ({type, value}) => type === "id" && expectedIds.has(value),
  );
  const stableUrlMatched = actual.some(
    ({type, value}) => type === "url" && expectedUrls.has(value),
  );
  const stableIdentityRequired = expectedIds.size > 0 || expectedUrls.size > 0;
  const stableIdentityMatched = stableIdMatched || stableUrlMatched;
  let score = 0;
  if (domCaptureKeyMatched) score = Math.max(score, 160);
  if (stableIdMatched) score = Math.max(score, 120);
  if (stableUrlMatched) score = Math.max(score, 110);

  const locator = item.domLocator || {};
  if (locator.id && element.id === locator.id) score = Math.max(score, 90);
  const locatorAwemeId = normalizeIdentityId(locator.dataAwemeId);
  if (
    locatorAwemeId &&
    actual.some(({type, value}) => type === "id" && value === locatorAwemeId)
  ) {
    score = Math.max(score, 100);
  }

  const text = cleanText(element.innerText || element.textContent).toLowerCase();
  const title = cleanText(item.title || item.domMatchHints?.titleSnippet).toLowerCase();
  const author = cleanText(item.author || item.domMatchHints?.authorSnippet).toLowerCase();
  if (title && text.includes(title.slice(0, 60))) score += 8;
  if (author && text.includes(author.slice(0, 40))) score += 3;
  return {
    score,
    stableIdentityRequired,
    stableIdentityMatched,
    stableIdMatched,
    stableUrlMatched,
    domCaptureKeyMatched,
  };
}

function satisfiesListCaptureIdentityGate(item, evidence) {
  if (evidence.stableIdentityRequired) {
    return evidence.stableIdentityMatched;
  }
  if (hasStrongListCaptureIdentity(item)) {
    return evidence.domCaptureKeyMatched;
  }
  return false;
}

function addCandidate(candidateMap, node, trust, windowRef) {
  const card = resolveCardContainer(node, windowRef);
  if (!card) return;
  candidateMap.set(card, Math.max(candidateMap.get(card) || 0, trust));
}

function findElementCandidates(documentRef, windowRef, item) {
  const candidates = new Map();
  const domCaptureKey = cleanText(item.domCaptureKey);
  if (domCaptureKey) {
    const escaped = escapeCssString(domCaptureKey);
    safeQueryAll(
      documentRef,
      `[data-osv-capture-key="${escaped}"]`,
    ).forEach((node) => addCandidate(candidates, node, 200, windowRef));
  }
  const ids = collectRawItemIds(item);
  ids.forEach((id) => {
    const escaped = escapeCssString(id);
    IDENTITY_QUERY_ATTRIBUTES.forEach((attribute) => {
      safeQueryAll(documentRef, `[${attribute}="${escaped}"]`).forEach((node) =>
        addCandidate(candidates, node, 120, windowRef),
      );
    });
    URL_QUERY_ATTRIBUTES.forEach((attribute) => {
      safeQueryAll(documentRef, `[${attribute}*="${escaped}"]`).forEach((node) =>
        addCandidate(candidates, node, 105, windowRef),
      );
    });
  });

  collectRawItemUrls(item).forEach((rawUrl) => {
    const identity = extractUrlIdentity(rawUrl);
    const matchToken = identity?.path || "";
    if (!matchToken || matchToken === "/") return;
    const escaped = escapeCssString(matchToken);
    URL_QUERY_ATTRIBUTES.forEach((attribute) => {
      safeQueryAll(documentRef, `[${attribute}*="${escaped}"]`).forEach((node) =>
        addCandidate(candidates, node, 108, windowRef),
      );
    });
  });

  const locator = item.domLocator || {};
  if (locator.id) {
    addCandidate(candidates, documentRef.getElementById(locator.id), 85, windowRef);
  }
  if (locator.cssPath) {
    safeQueryAll(documentRef, locator.cssPath).forEach((node) =>
      addCandidate(candidates, node, 65, windowRef),
    );
  }
  if (locator.parentCssPath && Number.isInteger(locator.childIndex)) {
    safeQueryAll(documentRef, locator.parentCssPath).forEach((parent) =>
      addCandidate(candidates, parent.children?.[locator.childIndex], 55, windowRef),
    );
  }

  if (candidates.size === 0) {
    safeQueryAll(documentRef, FALLBACK_CARD_SELECTOR)
      .slice(0, 360)
      .forEach((node) => addCandidate(candidates, node, 0, windowRef));
  }
  return candidates;
}

function isElementVisible(element, windowRef) {
  if (!element?.isConnected) return false;
  const rect = element.getBoundingClientRect?.();
  if (!rect || rect.width < 4 || rect.height < 4) return false;
  const viewportWidth = Number(windowRef.innerWidth) || 0;
  const viewportHeight = Number(windowRef.innerHeight) || 0;
  if (
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= viewportHeight ||
    rect.left >= viewportWidth
  ) {
    return false;
  }
  const style = windowRef.getComputedStyle?.(element);
  return style?.display !== "none" && style?.visibility !== "hidden";
}

function buildCardIndex(documentRef, windowRef) {
  const aliasToElements = new Map();
  const seen = new Set();
  safeQueryAll(documentRef, FALLBACK_CARD_SELECTOR)
    .slice(0, 500)
    .forEach((node) => {
      const card = resolveCardContainer(node, windowRef);
      if (!card || seen.has(card)) return;
      seen.add(card);
      collectElementIdentityValues(card).forEach(({type, value}) => {
        const alias = `${type}:${value}`;
        const elements = aliasToElements.get(alias) || [];
        elements.push(card);
        aliasToElements.set(alias, elements);
      });
    });
  return aliasToElements;
}

function resolveElementForEntry(documentRef, windowRef, entry, cardIndex) {
  const hasStrongItemIdentity = hasStrongListCaptureIdentity(entry.item);
  const indexedMatches = new Set();
  (entry.aliases || []).forEach((alias) => {
    (cardIndex.get(alias) || []).forEach((element) =>
      indexedMatches.add(element),
    );
  });
  if (indexedMatches.size > 0) {
    let bestIndexed = null;
    let bestIndexedScore = -1;
    indexedMatches.forEach((element) => {
      const evidence = evaluateListCaptureElementIdentity(element, entry.item);
      if (!satisfiesListCaptureIdentityGate(entry.item, evidence)) return;
      const score = evidence.score + (isElementVisible(element, windowRef) ? 1 : 0);
      if (hasStrongItemIdentity && score < 100) return;
      if (score > bestIndexedScore) {
        bestIndexed = element;
        bestIndexedScore = score;
      }
    });
    if (bestIndexed) return bestIndexed;
  }

  const candidates = findElementCandidates(documentRef, windowRef, entry.item);
  let best = null;
  let bestScore = -1;
  candidates.forEach((trust, element) => {
    const evidence = evaluateListCaptureElementIdentity(element, entry.item);
    if (!satisfiesListCaptureIdentityGate(entry.item, evidence)) return;
    const identityScore = evidence.score;
    if (hasStrongItemIdentity && identityScore < 100) return;
    const score =
      trust +
      identityScore +
      (isElementVisible(element, windowRef) ? 1 : 0);
    if (score > bestScore) {
      best = element;
      bestScore = score;
    }
  });
  return best;
}

let generatedSessionCounter = 0;

function createSessionId() {
  generatedSessionCounter += 1;
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId || `list-harvest-${Date.now()}-${generatedSessionCounter}`;
}

export function createListCaptureOverlayRunScope(overlay, runId) {
  const sessionId = cleanText(runId);
  if (!overlay || !sessionId) {
    throw new Error("list capture overlay run scope requires overlay and runId");
  }

  const readCurrentState = () => {
    try {
      return overlay.getState?.() || null;
    } catch {
      return null;
    }
  };
  const isCurrent = () =>
    cleanText(readCurrentState()?.sessionId) === sessionId;
  const invoke = (method, args) => {
    if (!isCurrent()) return {applied: false, value: null};
    const operation = overlay?.[method];
    if (typeof operation !== "function") {
      return {applied: false, value: null};
    }
    return {
      applied: true,
      value: operation.apply(overlay, args),
    };
  };

  return Object.freeze({
    runId: sessionId,
    isCurrent,
    getState() {
      const state = readCurrentState();
      return cleanText(state?.sessionId) === sessionId ? state : null;
    },
    handleProgress(...args) {
      return invoke("handleProgress", args);
    },
    recordItems(...args) {
      return invoke("recordItems", args);
    },
    setRunning(...args) {
      return invoke("setRunning", args);
    },
    setBackoff(...args) {
      return invoke("setBackoff", args);
    },
    complete(...args) {
      return invoke("complete", args);
    },
    fail(...args) {
      return invoke("fail", args);
    },
    cancel(...args) {
      return invoke("cancel", args);
    },
  });
}

export function createListCaptureDebugOverlay({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  let state = createListHarvestState();
  let host = null;
  let shadowRoot = null;
  let root = null;
  let markerLayer = null;
  let takeover = null;
  let takeoverLabel = null;
  let mutationObserver = null;
  let resizeObserver = null;
  let resizeObservedElements = new Set();
  let rafId = 0;
  let mounted = false;
  let stampedElements = new Set();
  let markerElements = new Map();
  let markerInstanceCounter = 0;
  let lastRenderSnapshot = {
    markers: [],
    visibleMarkerCount: 0,
    unresolvedCount: 0,
  };

  const rectSnapshot = (rect) => ({
    x: Number(rect?.x ?? rect?.left) || 0,
    y: Number(rect?.y ?? rect?.top) || 0,
    top: Number(rect?.top) || 0,
    right: Number(rect?.right) || 0,
    bottom: Number(rect?.bottom) || 0,
    left: Number(rect?.left) || 0,
    width: Number(rect?.width) || 0,
    height: Number(rect?.height) || 0,
  });

  const clearElementCaptureAttributes = (element, runId) => {
    if (!element?.getAttribute || element.getAttribute(CAPTURE_RUN_ATTRIBUTE) !== runId) {
      return false;
    }
    CAPTURE_ATTRIBUTES.forEach((attribute) => element.removeAttribute(attribute));
    return true;
  };

  const cleanupRunAttributes = (runId) => {
    const normalizedRunId = cleanText(runId);
    if (!normalizedRunId) return 0;
    let cleared = 0;
    stampedElements.forEach((element) => {
      if (clearElementCaptureAttributes(element, normalizedRunId)) cleared += 1;
    });
    const escapedRunId = escapeCssString(normalizedRunId);
    safeQueryAll(
      documentRef,
      `[${CAPTURE_RUN_ATTRIBUTE}="${escapedRunId}"]`,
    ).forEach((element) => {
      if (clearElementCaptureAttributes(element, normalizedRunId)) cleared += 1;
    });
    stampedElements = new Set();
    return cleared;
  };

  const clearMarkerElements = () => {
    markerElements.forEach(({marker}) => marker.remove());
    markerElements = new Map();
  };

  const syncResizeObservation = (elements) => {
    if (!resizeObserver) return;
    resizeObservedElements.forEach((element) => {
      if (!elements.has(element)) resizeObserver.unobserve(element);
    });
    elements.forEach((element) => {
      if (!resizeObservedElements.has(element)) resizeObserver.observe(element);
    });
    resizeObservedElements = elements;
  };

  const placeMarkerBadge = (record, boxRect, occupiedBadgeRects) => {
    const badgeRect = record.index.getBoundingClientRect();
    const width = Math.max(20, badgeRect.width || 20);
    const height = Math.max(18, badgeRect.height || 18);
    const candidates = [
      {
        top: "-2px",
        left: "-2px",
        right: "auto",
        bottom: "auto",
        rect: {
          left: boxRect.left,
          top: boxRect.top,
          right: boxRect.left + width,
          bottom: boxRect.top + height,
        },
      },
      {
        top: "-2px",
        left: "auto",
        right: "-2px",
        bottom: "auto",
        rect: {
          left: boxRect.right - width,
          top: boxRect.top,
          right: boxRect.right,
          bottom: boxRect.top + height,
        },
      },
      {
        top: "auto",
        left: "-2px",
        right: "auto",
        bottom: "-2px",
        rect: {
          left: boxRect.left,
          top: boxRect.bottom - height,
          right: boxRect.left + width,
          bottom: boxRect.bottom,
        },
      },
      {
        top: "auto",
        left: "auto",
        right: "-2px",
        bottom: "-2px",
        rect: {
          left: boxRect.right - width,
          top: boxRect.bottom - height,
          right: boxRect.right,
          bottom: boxRect.bottom,
        },
      },
    ];
    const placement =
      candidates.find(({rect}) =>
        occupiedBadgeRects.every((occupied) => !rectanglesOverlap(rect, occupied)),
      ) || candidates[0];
    record.index.style.top = placement.top;
    record.index.style.left = placement.left;
    record.index.style.right = placement.right;
    record.index.style.bottom = placement.bottom;
    occupiedBadgeRects.push(placement.rect);
  };

  const updateHostContract = () => {
    if (!host) return;
    const copy = describeListHarvestState(state);
    host.setAttribute("data-state", state.status);
    host.setAttribute("data-marked-count", String(state.acceptedCount));
    host.setAttribute("data-list-capture-run", state.sessionId || "");
    host.setAttribute(
      "data-visible-marker-count",
      String(lastRenderSnapshot.visibleMarkerCount),
    );
    host.setAttribute(
      "data-unresolved-count",
      String(lastRenderSnapshot.unresolvedCount),
    );
    host.setAttribute(
      "aria-label",
      `StarVoice 列表采集：${copy.title}，已标记 ${state.acceptedCount} 条`,
    );
    const takeoverVisible = state.status === "running" || state.status === "backoff";
    const nextTakeoverLabel = "AI 正在接管";
    host.setAttribute("data-takeover-visible", String(takeoverVisible));
    host.setAttribute("data-takeover-label", nextTakeoverLabel);
    if (takeover) takeover.hidden = !takeoverVisible;
    if (takeoverLabel) takeoverLabel.textContent = nextTakeoverLabel;
  };

  const ensureMounted = () => {
    if (!documentRef?.documentElement || !windowRef) return false;
    if (host?.isConnected) return true;

    if (mounted) {
      mutationObserver?.disconnect();
      mutationObserver = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      resizeObservedElements = new Set();
      windowRef.removeEventListener("scroll", scheduleRender, {capture: true});
      windowRef.removeEventListener("resize", scheduleRender);
      mounted = false;
    }

    clearMarkerElements();

    safeQueryAll(documentRef, `[${HOST_ATTRIBUTE}="true"]`).forEach((node) =>
      node.remove(),
    );
    host = documentRef.createElement("onstarvoice-list-harvest-layer");
    host.setAttribute(HOST_ATTRIBUTE, "true");
    for (const [property, value] of [
      ["all", "initial"],
      ["display", "block"],
      ["visibility", "visible"],
      ["opacity", "1"],
      ["position", "fixed"],
      ["inset", "0"],
      ["width", "auto"],
      ["height", "auto"],
      ["z-index", "2147483647"],
      ["overflow", "visible"],
      ["contain", "none"],
      ["pointer-events", "none"],
    ]) {
      host.style.setProperty(property, value, "important");
    }

    shadowRoot = host.attachShadow({mode: "closed"});
    const style = documentRef.createElement("style");
    style.textContent = OVERLAY_STYLES;
    shadowRoot.appendChild(style);

    root = documentRef.createElement("div");
    root.className = "root";
    shadowRoot.appendChild(root);

    markerLayer = documentRef.createElement("div");
    markerLayer.className = "marker-layer";
    root.appendChild(markerLayer);

    takeover = documentRef.createElement("div");
    takeover.className = "takeover";
    takeover.setAttribute("role", "status");
    const takeoverIcon = documentRef.createElement("span");
    takeoverIcon.className = "takeover-icon";
    takeoverIcon.setAttribute("aria-hidden", "true");
    takeoverIcon.textContent = "ϟ";
    takeoverLabel = documentRef.createElement("span");
    takeover.append(takeoverIcon, takeoverLabel);
    root.appendChild(takeover);

    documentRef.documentElement.appendChild(host);
    updateHostContract();

    mutationObserver = new windowRef.MutationObserver(() => scheduleRender());
    mutationObserver.observe(documentRef.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "href",
        "data-href",
        "data-url",
        "data-osv-capture-key",
        ...IDENTITY_QUERY_ATTRIBUTES,
      ],
    });
    windowRef.addEventListener("scroll", scheduleRender, {
      capture: true,
      passive: true,
    });
    windowRef.addEventListener("resize", scheduleRender, {passive: true});
    if (typeof windowRef.ResizeObserver === "function") {
      resizeObserver = new windowRef.ResizeObserver(() => scheduleRender());
    }
    mounted = true;
    return true;
  };

  const renderNow = () => {
    rafId = 0;
    if (!ensureMounted()) return;
    updateHostContract();

    root.dataset.state = state.status;

    const usedElements = new Set();
    const nextStampedElements = new Set();
    const activeMarkerKeys = new Set();
    const renderedMarkers = [];
    const resolvedMarkers = [];
    let unresolvedCount = 0;
    const cardIndex = buildCardIndex(documentRef, windowRef);
    state.entries.forEach((entry) => {
      const captureTrace = normalizeListCaptureTrace(entry.item?.captureTrace, {
        runId: state.sessionId,
      });
      if (!captureTrace || captureTrace.sequence !== entry.sequence) {
        unresolvedCount += 1;
        return;
      }
      const markerKey = `${captureTrace.runId}:${entry.sequence}`;
      activeMarkerKeys.add(markerKey);
      const element = resolveElementForEntry(
        documentRef,
        windowRef,
        entry,
        cardIndex,
      );
      if (!element || usedElements.has(element)) {
        const retainedRecord = markerElements.get(markerKey);
        if (retainedRecord) retainedRecord.marker.hidden = true;
        unresolvedCount += 1;
        return;
      }
      usedElements.add(element);
      nextStampedElements.add(element);
      element.setAttribute(CAPTURE_SEQUENCE_ATTRIBUTE, String(entry.sequence));
      element.setAttribute(CAPTURE_RUN_ATTRIBUTE, captureTrace.runId);
      element.setAttribute(CAPTURE_STATE_ATTRIBUTE, captureTrace.state);
      element.setAttribute(CAPTURE_IDENTITY_ATTRIBUTE, captureTrace.identityKey);
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      resolvedMarkers.push({entry, captureTrace, element, rect});
    });

    syncResizeObservation(new Set(resolvedMarkers.map(({element}) => element)));
    const occupiedBadgeRects = [];
    resolvedMarkers
      .sort((first, second) =>
        second.rect.width * second.rect.height - first.rect.width * first.rect.height,
      )
      .forEach(({entry, captureTrace, element, rect}) => {
      const key = `${captureTrace.runId}:${entry.sequence}`;
      let record = markerElements.get(key);
      if (!record) {
        const marker = documentRef.createElement("div");
        marker.className = "marker";
        const index = documentRef.createElement("span");
        index.className = "marker-index";
        marker.appendChild(index);
        markerLayer.appendChild(marker);
        markerInstanceCounter += 1;
        record = {
          marker,
          index,
          instanceId: markerInstanceCounter,
        };
        markerElements.set(key, record);
      }

      const depth = resolvedMarkers.reduce(
        (count, candidate) =>
          candidate.element !== element && candidate.element.contains(element)
            ? count + 1
            : count,
        0,
      );
      const inset = depth * 3;
      const boxRect = {
        left: rect.left + inset,
        top: rect.top + inset,
        right: rect.right - inset,
        bottom: rect.bottom - inset,
        width: Math.max(0, rect.width - inset * 2),
        height: Math.max(0, rect.height - inset * 2),
      };
      const color = traceColorFor(entry.sequence, captureTrace.state);
      const visible = isElementVisible(element, windowRef);
      record.marker.hidden = !visible;
      record.marker.setAttribute("data-sequence", String(entry.sequence));
      record.marker.setAttribute("data-trace-state", captureTrace.state);
      record.marker.setAttribute("data-marker-instance", String(record.instanceId));
      record.marker.style.setProperty("--trace-color", color);
      record.marker.style.setProperty("--trace-fill", traceFillFor(color));
      record.marker.style.left = `${boxRect.left}px`;
      record.marker.style.top = `${boxRect.top}px`;
      record.marker.style.width = `${boxRect.width}px`;
      record.marker.style.height = `${boxRect.height}px`;
      record.index.textContent = String(entry.sequence);
      if (!visible) return;

      placeMarkerBadge(record, boxRect, occupiedBadgeRects);
      const markerStyle = windowRef.getComputedStyle?.(record.marker);
      const badgeStyle = windowRef.getComputedStyle?.(record.index);
      renderedMarkers.push({
        sequence: entry.sequence,
        runId: captureTrace.runId,
        state: captureTrace.state,
        identity: captureTrace.identityKey,
        instanceId: record.instanceId,
        targetRect: rectSnapshot(rect),
        markerRect: rectSnapshot(record.marker.getBoundingClientRect()),
        badgeRect: rectSnapshot(record.index.getBoundingClientRect()),
        style: {
          borderTopWidth: markerStyle?.borderTopWidth || "2px",
          borderStyle: markerStyle?.borderTopStyle || "solid",
          borderColor: markerStyle?.borderTopColor || color,
          borderRadius: markerStyle?.borderRadius || "0px",
          backgroundColor: markerStyle?.backgroundColor || traceFillFor(color),
          boxShadow: markerStyle?.boxShadow || "none",
          animationName: markerStyle?.animationName || "none",
          transitionDuration: markerStyle?.transitionDuration || "0s",
          badgeBorderRadius: badgeStyle?.borderRadius || "4px",
          badgeBoxShadow: badgeStyle?.boxShadow || "none",
          badgeText: record.index.textContent,
        },
      });
    });

    markerElements.forEach(({marker}, key) => {
      if (activeMarkerKeys.has(key)) return;
      marker.remove();
      markerElements.delete(key);
    });

    stampedElements.forEach((element) => {
      if (!nextStampedElements.has(element)) {
        clearElementCaptureAttributes(element, state.sessionId);
      }
    });
    stampedElements = nextStampedElements;
    lastRenderSnapshot = {
      markers: renderedMarkers,
      visibleMarkerCount: renderedMarkers.length,
      unresolvedCount,
    };
    updateHostContract();
  };

  function scheduleRender() {
    if (rafId) return;
    const requestFrame = windowRef?.requestAnimationFrame?.bind(windowRef);
    rafId = requestFrame
      ? requestFrame(renderNow)
      : windowRef.setTimeout(renderNow, 16);
  }

  const update = (event) => {
    state = reduceListHarvestState(state, event);
    if (ensureMounted()) {
      updateHostContract();
      scheduleRender();
    }
    return state;
  };

  const startSession = ({
    sessionId = createSessionId(),
    platform = "",
    label = "",
    message = "",
  } = {}) => {
    const previousRunId = state.sessionId;
    if (previousRunId && previousRunId !== cleanText(sessionId)) {
      cleanupRunAttributes(previousRunId);
      clearMarkerElements();
      lastRenderSnapshot = {
        markers: [],
        visibleMarkerCount: 0,
        unresolvedCount: 0,
      };
    }
    return update({
      type: "start",
      sessionId,
      platform,
      label,
      message,
      now: Date.now(),
    });
  };

  const ensureSession = () => {
    if (!state.sessionId) startSession();
  };

  return Object.freeze({
    startSession,
    handleProgress(progress = {}) {
      ensureSession();
      return update({
        ...buildListHarvestEventFromProgress(progress),
        now: Date.now(),
      });
    },
    recordItems(items, {outcome = "accepted", detectedCount = 0, message = ""} = {}) {
      ensureSession();
      return update({
        type: "items",
        items,
        outcome,
        detectedCount,
        message,
        now: Date.now(),
      });
    },
    updateTraceBindings(bindings = []) {
      ensureSession();
      const result = applyTraceBindingsToState(state, bindings);
      state = result.state;
      if (result.updatedCount > 0 && ensureMounted()) {
        updateHostContract();
        scheduleRender();
      }
      return {
        runId: state.sessionId,
        updatedCount: result.updatedCount,
        ignoredCount: result.ignoredCount,
      };
    },
    setRunning(message = "") {
      ensureSession();
      return update({type: "running", message, now: Date.now()});
    },
    setBackoff(message = "") {
      ensureSession();
      return update({type: "backoff", message, now: Date.now()});
    },
    complete(message = "") {
      ensureSession();
      return update({type: "completed", message, now: Date.now()});
    },
    fail(error = "") {
      ensureSession();
      return update({
        type: "failed",
        message: cleanText(error?.message || error),
        now: Date.now(),
      });
    },
    cancel(message = "") {
      ensureSession();
      return update({type: "cancelled", message, now: Date.now()});
    },
    refresh: scheduleRender,
    getHost() {
      return host;
    },
    getState() {
      return {
        ...state,
        entries: state.entries.map((entry) => ({
          ...entry,
          aliases: entry.aliases.slice(),
          item: {
            ...entry.item,
            captureTrace: entry.item?.captureTrace
              ? {...entry.item.captureTrace}
              : entry.item?.captureTrace,
          },
        })),
        identityToSequence: new Map(state.identityToSequence),
        outcomeCounts: {...state.outcomeCounts},
      };
    },
    getRenderSnapshot() {
      return {
        markers: lastRenderSnapshot.markers.map((marker) => ({
          ...marker,
          targetRect: {...marker.targetRect},
          markerRect: {...marker.markerRect},
          badgeRect: {...marker.badgeRect},
          style: {...marker.style},
        })),
        visibleMarkerCount: lastRenderSnapshot.visibleMarkerCount,
        unresolvedCount: lastRenderSnapshot.unresolvedCount,
      };
    },
    destroy() {
      if (rafId) {
        if (windowRef?.cancelAnimationFrame) windowRef.cancelAnimationFrame(rafId);
        else windowRef?.clearTimeout?.(rafId);
      }
      rafId = 0;
      mutationObserver?.disconnect();
      mutationObserver = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      resizeObservedElements = new Set();
      if (mounted) {
        windowRef?.removeEventListener?.("scroll", scheduleRender, {capture: true});
        windowRef?.removeEventListener?.("resize", scheduleRender);
      }
      mounted = false;
      cleanupRunAttributes(state.sessionId);
      clearMarkerElements();
      host?.remove();
      host = null;
      shadowRoot = null;
      root = null;
      markerLayer = null;
      takeover = null;
      takeoverLabel = null;
      lastRenderSnapshot = {
        markers: [],
        visibleMarkerCount: 0,
        unresolvedCount: 0,
      };
      state = createListHarvestState();
    },
  });
}

let sharedListCaptureDebugOverlay = null;

export function getListCaptureDebugOverlay(options = {}) {
  if (!sharedListCaptureDebugOverlay) {
    sharedListCaptureDebugOverlay = createListCaptureDebugOverlay(options);
  }
  return sharedListCaptureDebugOverlay;
}
