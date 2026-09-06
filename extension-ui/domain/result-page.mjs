import { presentResult } from './result-presenter.mjs';

const MAX_PAGE_SIZE = 50;

function integer(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function ownValue(object, key) {
  try {
    if (!object || typeof object !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A display-only page over already-authorized, lightweight record summaries.
 * It neither reads record details nor grants authority to retry or synchronize.
 * The future storage adapter must supply summaries, not load the whole data pool.
 */
export function presentResultPage(records, options = {}) {
  let source = [];
  try { if (Array.isArray(records)) source = records; } catch { /* Invalid source stays empty. */ }
  const sourceLength = integer(ownValue(source, 'length'), 0);
  const offset = integer(ownValue(options, 'offset'), 0);
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, integer(ownValue(options, 'limit'), MAX_PAGE_SIZE)));
  const filter = ownValue(options, 'filter') === 'attention' ? 'attention' : 'all';
  const items = [];
  let matchingCount = 0;
  let attentionCount = 0;

  for (let index = 0; index < sourceLength; index += 1) {
    const item = presentResult(ownValue(source, String(index)));
    if (item.needsAttention) attentionCount += 1;
    if (filter === 'attention' && !item.needsAttention) continue;
    if (matchingCount >= offset && items.length < limit) items.push(item);
    matchingCount += 1;
  }

  return {
    items,
    counts: { all: sourceLength, attention: attentionCount, matching: matchingCount },
    page: {
      filter,
      offset,
      limit,
      hasPrevious: offset > 0 && matchingCount > 0,
      hasNext: offset < matchingCount && matchingCount - offset > items.length,
    },
  };
}
