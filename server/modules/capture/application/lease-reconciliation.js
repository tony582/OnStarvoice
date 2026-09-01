function requireDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function normalizeCandidateLimit(value) {
  return Math.max(1, Math.min(200, Number(value) || 50));
}

export function createElasticCaptureLeaseReconciler({
  reconcileLeases,
  listCandidates,
  withTransaction,
  settleCandidate,
} = {}) {
  if (reconcileLeases !== undefined) {
    const runReconciliation = requireDependency(
      'reconcileLeases',
      reconcileLeases,
    );
    return async function reconcileElasticCaptureLeases(input = 50) {
      return runReconciliation(input);
    };
  }
  const listLeaseCandidates = requireDependency(
    'listCandidates',
    listCandidates,
  );
  const runTransaction = requireDependency('withTransaction', withTransaction);
  const settleLeaseCandidate = requireDependency(
    'settleCandidate',
    settleCandidate,
  );

  return async function reconcileElasticCaptureLeases(limit = 50) {
    const candidates = await listLeaseCandidates(
      normalizeCandidateLimit(limit),
    );
    const summary = {scanned: candidates.length, requeued: 0, skipped: 0};
    for (const candidate of candidates) {
      const settled = await runTransaction(tx =>
        settleLeaseCandidate(tx, candidate)
      );
      if (settled) summary.requeued += 1;
      else summary.skipped += 1;
    }
    return summary;
  };
}
