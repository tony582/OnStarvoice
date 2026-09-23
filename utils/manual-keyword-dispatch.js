(function (root) {
  'use strict';
  const STORAGE_KEY = 'onstarvoice.manualKeywordDispatch.v1';
  const QUERY_KEY = 'manualKeywordBatch';
  const terminal = new Set(['completed', 'completed_with_failures', 'failed', 'canceled', 'needs_action']);

  // This is a delivery receipt, not a scheduler. Claim is persisted before the
  // manual entry point runs; reopening/reloading a page never starts it twice.
  function createController({storage, tabs, getURL, isBusy, reportRun, now = () => new Date().toISOString()}) {
    let tail = Promise.resolve();
    const serial = fn => {
      const result = tail.then(fn);
      tail = result.catch(() => null);
      return result;
    };
    const read = async () => (await storage.get(STORAGE_KEY))[STORAGE_KEY] || {};
    const write = async entries => {
      const keep = Object.values(entries).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      await storage.set({[STORAGE_KEY]: Object.fromEntries(keep.slice(0, 1000).map(item => [item.id, item]))});
    };
    const report = async (entry, status, message, error = null) => reportRun({
      id: entry.id, taskType: 'capture', featureKey: 'capture.search',
      title: entry.title, platform: entry.plan.platform, source: 'sidebar', trigger: 'remote_manual',
      status, createdAt: entry.createdAt, updatedAt: now(),
      ...(terminal.has(status) ? {finishedAt: now()} : {}),
      message, error,
      metadata: {executionMode: 'manual_batch', cloudCommandId: entry.commandId, remoteManual: true},
    });
    const senderMatches = (entry, sender) => {
      try {
        const url = new URL(sender?.url || '');
        return url.protocol === 'chrome-extension:' && url.host === new URL(getURL('sidebar/sidebar.html')).host &&
          url.pathname === '/sidebar/sidebar.html' && url.searchParams.get(QUERY_KEY) === entry.id &&
          sender?.tab?.id === entry.runnerTabId;
      } catch { return false; }
    };
    return {
      dispatch: command => serial(async () => {
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
      finish: (id, sender) => serial(async () => {
        const entries = await read();
        const entry = entries[id];
        if (!entry || !senderMatches(entry, sender)) return {ok: false};
        // The normal manual pipeline owns the actual terminal ledger status.
        entry.status = 'completed';
        await write(entries);
        return {ok: true};
      }),
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
