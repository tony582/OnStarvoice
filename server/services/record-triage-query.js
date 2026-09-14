import {withTransaction} from '../db/query.js';

// Evidence predicates have high estimated costs, but short real runtimes.
// Keep JIT compilation and these reads out of the general/control capacity.
const OPTIONS = Object.freeze({category: 'reporting', readOnly: true, jitOff: true,
  statementTimeoutMs: 10000, lockTimeoutMs: 500, waitTimeoutMs: 3000});

export function queryTriageAll(sql, params = []) {
  return withTransaction(tx => tx.queryAll(sql, params), OPTIONS);
}

export function queryTriageOne(sql, params = []) {
  return withTransaction(tx => tx.queryOne(sql, params), OPTIONS);
}
