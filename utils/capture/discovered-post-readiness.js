const STAGE = 'initial_detail_readiness';

function readinessError(code, message) {
  return Object.assign(new Error(message), {code, stage: STAGE});
}

// Read only: no activation, navigation, reload, or capture side effects. Chrome's
// documentId fences the safety sample against a same-URL document replacement.
export async function readDiscoveredPostDocument(tabId, chromeApi = globalThis.chrome) {
  const results = await chromeApi.scripting.executeScript({
    target: {tabId, frameIds: [0]},
    func: () => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0;
      };
      // A normal header login button is not a blocking login requirement.
      const loginDialog = [...document.querySelectorAll(
        '[role="dialog"], dialog, [class*="login-modal"], [class*="login-panel"]',
      )].some((element) => visible(element) &&
        /登录后(?:查看|继续|观看)|扫码登录|登录即可(?:查看|观看)/u.test(
          String(element.innerText || ''),
        ));
      return {
        url: location.href,
        readyState: document.readyState,
        loginRequired: loginDialog || /^\/(?:login|passport\/login)(?:\/|$)/iu.test(location.pathname),
      };
    },
  });
  const execution = results?.find((entry) => entry.frameId === 0);
  return {...execution?.result, documentId: String(execution?.documentId || '')};
}

export async function waitForDiscoveredPostTab({
  tabId,
  target,
  platform,
  shouldStop = () => false,
  readTab,
  readDocument,
  probeSafety,
  canonicalizeTargetUrl,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 60_000,
  observationTimeoutMs = 2_000,
  pollMs = 300,
} = {}) {
  const budget = Math.min(60_000, Math.max(1, Number(timeoutMs) || 60_000));
  const sampleBudget = Math.min(2_000, Math.max(1, Number(observationTimeoutMs) || 2_000));
  const deadline = now() + budget;
  let verifiedDocumentId = '';
  const expected = canonicalizeTargetUrl(target?.url, platform, target?.externalId);
  const matches = (url) => {
    try {
      return canonicalizeTargetUrl(url, platform, expected.externalId).externalId === expected.externalId;
    } catch {
      return false;
    }
  };
  const samePlatform = (url) => {
    try {
      const parsed = new URL(url);
      const base = platform === 'douyin' ? 'douyin.com' : platform === 'xiaohongshu' ? 'xiaohongshu.com' : '';
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
        (!parsed.port || parsed.port === '443') && base &&
        (parsed.hostname === base || parsed.hostname.endsWith(`.${base}`));
    } catch { return false; }
  };
  const isOpeningPlaceholder = (url) => !url || /^about:blank(?:#onstarvoice-targeted-post=.*)?$/u.test(url);
  const checkCanceled = () => {
    if (shouldStop()) throw readinessError('TARGET_CAPTURE_CANCELED', '定向作品任务已停止');
  };
  const changed = () => readinessError('TARGET_IDENTITY_MISMATCH', '定向作品采集页已离开目标作品');
  const documentChanged = () => Object.assign(
    readinessError('TARGET_RUNNER_DOCUMENT_CHANGED', '定向作品采集页文档已更换，已停止本次采集并保留页面'),
    {requiresManualAction: true, category: 'document_identity_changed', retryable: false},
  );

  // A hung Chrome message must not hold the run forever. Late results are read
  // only and cannot start another probe after this observation has expired.
  const bounded = (operation, expiresAt) => new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      callback(value);
    };
    const tick = () => {
      try {
        checkCanceled();
        if (now() >= expiresAt) {
          throw readinessError('TARGET_READINESS_OBSERVATION_TIMEOUT', '作品页就绪检查未及时响应');
        }
      } catch (error) {
        finish(reject, error);
        return;
      }
      timer = setTimeout(tick, Math.min(100, expiresAt - now()));
    };
    tick();
    if (finished) return;
    Promise.resolve().then(operation).then(
      (value) => {
        try {
          checkCanceled();
          if (now() >= expiresAt) throw readinessError('TARGET_READINESS_OBSERVATION_TIMEOUT', '作品页就绪检查未及时响应');
        } catch (error) { finish(reject, error); return; }
        finish(resolve, value);
      },
      (error) => finish(reject, error),
    );
  });
  const getTab = async (expiresAt) => {
    try {
      const tab = await bounded(() => readTab(tabId), expiresAt);
      if (!tab || tab.id !== tabId) throw new Error('标签页不存在');
      return tab;
    } catch (error) {
      if (error?.stage === STAGE) throw error;
      throw readinessError('TARGET_RUNNER_TAB_CLOSED', error?.message || '定向作品采集页已关闭');
    }
  };
  const observe = async (expiresAt) => {
    const tab = await getTab(expiresAt);
    if (isOpeningPlaceholder(tab.url)) {
      if (verifiedDocumentId || (tab.pendingUrl && !matches(tab.pendingUrl))) throw changed();
      return null;
    }
    if (!samePlatform(tab.url)) throw changed();
    // The current DOM still belongs to the old document while even a same-URL
    // navigation is pending. Observe the committed document on a later pass.
    if (tab.pendingUrl && matches(tab.pendingUrl)) return null;
    const before = await bounded(() => readDocument(tabId), expiresAt);
    if (!before?.documentId) return null;
    if (!samePlatform(before.url)) throw changed();
    if (verifiedDocumentId && before.documentId !== verifiedDocumentId) throw documentChanged();
    if (before.loginRequired === true) {
      const confirmed = await bounded(() => readDocument(tabId), expiresAt);
      if (before.documentId === confirmed?.documentId && before.url === confirmed.url && confirmed.loginRequired === true) {
        throw Object.assign(readinessError('LOGIN_REQUIRED', '目标平台要求登录后继续，已暂停采集'), {
          requiresManualAction: true,
          retryable: false,
        });
      }
      return null;
    }
    // Probe even a redirected route: the existing probe must be able to report
    // CAPTCHA / rate limiting before an ordinary identity failure is emitted.
    let safety;
    let safetyError;
    try {
      safety = await bounded(() => probeSafety(tabId, {
        targetUrl: expected.url,
        waitForDouyinReady: false,
        shouldStop,
      }), expiresAt);
    } catch (error) {
      if (error?.code === 'TARGET_CAPTURE_CANCELED' ||
          error?.code === 'TARGET_READINESS_OBSERVATION_TIMEOUT' ||
          error?.message === 'DETAIL_CAPTURE_CANCELED') throw error;
      safetyError = error;
    }
    const liveTab = await getTab(expiresAt);
    const after = await bounded(() => readDocument(tabId), expiresAt);
    if (before.documentId !== after?.documentId) {
      if (verifiedDocumentId) throw documentChanged();
      return null; // The initial navigation may still be committing.
    }
    if (!samePlatform(after.url) || !samePlatform(liveTab.url)) throw changed();
    if (liveTab.pendingUrl) {
      if (!matches(liveTab.pendingUrl)) throw changed();
      return null;
    }
    // The safety probe throws directly; its error needs the same post-probe
    // document fence as a successful sample before it may preserve a page.
    if (safetyError) throw safetyError;
    if (before.loginRequired === true || after.loginRequired === true) {
      throw Object.assign(readinessError('LOGIN_REQUIRED', '目标平台要求登录后继续，已暂停采集'), {
        requiresManualAction: true,
        retryable: false,
      });
    }
    if (!matches(before.url) || !matches(after.url) || !matches(liveTab.url)) throw changed();
    if (!safety || safety.skipped || !matches(safety.currentUrl)) return null;
    if (safety.activeWorkIdentityConflict === true) throw changed();
    verifiedDocumentId = before.documentId;
    // `complete` retains the old navigation contract; the normal detail capture
    // still adjudicates unavailable content and validates ingestion. A proven
    // exact-target DOM/API lets it start without waiting for unrelated assets.
    if (liveTab.status === 'complete' ||
        (safety.targetMatched === true && safety.detailReady === true && !safety.unavailable)) {
      return liveTab;
    }
    return null;
  };
  const sample = async (expiresAt) => {
    try {
      return await observe(expiresAt);
    } catch (error) {
      if (error?.code === 'TARGET_READINESS_OBSERVATION_TIMEOUT') return null;
      if (String(error?.message || '') === 'DETAIL_CAPTURE_CANCELED') {
        throw readinessError('TARGET_CAPTURE_CANCELED', '定向作品任务已停止');
      }
      // An injection can lose its execution context during the initial commit.
      // A fresh tab read distinguishes that from a closed page. Once a target
      // document was verified we never silently authorize its replacement.
      if (!error?.code && error?.stage !== STAGE) {
        try { await getTab(expiresAt); } catch (tabError) {
          if (tabError?.code !== 'TARGET_READINESS_OBSERVATION_TIMEOUT') throw tabError;
        }
        return null;
      }
      throw Object.assign(error, {stage: STAGE});
    }
  };
  while (now() < deadline) {
    checkCanceled();
    const ready = await sample(Math.min(deadline, now() + sampleBudget));
    if (ready) return ready;
    if (now() < deadline) await wait(Math.min(pollMs, deadline - now()));
  }
  // Timers can resume after the deadline while the page is already ready. Do
  // exactly one fresh, bounded observation rather than failing on elapsed time.
  checkCanceled();
  const last = await sample(now() + sampleBudget);
  if (last) return last;
  throw readinessError('TARGET_RUNNER_TAB_TIMEOUT', '定向作品采集页打开超时');
}
