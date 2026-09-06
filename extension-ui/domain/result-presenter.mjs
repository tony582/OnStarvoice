import { exactRecordId } from './record-id.mjs';
import { reviewResultSignals } from './result-review.mjs';

// Independent StarVoice presentation contract: values are text, never markup or actions.
const UNREADABLE = Symbol('unreadable');
const LIMITS = Object.freeze({ title: 180, author: 80, summary: 240, body: 12000, comments: 50, comment: 1600 });

function read(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  try {
    if (Array.isArray(value)) return undefined;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property) return undefined;
    return Object.hasOwn(property, 'value') ? property.value : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

function text(value, limit, fallback = '', multiline = false) {
  if (typeof value !== 'string') return fallback;
  // Bound work before normalizing untrusted record text. Never stringify objects.
  let result = value.slice(0, limit + 1)
    .replace(/[\uD800-\uDBFF]$/u, '')
    .replace(/[\uD800-\uDFFF]/gu, '\uFFFD')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu, '');
  result = (multiline ? result.replace(/\r\n?/gu, '\n') : result.replace(/\s+/gu, ' ')).trim();
  if (!result) return fallback;
  if (result.length > limit) {
    result = result.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…';
  }
  return result;
}

function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '—';
}

function captureState(status) {
  switch (status) {
    case 'pending': case 'queued': return { key: 'pending', label: '等待采集' };
    case 'running': return { key: 'running', label: '正在采集' };
    case 'completed': case 'succeeded': case 'success': return { key: 'completed', label: '采集已完成' };
    case 'partial': return { key: 'partial', label: '采集不完整，需要核对' };
    case 'needs_action': return { key: 'needs_action', label: '采集需要处理' };
    case 'failed': return { key: 'failed', label: '采集失败' };
    case 'cancelled': case 'stopped': return { key: 'stopped', label: '采集已停止' };
    default: return { key: 'unknown', label: '采集状态待确认' };
  }
}

function deliveryState(remote, local, reconciliation) {
  if (reconciliation === true) {
    return { key: 'reconciliation_required', label: '保存结果待核对', tone: 'warning' };
  }
  if (reconciliation !== undefined && reconciliation !== false) {
    return { key: 'unknown', label: '保存状态待确认', tone: 'warning' };
  }
  if (remote === 'confirmed') {
    if (local === 'confirmed') return { key: 'confirmed', label: '服务器与本地均已确认', tone: 'success' };
    return { key: 'local_unconfirmed', label: '服务器已收到，本地待核对', tone: 'warning' };
  }
  if (remote === 'unknown') {
    return { key: 'remote_unconfirmed', label: '服务器是否收到待核对', tone: 'warning' };
  }
  if (remote === 'failed') {
    if (local === 'failed') return { key: 'delivery_failed', label: '本地保存与服务器同步均失败', tone: 'danger' };
    return { key: 'remote_failed', label: local === 'confirmed' ? '本地已保存，服务器同步失败' : '服务器同步失败，需要处理', tone: 'warning' };
  }
  if (remote === 'pending') {
    if (local === 'confirmed') return { key: 'pending', label: '本地已保存，等待同步', tone: 'neutral' };
    if (local === 'pending') return { key: 'pending', label: '正在保存结果', tone: 'neutral' };
    if (local === 'failed') return { key: 'local_failed', label: '本地保存失败，需要处理', tone: 'danger' };
  }
  return { key: 'unknown', label: '保存状态待确认', tone: 'warning' };
}

function presentComments(value) {
  let truncated = false;
  try {
    if (!Array.isArray(value)) return { comments: [], truncated };
    truncated = Object.getOwnPropertyDescriptor(value, 'length')?.value > LIMITS.comments;
  } catch {
    return { comments: [], truncated: true };
  }
  const comments = [];
  // Read only the bounded prefix; accessor-backed entries are not executed.
  for (let index = 0; index < LIMITS.comments; index += 1) {
    let comment;
    try {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (!entry) continue;
      if (!Object.hasOwn(entry, 'value')) continue;
      comment = entry.value;
    } catch {
      break;
    }
    const rawBody = read(comment, 'text');
    const rawAuthor = read(comment, 'author');
    if ((typeof rawBody === 'string' && rawBody.length > LIMITS.comment) ||
      (typeof rawAuthor === 'string' && rawAuthor.length > LIMITS.author)) truncated = true;
    const body = text(rawBody, LIMITS.comment, '', true);
    if (!body) continue;
    comments.push({ author: text(rawAuthor, LIMITS.author, '评论者'), text: body });
  }
  return { comments, truncated };
}

/** Project a normalized record into bounded display-only values, with no side effects. */
export function presentResult(record) {
  const id = exactRecordId(read(record, 'id'));
  const kind = read(record, 'kind');
  const platform = read(record, 'platform');
  const capture = captureState(read(read(record, 'capture'), 'status'));
  const deliveryValue = read(record, 'delivery');
  const remote = read(deliveryValue, 'remote');
  const local = read(deliveryValue, 'local');
  const reconciliation = read(record, 'reconciliationRequired');
  const delivery = deliveryState(remote, local, reconciliation);
  return {
    id,
    title: text(read(record, 'title'), LIMITS.title, kind === 'profile' ? '未命名作者主页' : '未命名内容'),
    platformLabel: platform === 'xiaohongshu' ? '小红书' : platform === 'douyin' ? '抖音' : platform === 'weibo' ? '微博' : '未知平台',
    kindLabel: kind === 'note' ? '内容' : kind === 'profile' ? '作者主页' : kind === 'comments' ? '评论' : '未知类型',
    author: text(read(record, 'author'), LIMITS.author, '作者待确认'),
    summary: text(read(record, 'summary'), LIMITS.summary, '暂无内容摘要'),
    metrics: [{ label: '点赞', value: count(read(record, 'likes')) }, { label: '评论', value: count(read(record, 'commentsCount')) }],
    capture,
    delivery,
    needsAttention: !id || !['pending', 'running', 'completed'].includes(capture.key) || ['warning', 'danger'].includes(delivery.tone),
    review: reviewResultSignals(id, capture.key, remote, local, reconciliation),
  };
}

/** Project heavy detail only when the caller explicitly requests it. */
export function presentResultDetail(record) {
  const body = read(record, 'body');
  const preview = presentComments(read(record, 'comments'));
  const priorTruncation = read(record, 'truncated');
  return {
    body: text(body, LIMITS.body, '', true),
    comments: preview.comments,
    truncated: {
      body: (typeof body === 'string' && body.length > LIMITS.body) || read(priorTruncation, 'body') === true,
      comments: preview.truncated || read(priorTruncation, 'comments') === true,
    },
  };
}
