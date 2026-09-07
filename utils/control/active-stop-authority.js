(function install(root) {
  'use strict';
  const ACTION = 'stop_active_capture';
  const POLICY = 'active-capture-stop-v1';
  const WINDOW_MS = 5000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SOURCE_KEYS = ['clientTaskId', 'controlTaskId', 'clientAttemptId', 'attemptNumber',
    'progressSeq', 'sourceUpdatedAt', 'cloudCommandId', 'platform', 'status'];
  const canonical = value => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  };
  const copy = value => JSON.parse(JSON.stringify(value));
  function lockIdentity(lock, request, {allowReservation = false} = {}) {
    if (!lock || lock.owner !== 'unattended_keyword_plan' ||
        !['id', 'holderId', 'holderDocumentId'].every(key => typeof lock[key] === 'string' && lock[key].trim() === lock[key] && lock[key]) ||
        !Number.isSafeInteger(lock.holderTabId) || lock.holderTabId <= 0) throw new Error('owner_unproven');
    const reserved = !lock.captureTaskId && !lock.captureTaskAttemptId;
    if (reserved ? (!allowReservation || lock.holderTabId !== request.runnerTabId)
      : (lock.captureTaskId !== `unattended-capture:${request.id}` || lock.captureTaskAttemptId !== request.attemptId)) {
      throw new Error('owner_unproven');
    }
    return Object.fromEntries(['id', 'owner', 'holderId', 'holderDocumentId', 'holderTabId',
      'captureTaskId', 'captureTaskAttemptId'].map(key => [key, lock[key] ?? '']));
  }
  function candidate(state, {allowReservation = false} = {}) {
    const {request: r, ledger, archive, auth, lock} = state;
    if (!r || r.status !== 'running' || !UUID.test(r.id) || !UUID.test(r.attemptId) ||
        r.cloudAssigned !== true || !UUID.test(r.cloudCommandId) ||
        !Number.isSafeInteger(r.attemptNumber) || r.attemptNumber < 1 ||
        !Number.isSafeInteger(r.progressSeq) || r.progressSeq < 0 ||
        !Number.isFinite(Date.parse(r.updatedAt)) || new Date(r.updatedAt).toISOString() !== r.updatedAt ||
        !auth?.authMutationId || !auth.captureAgent?.id || !auth.captureAgent.token || !auth.tenant?.id ||
        r.cloudAgentScopeId !== auth.captureAgent.id || r.orchestrationContext || r.parentRequestId ||
        r.previousAttemptId || r.recoveryPendingLaunch === true || r.localClosureEvidence ||
        r.recoveryAdoptionReceipt || !['xiaohongshu', 'douyin'].includes(r.planSnapshot?.platform)) {
      throw new Error('active_source_unproven');
    }
    const matches = ledger?.runs?.filter(row => row?.id === r.id);
    if (matches?.length !== 1 || matches[0].attemptId !== r.attemptId ||
        matches[0].updatedAt !== r.updatedAt || matches[0].status !== 'running' ||
        matches[0].metadata?.cloudAgentScopeId !== r.cloudAgentScopeId ||
        matches[0].metadata?.cloudCommandId !== r.cloudCommandId ||
        (archive && (!archive.requests || Object.values(archive.requests).some(item => item?.id === r.id)))) {
      throw new Error('active_source_ambiguous');
    }
    const identity = lockIdentity(lock, r, {allowReservation});
    const source = {clientTaskId: r.id, controlTaskId: r.id, clientAttemptId: r.attemptId,
      attemptNumber: r.attemptNumber, progressSeq: r.progressSeq, sourceUpdatedAt: r.updatedAt,
      cloudCommandId: r.cloudCommandId, platform: r.planSnapshot.platform, status: 'running'};
    return {source, auth: copy(auth), lockIdentity: identity,
      fingerprint: canonical({request: r, row: matches[0], lock: identity})};
  }
  async function credentialFingerprint(auth) {
    const bytes = new root.TextEncoder().encode(canonical(auth));
    const digest = await root.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  }
  function create({query, now = Date.now, setTimer = root.setTimeout, clearTimer = root.clearTimeout}) {
    async function evaluate(current) {
      const deadline = now() + WINDOW_MS;
      const controller = new root.AbortController();
      let timer;
      try {
        const response = await Promise.race([
          query({action: ACTION, source: current.source}, {rawAuth: current.auth, signal: controller.signal}),
          new Promise((_, reject) => { timer = setTimer(() => {
            controller.abort(); reject(new Error('stop_authority_expired'));
          }, WINDOW_MS); }),
        ]);
        if (response?.ok !== true || response.decision !== 'allow' || response.action !== ACTION ||
            response.policyVersion !== POLICY || !/^[a-f0-9]{64}$/.test(response.authorityRevision) ||
            response.agentId !== current.auth.captureAgent.id || response.tenantId !== current.auth.tenant.id ||
            !response.authCodeId || !response.authBindingId ||
            SOURCE_KEYS.some(key => response.source?.[key] !== current.source[key]) ||
            ['serverTaskId', 'serverAttemptId', 'snapshotId', 'snapshotFingerprint'].some(key => !response.source?.[key]) ||
            !Number.isFinite(Date.parse(response.expiresAt)) || !Number.isFinite(Date.parse(response.evaluatedAt)) ||
            Date.parse(response.expiresAt) - Date.parse(response.evaluatedAt) > WINDOW_MS ||
            now() >= Math.min(deadline, Date.parse(response.expiresAt))) throw new Error('stop_authority_denied');
        return {deadline: Math.min(deadline, Date.parse(response.expiresAt)), authority: copy(response)};
      } finally {clearTimer(timer);}
    }
    return Object.freeze({evaluate});
  }
  root.OnStarvoiceActiveStopAuthority = Object.freeze({ACTION, POLICY, WINDOW_MS,
    SOURCE_KEYS, candidate, lockIdentity, canonical, credentialFingerprint, create});
})(globalThis);
