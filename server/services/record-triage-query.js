import {withTransaction} from '../db/query.js';
import {ClientGoneError} from './display-read-resilience.js';

// Evidence predicates have high estimated costs, but short real runtimes.
// Keep JIT compilation and these reads out of the general/control capacity.
const OPTIONS = Object.freeze({category: 'reporting', readOnly: true, jitOff: true,
  statementTimeoutMs: 10000, lockTimeoutMs: 500, waitTimeoutMs: 3000});

// `clientGone` is asked once the read owns its reporting slot. A list request
// the browser already replaced (every filter change aborts the previous one)
// then gives the slot back instead of running a statement nobody will read.
// `statementTimeoutMs` lets one read (the export) keep a longer statement
// limit; the category, read-only mode and lock/wait limits stay shared.
function readUnlessClientGone(read, {clientGone, statementTimeoutMs} = {}) {
  const options = statementTimeoutMs ? {...OPTIONS, statementTimeoutMs} : OPTIONS;
  return withTransaction(tx => {
    if (typeof clientGone === 'function' && clientGone()) throw new ClientGoneError();
    return read(tx);
  }, options);
}

export function queryTriageAll(sql, params = [], options = {}) {
  return readUnlessClientGone(tx => tx.queryAll(sql, params), options);
}

export function queryTriageOne(sql, params = [], options = {}) {
  return readUnlessClientGone(tx => tx.queryOne(sql, params), options);
}
