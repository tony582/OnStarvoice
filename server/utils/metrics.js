export function parseMetricNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback;

  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
  }

  const text = String(value).replace(/[,，\s]/g, '').trim();
  if (!text) return fallback;

  const match = text.match(/(-?\d+(?:\.\d+)?)(亿|万|[wW]|[kK])?/);
  if (!match) return fallback;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return fallback;

  const unit = match[2] || '';
  if (unit === '亿') return Math.round(amount * 100000000);
  if (unit === '万' || /^[wW]$/.test(unit)) return Math.round(amount * 10000);
  if (/^[kK]$/.test(unit)) return Math.round(amount * 1000);
  return Math.round(amount);
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function firstPayloadItem(payload) {
  const safePayload = parseJsonObject(payload);
  if (!Array.isArray(safePayload.items)) return {};
  return safePayload.items.find(
    item => item && typeof item === 'object' && !Array.isArray(item),
  ) || {};
}

function pickPayloadValue(payload, keys = []) {
  const safePayload = parseJsonObject(payload);
  const listItem = firstPayloadItem(safePayload);
  const sources = [
    parseJsonObject(safePayload.detailPayload),
    parseJsonObject(listItem.detailPayload),
    listItem,
    safePayload,
  ];

  for (const key of keys) {
    for (const source of sources) {
      if (source?.[key] != null && source[key] !== '') return source[key];
    }
  }
  return '';
}

const METRIC_KNOWN_FLAG_KEYS = Object.freeze({
  likes: ['likesKnown', 'likeCountKnown'],
  comments: [
    'commentsKnown',
    'commentsCountKnown',
    'commentCountKnown',
  ],
  collects: ['collectsKnown', 'collectsCountKnown', 'collectCountKnown'],
  shares: ['sharesKnown', 'sharesCountKnown', 'shareCountKnown'],
});

function normalizeMetricDimension(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'comment' || normalized === 'comment_count') return 'comments';
  if (normalized === 'collect' || normalized === 'favorite') return 'collects';
  if (normalized === 'like' || normalized === 'digg') return 'likes';
  if (normalized === 'share' || normalized === 'repost') return 'shares';
  return normalized;
}

function isExplicitMetricZero(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value === 0;
  }
  const normalized = String(value ?? '')
    .replace(/[,，\s]/g, '')
    .trim();
  return /^0(?:\.0+)?(?:亿|万|[wWkK])?$/.test(normalized);
}

function isMetricKnownBySource(source, dimension) {
  if (!source || typeof source !== 'object') return false;
  if (source.metricKnown?.[dimension] === true) return true;
  return (METRIC_KNOWN_FLAG_KEYS[dimension] || []).some(
    (key) => source[key] === true,
  );
}

const COMMENT_COUNT_SOURCE_KEYS = Object.freeze([
  'commentsCountSource',
  'commentCountSource',
  'comments_count_source',
  'comment_count_source',
]);

function hasOwn(source, key) {
  return Boolean(
    source &&
      typeof source === 'object' &&
      Object.prototype.hasOwnProperty.call(source, key),
  );
}

function parseExplicitBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
}

export function normalizeCommentCountSource(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return normalized || 'unknown';
}

/**
 * Keep the capture-side certainty metadata attached to the metric all the way
 * through sync normalization and persistence. Older clients did not send a
 * source, so their positive values remain usable but are explicitly marked as
 * legacy evidence instead of being mistaken for API evidence.
 */
export function resolveCommentCountEvidenceFromPayload(payload) {
  const safePayload = parseJsonObject(payload);
  const listItem = firstPayloadItem(safePayload);
  const sources = [
    parseJsonObject(safePayload.detailPayload),
    parseJsonObject(listItem.detailPayload),
    listItem,
    safePayload,
  ];

  let source = '';
  let known = null;

  for (const candidate of sources) {
    if (!source) {
      for (const key of COMMENT_COUNT_SOURCE_KEYS) {
        if (candidate?.[key] == null || candidate[key] === '') continue;
        source = normalizeCommentCountSource(candidate[key]);
        break;
      }
    }

    if (known == null) {
      if (candidate?.metricKnown?.comments != null) {
        known = parseExplicitBoolean(candidate.metricKnown.comments);
      }
      if (known == null) {
        for (const key of METRIC_KNOWN_FLAG_KEYS.comments) {
          if (!hasOwn(candidate, key)) continue;
          known = parseExplicitBoolean(candidate[key]);
          if (known != null) break;
        }
      }
    }

    if (source && known != null) break;
  }

  const resolvedKnown = known === true;
  return {
    known: resolvedKnown,
    source:
      source ||
      (resolvedKnown ? 'legacy_known' : 'legacy_unverified'),
  };
}

export function commentCountEvidenceRank({known = false, source = ''} = {}) {
  if (!known) return 0;
  const normalizedSource = normalizeCommentCountSource(source);
  if (normalizedSource === 'api_statistics') return 3;
  if (
    normalizedSource === 'dom_count' ||
    normalizedSource === 'dom_empty_state'
  ) {
    return 2;
  }
  return 1;
}

