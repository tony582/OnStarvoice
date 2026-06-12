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
    const stored = parseMetricNumber(rowValue, 0);
    if (stored > 0) return stored;
    return (
      resolveMetricFromPayload(observationPayload, dimension, keys) ||
      resolveMetricFromPayload(recordPayload, dimension, keys)
    );
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
