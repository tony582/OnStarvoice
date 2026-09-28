(function (root) {
  'use strict';
  const STORAGE_KEY = 'onstarvoice.manualKeywordDispatch.v1';
  const QUERY_KEY = 'manualKeywordBatch';
  const terminal = new Set(['completed', 'completed_with_failures', 'failed', 'canceled', 'needs_action']);

  // This is a delivery receipt, not a scheduler. Claim is persisted before the
  // manual entry point runs; reopening/reloading a page never starts it twice.
  function createController({storage, tabs, getURL, isBusy, reportRun,
    canCloseRunner = async () => false, scheduleCleanup = async () => {}, onCleaned = async () => {},
    now = () => new Date().toISOString()}) {
    let tail = Promise.resolve();
    const serial = fn => {
      const result = tail.then(fn);
      tail = result.catch(() => null);
      return result;
    };
    const read = async () => (await storage.get(STORAGE_KEY))[STORAGE_KEY] || {};
    const write = async entries => {
      const keep = Object.values(entries).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      // A bounded history must not discard an unfinished cleanup obligation.
      const retained = keep.filter(item => item.cleanupPending || !terminal.has(item.status));
      const history = keep.filter(item => !item.cleanupPending && terminal.has(item.status));
      await storage.set({[STORAGE_KEY]: Object.fromEntries(
        [...retained, ...history.slice(0, Math.max(0, 1000 - retained.length))].map(item => [item.id, item]))});
    };
    const report = async (entry, status, message, error = null) => reportRun({
      id: entry.id, taskType: 'capture', featureKey: 'capture.search',
      title: entry.title, platform: entry.plan.platform, source: 'sidebar', trigger: 'remote_manual',
      status, createdAt: entry.createdAt, updatedAt: now(),
      ...(terminal.has(status) ? {finishedAt: now()} : {}),
      message, error,
      metadata: {executionMode: 'manual_batch', cloudCommandId: entry.commandId, remoteManual: true},
    });
    const matchesRunnerUrl = (entry, value) => {
      try {
        const url = new URL(value || '');
        const expected = new URL(getURL('sidebar/sidebar.html'));
        return url.protocol === expected.protocol && url.host === expected.host &&
          url.pathname === expected.pathname && url.searchParams.get(QUERY_KEY) === entry.id &&
          !url.searchParams.has('targetedPostRun') && !url.searchParams.has('unattendedRun');
      } catch { return false; }
    };
    const senderMatches = (entry, sender) => matchesRunnerUrl(entry, sender?.url) &&
      sender?.tab?.id === entry.runnerTabId;
    const sameOwner = (left, right) => left?.id === right?.id &&
      left?.commandId === right?.commandId && left?.runnerTabId === right?.runnerTabId &&
      String(left?.claimedDocumentId || '') === String(right?.claimedDocumentId || '') &&
      String(left?.cleanupDocumentId || '') === String(right?.cleanupDocumentId || '');
    const missingTab = error => /^(?:missing|No tab with id(?::\s*\d+)?\.?)$/iu.test(String(error?.message || error || ''));
    const cleanupReady = entry => entry?.closureProof?.producerStopped === true &&
      entry.closureProof.flushConfirmed === true &&
      Number.isSafeInteger(entry.closureProof.pendingUploads) && entry.closureProof.pendingUploads === 0;
    const reconcile = async () => {
      let closedCount = 0;
      const pending = Object.values(await read()).filter(entry => entry.cleanupPending === true);
      for (const snapshot of pending) {
        let entries = await read();
        let entry = entries[snapshot.id];
        if (!sameOwner(entry, snapshot) || !entry.cleanupPending || !terminal.has(entry.status)) continue;
        const settle = async reason => {
          entries = await read();
          const latest = entries[snapshot.id];
          if (!sameOwner(latest, snapshot) || !latest.cleanupPending) return;
          entries[snapshot.id] = {...latest, cleanupPending: false, cleanupCompletedAt: now(), cleanupReason: reason};
          await write(entries);
        };
        try {
          let tab;
          try { tab = await tabs.get(entry.runnerTabId); }
          catch (error) { if (!missingTab(error)) throw error; await settle('runner_already_closed'); continue; }
          if (!matchesRunnerUrl(entry, tab.url) || (tab.pendingUrl && !matchesRunnerUrl(entry, tab.pendingUrl))) {
            await settle('runner_identity_changed');
            continue;
          }
          // Neither a delivery receipt nor a sidebar's zero count is enough:
          // background verifies the durable ledger and live task resources.
          if (!cleanupReady(entry) || await canCloseRunner(entry, tab) !== true) continue;
          await Promise.resolve().then(() => onCleaned(entry, tab)).catch(() => {});
          entries = await read();
          entry = entries[snapshot.id];
          if (!sameOwner(entry, snapshot) || !entry.cleanupPending || !cleanupReady(entry)) continue;
          tab = await tabs.get(entry.runnerTabId);
          if (!matchesRunnerUrl(entry, tab.url) || (tab.pendingUrl && !matchesRunnerUrl(entry, tab.pendingUrl))) {
            await settle('runner_identity_changed');
            continue;
          }
          // Home restoration can await browser work. Recheck the document, lock
          // and relay after it; a same-URL reload is a different runner owner.
          if (await canCloseRunner(entry, tab) !== true) continue;
          await tabs.remove(entry.runnerTabId);
          // A resolved remove call is not a verified disappearance.
          try { await tabs.get(entry.runnerTabId); throw new Error('manual runner remains open'); }
          catch (error) { if (!missingTab(error)) throw error; }
          await settle('runner_closed');
          closedCount += 1;
        } catch (error) {
          entries = await read();
          entry = entries[snapshot.id];
          if (sameOwner(entry, snapshot) && entry.cleanupPending) {
            entries[snapshot.id] = {...entry, cleanupLastError: String(error?.message || error).slice(0, 500)};
            await write(entries);
          }
        }
      }
      const pendingCount = Object.values(await read()).filter(entry => entry.cleanupPending === true).length;
      if (pendingCount > 0) await Promise.resolve().then(() => scheduleCleanup()).catch(() => {});
      return {ok: pendingCount === 0, closedCount, pendingCount};
    };
    return {
      dispatch: command => serial(async () => {
        await reconcile();
        const payload = command.payload || {};
        const id = String(payload.clientTaskId || command.client_task_id || '');
        const plan = payload.planSnapshot || {};
        if (!/^[0-9a-f-]{36}$/i.test(id) || !['xiaohongshu', 'douyin'].includes(plan.platform) ||
            !Array.isArray(plan.keywords) || !plan.keywords.length || plan.keywords.length > 30) {
          return {accepted: false, reason: 'invalid_manual_batch', message: '手动批量采集参数无效'};
        }
        const entries = await read();
        const existing = entries[id];
        if (existing) {
          if (existing.commandId !== command.id) return {accepted: false, reason: 'manual_batch_identity_conflict'};
          if (existing.delivered !== true && !terminal.has(existing.status)) {
            existing.status = 'needs_action';
            await write(entries);
            await report(existing, 'needs_action', '手动采集下发过程已中断，请核对本地执行页',
              {code: 'MANUAL_BATCH_DELIVERY_INTERRUPTED', message: '未确认执行页是否打开，未自动重启'});
          }
          // Delivery already happened. In particular, a claimed page that was
          // closed or discarded is never silently recreated by command retry.
          return {accepted: existing.delivered === true, requestId: id, reason: existing.status};
        }
        // A browser restart may not emit onRemoved. Account for a missing page
        // when a new delivery arrives; retain its failure and never replay it.
        for (const prior of Object.values(entries)) {
          if (terminal.has(prior.status)) continue;
          let page = null;
          if (prior.runnerTabId) {
            try { page = await tabs.get(prior.runnerTabId); } catch { /* closed */ }
          }
          if (!page || !String(page.url || '').includes(`${QUERY_KEY}=${prior.id}`)) {
            prior.status = 'needs_action';
            await write(entries);
            await report(prior, 'needs_action', '手动采集执行页已退出，请核对已有结果',
              {code: 'MANUAL_BATCH_PAGE_CLOSED', message: '执行页已退出，未自动重启'});
          }
        }
        if (await isBusy() || Object.values(entries).some(entry => !terminal.has(entry.status))) {
          return {deferred: true, reason: 'manual_batch_busy'};
        }
        const entry = {id, commandId: command.id, title: payload.title || '手动批量关键词采集',
          plan, status: 'pending', createdAt: now(), delivered: false, runnerTabId: null};
        entries[id] = entry;
        await write(entries);
        try {
          await report(entry, 'pending', 'Extension 已收到完整手动批量配置');
          const url = new URL(getURL('sidebar/sidebar.html'));
          url.searchParams.set(QUERY_KEY, id);
          const tab = await tabs.create({url: url.href, active: true});
          entry.runnerTabId = tab.id;
          entry.delivered = true;
          await write(entries);
          return {accepted: true, requestId: id, reason: 'manual_batch_delivered'};
        } catch (error) {
          entry.status = 'failed';
          await write(entries);
          await report(entry, 'failed', '手动采集页面未能启动', {code: 'MANUAL_BATCH_DELIVERY_FAILED', message: String(error.message)});
          return {accepted: false, requestId: id, reason: 'manual_batch_delivery_failed'};
        }
      }),
      claim: (id, sender) => serial(async () => {
        const entries = await read();
        const entry = entries[id];
        if (!entry || !senderMatches(entry, sender)) return {ok: false, reason: 'manual_batch_not_found'};
        if (entry.status !== 'pending') {
          if (entry.status === 'claimed' && entry.claimedDocumentId && sender.documentId && entry.claimedDocumentId !== sender.documentId) {
            entry.status = 'needs_action';
            await write(entries);
            await report(entry, 'needs_action', '手动采集页面已刷新，请核对已有结果后手动启动',
              {code: 'MANUAL_BATCH_PAGE_RELOADED', message: '执行页已刷新，未自动重启'});
          }
          return {ok: false, reason: 'manual_batch_already_claimed'};
        }
        if (await isBusy()) {
          entry.status = 'needs_action';
          await write(entries);
          await report(entry, 'needs_action', '本地已有采集任务，请在 Extension 核对后手动启动');
          return {ok: false, reason: 'capture_lock_busy'};
        }
        entry.status = 'claimed';
        entry.claimedDocumentId = String(sender.documentId || '');
        await write(entries);
        return {ok: true, data: entry};
      }),
      finish: (id, sender, evidence = {}) => serial(async () => {
        const entries = await read();
        const entry = entries[id];
        if (!entry || !senderMatches(entry, sender) ||
            !entry.claimedDocumentId || entry.claimedDocumentId !== sender.documentId) return {ok: false};
        // Record only delivery retirement. Never rewrite the pipeline's ledger,
        // result, error or synchronization outcome while reclaiming its shell.
        const reportedStatus = evidence.status === 'partial' ? 'completed_with_failures' : evidence.status;
        entry.status = terminal.has(reportedStatus) ? reportedStatus
          : terminal.has(entry.status) ? entry.status : 'needs_action';
        const sourceTabId = Number(evidence.sourceTabId);
        if (Number.isSafeInteger(sourceTabId) && sourceTabId > 0) entry.sourceTabId = sourceTabId;
        entry.finishedAt = now();
        entry.cleanupDocumentId = entry.claimedDocumentId;
        entry.cleanupPending = true;
        entry.closureProof = {
          producerStopped: evidence.closureProof?.producerStopped === true,
          flushConfirmed: evidence.closureProof?.flushConfirmed === true,
          pendingUploads: Number.isSafeInteger(evidence.closureProof?.pendingUploads) &&
              evidence.closureProof.pendingUploads >= 0 ? evidence.closureProof.pendingUploads : null,
        };
        await write(entries);
        const cleanup = await reconcile();
        return {ok: true, cleanup};
      }),
      requestCleanup: (id, sender, {reason = ''} = {}) => serial(async () => {
        const entries = await read();
        const entry = entries[id];
        if (!entry || !senderMatches(entry, sender) || !terminal.has(entry.status)) {
          return {ok: false, reason: 'manual_runner_not_retired'};
        }
        // A rejected, never-claimed document produced no capture data. A
        // refreshed claimed runner cannot make that claim for its old document.
        if (!entry.claimedDocumentId) {
          if (!sender.documentId) return {ok: false, reason: 'manual_runner_document_unknown'};
          entry.closureProof = {producerStopped: true, flushConfirmed: true, pendingUploads: 0};
          entry.cleanupDocumentId = String(sender.documentId);
        }
        entry.cleanupPending = true;
        entry.cleanupRequestedReason = String(reason).slice(0, 160);
        await write(entries);
        return {ok: true, cleanup: await reconcile()};
      }),
      reconcileCleanup: () => serial(reconcile),
      removed: tabId => serial(async () => {
        const entries = await read();
        for (const entry of Object.values(entries)) {
          if (entry.runnerTabId !== tabId || terminal.has(entry.status)) continue;
          entry.status = 'needs_action';
          await write(entries);
          await report(entry, 'needs_action', '手动采集页面已关闭，请在 Extension 核对已有结果',
            {code: 'MANUAL_BATCH_PAGE_CLOSED', message: '执行页已关闭，未自动重启'});
        }
      }),
    };
  }
  root.OnStarvoiceManualKeywordDispatch = {createController, STORAGE_KEY, QUERY_KEY};
})(globalThis);
