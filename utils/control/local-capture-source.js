// Cooperative production-origin witness. Negative cloud flags are never proof.
// Only the background's guarded plan/request writers may publish this root.
(function install(root) {
  'use strict';
  const KEY = 'onstarvoice.localCaptureOrigin.v1';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const SHA = /^[a-f0-9]{64}$/;
  const canonical = value => root.OnStarvoiceLocalCaptureAuthority.canonical(value);
  const copy = value => value == null ? value : JSON.parse(canonical(value));
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const uuid = value => typeof value === 'string' && UUID.test(value);
  const hash = value => typeof value === 'string' && SHA.test(value);
  const timestamp = value => typeof value === 'string' && value.length === 24 &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const text = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
  const absent = value => value === undefined || value === null || value === '';
  function freeze(value) {
    if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}
    return value;
  }
  const lineageKeys = ['orchestrationContext', 'orchestration', 'parentTaskId', 'previousAttemptId',
    'recoveryAdoptionReceipt', 'recoveryAdoptedAt', 'localClosureEvidence', 'localClosureEvidences',
    'localClosureStopConfirmation', 'resumeCommandId', 'stopCommandId', 'itemIds', 'itemAttempts',
    'recoveryTaskId', 'recoveryAdoption', 'localRecoveryAdoption', 'adoptionReceipt',
    'localClosure', 'localClosures', 'orchestrationChild', 'orchestrationRevision',
    'handoffSuccessorTaskId', 'attemptIdentity', 'parent_task_id', 'cloud_command_id'];
  const otherLineage = value => record(value) && lineageKeys.some(key => !absent(value[key]));
  function planIdentity(plan) {
    // Runtime schedule/progress projections are not a new authored plan.
    const value = copy(plan || {});
    for (const key of ['updatedAt', 'nextRunAt', 'lastRunAt', 'lastRunStatus', 'lastRunMessage',
      'lastRunProgress', 'lastRunRequestId']) delete value[key];
    return value;
  }
  function validProof(p) {
    try {
      const proof = copy(p);
      return record(proof) && proof.version === 1 && proof.kind === 'local-authored-plan' && uuid(proof.originId) &&
        hash(proof.planFingerprint) && hash(proof.credentialFingerprint) && text(proof.authMutationId) &&
        timestamp(proof.createdAt) && record(proof.binding) &&
        ['tenantId', 'agentId', 'authCodeId', 'authBindingId'].every(key => uuid(proof.binding[key])) &&
        hash(proof.binding.bindingRevision) && record(proof.planSnapshot) &&
        ['xiaohongshu', 'douyin'].includes(proof.planSnapshot.platform) && !otherLineage(proof) &&
        !otherLineage(proof.planSnapshot);
    } catch {return false;}
  }
  function requestProof(state, {allowSuccessor = true} = {}) {
    const r = copy(state?.request), p = copy(state?.origin?.request);
    if (!validProof(p) || state.origin?.version !== 1 || !r ||
        p.requestId !== r.id || p.attemptId !== r.attemptId || !uuid(r.id) || !uuid(r.attemptId) ||
        !timestamp(p.requestCreatedAt) || p.requestCreatedAt !== r.createdAt || !timestamp(r.updatedAt) ||
        Date.parse(p.createdAt) > Date.parse(r.createdAt) || Date.parse(r.createdAt) > Date.parse(r.updatedAt) ||
        r.type !== 'keyword_batch' || r.cloudAssigned !== false || r.cloudCommandId !== '' ||
        r.cloudAgentScopeId !== p.binding.agentId || r.strictControlCandidate !== true ||
        otherLineage(r) || otherLineage(r.metadata) || otherLineage(r.planSnapshot) ||
        canonical(planIdentity(r.planSnapshot)) !== canonical(planIdentity(p.planSnapshot)) ||
        state.auth?.authMutationId !== p.authMutationId || state.auth?.tenant?.id !== p.binding.tenantId ||
        state.auth?.captureAgent?.id !== p.binding.agentId || !text(state.auth.captureAgent.token) ||
        r.recoveryPendingLaunch === true || !absent(r.recoveryDismissedAt)) throw new Error('local_source_unproven');
    const successor = p.generation === 2 && uuid(p.sourceRequestId) && uuid(p.sourceAttemptId) && uuid(p.launchIntentId) &&
      p.sourceRequestId !== r.id && p.sourceAttemptId !== r.attemptId;
    if (successor ? (!allowSuccessor || r.parentRequestId !== p.sourceRequestId ||
      r.localRecoveryIntentId !== p.launchIntentId || r.attemptNumber !== 2) :
      (p.generation !== 1 || !absent(p.sourceRequestId) || !absent(p.sourceAttemptId) || !absent(p.launchIntentId) ||
        !absent(r.parentRequestId) || !absent(r.localRecoveryIntentId) || r.attemptNumber !== 1 ||
        !absent(r.recoveryReason) || !absent(r.recoveryMode))) {
      throw new Error('local_lineage_unproven');
    }
    const rows = state.ledger?.runs?.filter(row => row?.id === r.id);
    const row = rows?.length === 1 ? copy(rows[0]) : null;
    const metadata = row?.metadata;
    if (!row || row.attemptId !== r.attemptId || row.status !== r.status ||
        row.taskType !== 'unattended_keyword_capture' || row.featureKey !== 'unattended_keyword_plan' ||
        row.source !== 'unattended_supervisor' || row.platform !== r.planSnapshot.platform ||
        row.attemptNumber !== r.attemptNumber || row.progressSeq !== r.progressSeq ||
        row.createdAt !== r.createdAt || row.updatedAt !== r.updatedAt || !record(metadata) ||
        metadata.cloudAgentScopeId !== p.binding.agentId || metadata.cloudCommandId !== '' ||
        metadata.cloudAssigned !== false || otherLineage(row) || otherLineage(metadata) ||
        metadata.parentRequestId !== (successor ? p.sourceRequestId : '') ||
        (!absent(row.parentRequestId) && row.parentRequestId !== (successor ? p.sourceRequestId : '')) ||
        (!absent(metadata.localRecoveryIntentId) && (!successor || metadata.localRecoveryIntentId !== p.launchIntentId)) ||
        (metadata.recoveryReason ?? '') !== (r.recoveryReason ?? '') ||
        (metadata.recoveryMode ?? '') !== (r.recoveryMode ?? '') ||
        (state.archive && (!state.archive.requests || Object.values(state.archive.requests).some(row => row?.id === r.id))) ||
        (state.ledger?.clearedAt && (!timestamp(state.ledger.clearedAt) ||
          Date.parse(state.ledger.clearedAt) >= Date.parse(p.requestCreatedAt)))) throw new Error('local_source_ambiguous');
    return freeze(p);
  }
  function candidate(state, options = {}) {
    const p = requestProof(state), r = state.request;
    if (r.status !== 'running' || !Number.isSafeInteger(r.progressSeq) || r.progressSeq < 0 ||
        !timestamp(r.updatedAt)) throw new Error('local_source_not_running');
    const lockIdentity = root.OnStarvoiceActiveStopAuthority.lockIdentity(state.lock, r, options);
    return freeze({local: true, proof: copy(p), auth: copy(state.auth), lockIdentity,
      source: {clientTaskId: r.id, clientAttemptId: r.attemptId, platform: r.planSnapshot.platform,
        cloudCommandId: '', attemptNumber: r.attemptNumber, progressSeq: r.progressSeq,
        sourceUpdatedAt: r.updatedAt, status: r.status},
      fingerprint: canonical({request: r, row: state.ledger.runs.find(row => row.id === r.id), proof: p, lockIdentity})});
  }
  function create({authority}) {
    async function evaluate(current, action = 'stop_local_capture') {
      // Capture once before the first await. A queued caller cannot swap the
      // plan/proof or credential after hashing but before the authority query.
      const snapshot = freeze(copy(current));
      if (!validProof(snapshot?.proof)) throw new Error('local_plan_changed');
      if (snapshot.local !== true || !record(snapshot.source) ||
          snapshot.source.clientTaskId !== snapshot.proof.requestId ||
          snapshot.source.clientAttemptId !== snapshot.proof.attemptId ||
          snapshot.source.platform !== snapshot.proof.planSnapshot.platform ||
          snapshot.source.attemptNumber !== snapshot.proof.generation ||
          ![1, 2].includes(snapshot.proof.generation) || snapshot.source.cloudCommandId !== '' ||
          snapshot.source.status !== 'running' || !timestamp(snapshot.source.sourceUpdatedAt) ||
          !Number.isSafeInteger(snapshot.source.progressSeq) || snapshot.source.progressSeq < 0 ||
          typeof snapshot.fingerprint !== 'string') throw new Error('local_source_unproven');
      if (
          await root.OnStarvoiceLocalCaptureAuthority.hash(planIdentity(snapshot.proof.planSnapshot)) !== snapshot.proof.planFingerprint) {
        throw new Error('local_plan_changed');
      }
      if (await root.OnStarvoiceLocalCaptureAuthority.hash(snapshot.auth) !== snapshot.proof.credentialFingerprint) {
        throw new Error('local_credential_changed');
      }
      const source = {originId: snapshot.proof.originId, planFingerprint: snapshot.proof.planFingerprint,
        platform: snapshot.source.platform, requestId: snapshot.source.clientTaskId,
        attemptId: snapshot.source.clientAttemptId, generation: snapshot.proof.generation,
        sourceRevision: await root.OnStarvoiceLocalCaptureAuthority.hash(snapshot.fingerprint)};
      return authority.evaluate({action, source, auth: snapshot.auth, expectedBinding: snapshot.proof.binding});
    }
    return Object.freeze({candidate, evaluate,
      matches(state, j) {
        try {
          const p = requestProof(state);
          // This string comes from the worker-private admission witness, never
          // reconstructed from the same mutable storage that supplies p.
          return typeof j.originWitness === 'string' && j.originWitness === canonical(p) &&
            j.originKind === 'local-v1' && j.originId === p.originId && j.generation === p.generation &&
            j.requestId === p.requestId && j.attemptId === p.attemptId;
        } catch {return false;}
      },
    });
  }
  root.OnStarvoiceLocalCaptureSource = Object.freeze({KEY, validProof, planIdentity, requestProof, candidate, create});
})(globalThis);
