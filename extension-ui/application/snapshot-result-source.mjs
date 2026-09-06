import { exactRecordId } from '../domain/record-id.mjs';
import { exactReadIdentity } from '../domain/read-identity.mjs';
import { readScope, readQuery, decodeResultDetail } from '../domain/read-contract.mjs';
import { buildResultCatalog } from '../domain/result-catalog.mjs';

const ABSENT = Symbol('absent');
const UNREADABLE = Symbol('unreadable');
const scopeKeys = ['tenantId', 'taskId', 'executionId'];
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const unavailable = () => new Error('Result read unavailable');

function own(value, key) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return UNREADABLE;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return ABSENT;
    return Object.hasOwn(descriptor, 'value') ? descriptor.value : UNREADABLE;
  } catch { return UNREADABLE; }
}

function sameScope(value, expected) {
  const scope = readScope(value);
  return scope !== null && scopeKeys.every(key => scope[key] === expected[key]);
}

/**
 * Read source over an explicitly supplied, immutable summary catalog.
 * Authority and detail loading are trusted injected capabilities, not proof that
 * a legacy record belongs to this scope. No legacy pool is imported or repaired.
 */
export function createSnapshotResultSource(options) {
  const authorize = own(options, 'authorize');
  const loadDetail = own(options, 'loadDetail');
  const suppliedNow = own(options, 'now');
  const now = suppliedNow === ABSENT ? Date.now : suppliedNow;
  if (typeof authorize !== 'function' || typeof loadDetail !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid snapshot source configuration');
  }
  let catalog = buildResultCatalog(own(options, 'manifest'));
  const { scope, snapshotId, recordNamespace } = catalog;
  let closed = false;
  const pending = new Set();

  function time() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw unavailable();
    return value;
  }

  function permission(value) {
    if (own(value, 'allowed') !== true || !sameScope(own(value, 'scope'), scope) ||
        own(value, 'snapshotId') !== snapshotId || own(value, 'recordNamespace') !== recordNamespace) throw unavailable();
    const accessRevision = exactReadIdentity(own(value, 'accessRevision'));
    const expiresAt = own(value, 'expiresAt');
    if (!accessRevision || !Number.isSafeInteger(expiresAt) || expiresAt <= time()) throw unavailable();
    return Object.freeze({ accessRevision, expiresAt });
  }

  function read(kind, request) {
    return new Promise((resolve, reject) => {
      let externalSignal;
      let controller;
      let operation;
      let publishExpiresAt;
      let stopped = false;
      let listening = false;

      function detach() {
        if (listening) {
          AbortSignal.prototype.removeEventListener.call(externalSignal, 'abort', operation.stop);
          listening = false;
        }
        if (operation) pending.delete(operation);
      }

      function fail() {
        if (stopped) return;
        stopped = true;
        detach();
        reject(unavailable());
        controller?.abort();
      }

      function guard() {
        if (closed || stopped || signalAborted.call(externalSignal)) throw unavailable();
      }

      try {
        if (closed || !sameScope(own(request, 'scope'), scope)) throw unavailable();
        externalSignal = own(request, 'signal');
        // Use the native signal brand and methods, not caller-supplied accessors.
        if (signalAborted.call(externalSignal)) throw unavailable();
        let query;
        let recordId;
        if (kind === 'page') {
          query = readQuery(own(request, 'query'));
          if (!query) throw unavailable();
        } else {
          recordId = exactRecordId(own(request, 'recordId'));
          if (!recordId || own(request, 'snapshotId') !== snapshotId) throw unavailable();
        }
        if (closed) throw unavailable();
        controller = new AbortController();
        operation = { stop: fail };
        pending.add(operation);
        AbortSignal.prototype.addEventListener.call(externalSignal, 'abort', operation.stop, { once: true });
        listening = true;
        const accessRequest = Object.freeze({ scope, snapshotId, recordNamespace, signal: controller.signal });

        Promise.resolve().then(async () => {
          guard();
          const beforeValue = await authorize(accessRequest);
          guard();
          const before = permission(beforeValue);
          guard();
          let page;
          let rawDetail;
          let projectedDetail;
          let recordVersion;
          const matchesDetail = () => own(rawDetail, 'recordVersion') === recordVersion &&
            own(rawDetail, 'recordNamespace') === recordNamespace &&
            own(rawDetail, 'recordId') === recordId && own(rawDetail, 'snapshotId') === snapshotId &&
            sameScope(own(rawDetail, 'scope'), scope);
          if (kind === 'page') {
            page = catalog.readPage(query);
          } else {
            const binding = catalog.lookup(recordId);
            if (!binding) throw unavailable();
            recordVersion = binding.recordVersion;
            guard();
            rawDetail = await loadDetail(Object.freeze({ ...accessRequest, recordId, recordVersion }));
            guard();
            // Check version/namespace before any detail field is inspected.
            if (!matchesDetail()) throw unavailable();
            guard();
            // Detach a bounded copy while the first permission is valid. Never
            // reread shared content after awaiting the second permission.
            projectedDetail = decodeResultDetail(rawDetail, scope, snapshotId, recordId);
            if (!projectedDetail) throw unavailable();
          }
          guard();
          const afterValue = await authorize(accessRequest);
          guard();
          const after = permission(afterValue);
          guard();
          if (before.accessRevision !== after.accessRevision) throw unavailable();
          let response;
          if (kind === 'page') response = page;
          else {
            // The loader's response may have changed while authorization ran.
            if (!matchesDetail()) throw unavailable();
            guard();
            response = Object.freeze({ scope, snapshotId, recordNamespace, recordId, detail: projectedDetail.detail });
          }
          // Expiration and revocation during asynchronous work must not publish.
          const finishedAt = time();
          if (before.expiresAt <= finishedAt || after.expiresAt <= finishedAt) throw unavailable();
          publishExpiresAt = Math.min(before.expiresAt, after.expiresAt);
          guard();
          return response;
        }).then(response => {
          if (stopped) return;
          if (publishExpiresAt <= time()) throw unavailable();
          guard();
          stopped = true;
          detach();
          resolve(response);
        }).catch(fail);
      } catch { fail(); }
    });
  }

  return Object.freeze({
    readSummaryPage(request) { return read('page', request); },
    readRecordDetail(request) { return read('detail', request); },
    close() {
      closed = true;
      catalog = null;
      const retired = [...pending];
      pending.clear();
      for (const operation of retired) operation.stop();
    },
  });
}