/**
 * Resolve a metric for an incremental write. `null` means the current capture
 * did not observe that dimension and the stored value must be preserved;
 * numeric 0 means the page explicitly proved a real zero and may overwrite.
 */
export function resolveMetricUpdateFromPayload(
  payload,
  dimension,
  keys = [],
  {syncType = ''} = {},
) {
  const safePayload = parseJsonObject(payload);
  const listItem = firstPayloadItem(safePayload);
  const normalizedDimension = normalizeMetricDimension(dimension);
  const normalizedSyncType = String(syncType || safePayload.syncType || '')
    .trim()
    .toLowerCase();
  const detailCaptureDone = [
    safePayload.detailCaptureStatus,
    listItem.detailCaptureStatus,
  ].some((status) => String(status || '').trim().toLowerCase() === 'done');
  const sources = [
    {
      value: parseJsonObject(safePayload.detailPayload),
      detail: detailCaptureDone,
    },
    {
      value: parseJsonObject(listItem.detailPayload),
      detail: detailCaptureDone,
    },
    {value: listItem, detail: false},
    {value: safePayload, detail: normalizedSyncType === 'single_note'},
  ];

  for (const sourceEntry of sources) {
    const source = sourceEntry.value;
    for (const key of keys) {
      if (source?.[key] == null || source[key] === '') continue;
      const rawValue = source[key];
      const parsed = parseMetricNumber(rawValue, 0);
      if (parsed > 0) return parsed;
      if (!isExplicitMetricZero(rawValue)) continue;

      const displayedDimension = normalizeMetricDimension(
        source.displayMetricDimension ||
          listItem.displayMetricDimension ||
          safePayload.displayMetricDimension,
      );
      if (
        sourceEntry.detail ||
        isMetricKnownBySource(source, normalizedDimension) ||
        ((source.displayMetricKnown === true ||
          listItem.displayMetricKnown === true ||
          safePayload.displayMetricKnown === true) &&
          displayedDimension === normalizedDimension)
      ) {
        return 0;
      }
    }
  }

  const displayDimension = normalizeMetricDimension(
    listItem.displayMetricDimension || safePayload.displayMetricDimension,
  );
  if (displayDimension !== normalizedDimension) return null;

  const displayValue =
    listItem.displayMetricCount ?? safePayload.displayMetricCount;
  const parsedDisplayValue = parseMetricNumber(displayValue, 0);
  if (parsedDisplayValue > 0) return parsedDisplayValue;
  const displayMetricKnown = Boolean(
    listItem.displayMetricKnown === true ||
      safePayload.displayMetricKnown === true,
  );
  return displayMetricKnown && isExplicitMetricZero(displayValue) ? 0 : null;
}

export function resolveMetricFromPayload(payload, dimension, keys = []) {
  const direct = parseMetricNumber(pickPayloadValue(payload, keys), 0);
  if (direct > 0) return direct;

  const displayDimension = String(
    pickPayloadValue(payload, ['displayMetricDimension']),
  )
    .trim()
    .toLowerCase();
  const displayCount = parseMetricNumber(
    pickPayloadValue(payload, ['displayMetricCount']),
    0,
  );
  return displayDimension === dimension && displayCount > 0
    ? displayCount
    : 0;
}

export function resolveRecordMetrics(row = {}) {
  const recordPayload = row.record_payload || row.payload || {};
  const observationPayload = row.observation_payload || {};
  const metric = (rowValue, dimension, keys) => {
    const observedUpdate = resolveMetricUpdateFromPayload(
      observationPayload,
      dimension,
      keys,
    );
    if (observedUpdate !== null) return observedUpdate;

    const stored = parseMetricNumber(rowValue, 0);
    if (stored > 0) return stored;

    const recordUpdate = resolveMetricUpdateFromPayload(
      recordPayload,
      dimension,
      keys,
    );
    if (recordUpdate !== null) return recordUpdate;

    return resolveMetricFromPayload(recordPayload, dimension, keys);
  };

  return {
    likes: metric(row.likes, 'likes', [
      'likes',
      'likeCount',
      'like_count',
      'diggCount',
      'digg_count',
      'attitudes_count',
      'attitudesCount',
    ]),
    comments_count: metric(row.comments_count, 'comments', [
      'comments',
      'commentCount',
      'comment_count',
      'commentsCount',
      'comments_count',
    ]),
    collects: metric(row.collects, 'collects', [
      'collects',
      'collectCount',
      'collect_count',
      'collectsCount',
      'collects_count',
    ]),
    shares: metric(row.shares, 'shares', [
      'shares',
      'shareCount',
      'share_count',
      'reposts',
      'repostCount',
      'repost_count',
      'repostsCount',
      'reposts_count',
    ]),
  };
}

export function applyResolvedMetrics(row = {}) {
  const { record_payload, observation_payload, payload, ...rest } = row;
  const metrics = resolveRecordMetrics({ ...row, record_payload, observation_payload, payload });
  const interactionTotal =
    metrics.likes + metrics.comments_count + metrics.collects + metrics.shares;
  return {
    ...rest,
    ...metrics,
    observation_interaction:
      parseMetricNumber(row.observation_interaction, 0) || interactionTotal,
  };
}
