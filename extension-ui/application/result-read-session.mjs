import { exactRecordId } from '../domain/record-id.mjs';
import { readScope, readQuery, decodeResultPage, decodeResultDetail } from '../domain/read-contract.mjs';

const ABSENT = Symbol('absent');
const UNREADABLE = Symbol('unreadable');

function own(value, key) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ABSENT;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return ABSENT;
    return Object.hasOwn(descriptor, 'value') ? descriptor.value : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

const token = () => Object.freeze({});
const outcome = (requestToken, value) => Object.freeze({ ...value, requestToken });

/**
 * A fixed-scope read coordinator over two trusted, injected read capabilities.
 * The source must authorize and isolate real data; matching echoes are not auth.
 * No producer, persistence, retry, task control, or UI implementation lives here.
 */
export function createResultReadSession(options) {
  const scope = readScope(own(options, 'scope'));
  const source = own(options, 'source');
  const readSummaryPage = own(source, 'readSummaryPage');
  const readRecordDetail = own(source, 'readRecordDetail');
  const suppliedTimeout = own(options, 'timeoutMs');
  const timeoutMs = suppliedTimeout === ABSENT ? 3000 : suppliedTimeout;
  if (!scope || typeof readSummaryPage !== 'function' || typeof readRecordDetail !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError('Invalid read session configuration');
  }

  let closed = false;
  let acceptedPage = null;
  const pending = { page: null, detail: null };
  const current = { page: null, detail: null };

  function replace(kinds, status, nextKind = null) {
    const requestToken = nextKind === null ? null : token();
    const retired = kinds.map(kind => pending[kind]);
    if (kinds.includes('page')) acceptedPage = null;
    // Publish the complete new generation before notifying source listeners.
    // An abort listener may synchronously start a newer read, which must win.
    for (const kind of kinds) {
      current[kind] = null;
      pending[kind] = null;
    }
    if (nextKind !== null) current[nextKind] = requestToken;
    for (const operation of retired) operation?.stop(status);
    return requestToken;
  }

  function clear(status) { replace(['page', 'detail'], status); }
  function begin(kind) { return replace(kind === 'page' ? ['page', 'detail'] : ['detail'], 'superseded', kind); }

  function immediate(requestToken, status) {
    return Promise.resolve(outcome(requestToken, { status }));
  }

  function start(kind, requestToken, invoke, decode, accept) {
    const controller = new AbortController();
    let resolve;
    let settled = false;
    let timer;
    const result = new Promise(done => { resolve = done; });
    const operation = {
      stop(status) {
        // Resolve locally before requesting cooperative source cancellation.
        // A source ignoring the signal must not keep the consumer waiting.
        settle({ status });
        controller.abort();
      },
    };
    function settle(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pending[kind] === operation) pending[kind] = null;
      resolve(outcome(requestToken, value));
    }
    pending[kind] = operation;
    timer = setTimeout(() => operation.stop('timed_out'), timeoutMs);

    // Defer the call so an immediate close/cancel does not even start a read.
    Promise.resolve().then(() => {
      if (!settled && (closed || current[kind] !== requestToken)) {
        operation.stop(closed ? 'closed' : 'superseded');
      }
      if (!settled) return invoke(controller.signal);
      return undefined;
    }).then(value => {
      if (settled) return;
      let decoded;
      try { decoded = decode(value); } catch { decoded = null; }
      // Descriptor traps may execute arbitrary caller code. Do not publish if
      // the request was invalidated while its response was being inspected.
      if (settled || current[kind] !== requestToken || closed) return;
      if (!decoded) settle({ status: 'invalid_response' });
      else settle(accept(decoded));
    }).catch(() => {
      // Never surface source exception messages or raw records to the view.
      settle({ status: 'read_failed' });
    });
    return result;
  }

  function readPage(value) {
    if (closed) return immediate(token(), 'closed');
    const requestToken = begin('page');
    const query = readQuery(value);
    if (closed || current.page !== requestToken) return immediate(requestToken, closed ? 'closed' : 'superseded');
    if (!query) return immediate(requestToken, 'invalid_request');
    return start('page', requestToken,
      signal => Reflect.apply(readSummaryPage, source, [Object.freeze({ scope, query, signal })]),
      response => decodeResultPage(response, scope, query),
      decoded => {
        const pageToken = token();
        const ids = new Map();
        for (const item of decoded.page.items) {
          if (item.id) ids.set(item.id, (ids.get(item.id) ?? 0) + 1);
        }
        acceptedPage = { pageToken, snapshotId: decoded.snapshotId, ids };
        return { status: 'ready', pageToken, page: decoded.page };
      });
  }

  function readDetail(value) {
    if (closed) return immediate(token(), 'closed');
    const requestToken = begin('detail');
    const recordId = exactRecordId(own(value, 'recordId'));
    const pageToken = own(value, 'pageToken');
    if (closed || current.detail !== requestToken) return immediate(requestToken, closed ? 'closed' : 'superseded');
    if (!recordId) return immediate(requestToken, 'invalid_request');
    const selection = acceptedPage;
    if (!selection || pageToken !== selection.pageToken || selection.ids.get(recordId) !== 1) {
      return immediate(requestToken, 'selection_unavailable');
    }
    const { snapshotId } = selection;
    return start('detail', requestToken,
      signal => Reflect.apply(readRecordDetail, source, [Object.freeze({ scope, snapshotId, recordId, signal })]),
      response => decodeResultDetail(response, scope, snapshotId, recordId),
      decoded => ({ status: 'ready', ...decoded }));
  }

  return Object.freeze({
    readPage,
    readDetail,
    // Check immediately before rendering even already-settled Promise results.
    // Tokens are local freshness hints, not transferable authorization proofs.
    isCurrent(requestToken) {
      return !closed && requestToken != null &&
        (requestToken === current.page || requestToken === current.detail);
    },
    cancel() { clear('cancelled'); },
    close() { closed = true; clear('closed'); },
  });
}
