// A per-post business outcome, separate from extraction failures and saved detail.
export function normalizeDetailAvailability(value, {externalId, platform = 'xiaohongshu', now = Date.now()} = {}) {
  if (!value || platform !== 'xiaohongshu' || value.platform !== platform ||
      value.externalId !== externalId || !externalId ||
      value.code !== 'TARGET_POST_UNAVAILABLE' ||
      !['deleted', 'page_unavailable'].includes(value.status)) return null;
  const observedAt = Date.parse(value.observedAt);
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter(signal => /^xhs_(?:deleted_copy|page_gone_countdown|unavailable_qr_layout|page_not_available|unavailable_error_copy|unavailable_toast)$/.test(signal))
    : [];
  if (!Number.isFinite(observedAt) || observedAt <= 0 || observedAt > now + 300000 || !evidence.length ||
      (value.status === 'deleted' && !evidence.some(signal => ['xhs_deleted_copy', 'xhs_page_gone_countdown'].includes(signal))) ||
      (value.status === 'page_unavailable' && now - observedAt > 86400000)) return null;
  return {platform, externalId, status: value.status, observedAt: new Date(observedAt).toISOString(),
    code: 'TARGET_POST_UNAVAILABLE', evidence: [...new Set(evidence)].slice(0, 8)};
}

export function unavailableDetailPayload(payload, availability) {
  return {...payload, detailCaptureStatus: 'unavailable', detailAvailability: availability,
    detailAlreadyCaptured: false, detailCaptureError: '', detailCaptureFailureCode: '',
    detailCaptureFailureCategory: '', detailCaptureFailureStage: '',
    detailCaptureDiagnosticMessage: '', detailCaptureAutoRetryCount: 0,
    detailCaptureFinishedAt: Date.parse(availability.observedAt)};
}

export function unavailableDetailResult(recordId, availability) {
  return {recordId, ok: true, skipped: true, unavailable: true, retryable: false,
    reason: 'post_unavailable', businessOutcome: 'post_unavailable', availability,
    message: '平台提示帖子已不可查看，已保留列表数据并跳过增强'};
}

// This function is serialized into the worker page. Keep it self-contained.
export function readDetailAvailabilitySnapshot() {
  const bodyText = String(document.body?.innerText || '');
  const notices = [];
  let unavailableDialog = false;
  for (const node of document.querySelectorAll('div,span,p,[role="alert"],[role="status"]')) {
    const copy = node.textContent?.trim() || '';
    const unavailableCopy = /^(该内容暂时无法查看|当前笔记暂时无法浏览)[。！]?$/.test(copy);
    if (node.children.length || !(unavailableCopy || /^Sorry,\s*This Page Isn['’]t Available Right Now\.?$/i.test(copy))) continue;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) continue;
    for (let parent = node, depth = 0; parent && depth < 8; parent = parent.parentElement, depth++) {
      const style = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') break;
      const dialogText = parent.innerText || '';
      if ((style.position === 'fixed' || parent.getAttribute('role') === 'dialog') &&
          /请打开小红书\s*App\s*扫码查看/i.test(dialogText) && /问题反馈/.test(dialogText) && /返回首页|关闭/.test(dialogText)) {
        unavailableDialog = true;
      }
      if ((style.position === 'fixed' || ['alert', 'status'].includes(parent.getAttribute('role'))) &&
          box.width > 0 && box.width < 700 && box.height > 0 && box.height < 220 && unavailableCopy) {
        notices.push(copy);
      }
    }
  }
  return {url: location.href, title: document.title, notices: notices.slice(0, 4), unavailableDialog,
    bodyText: bodyText.length <= 20000 ? bodyText : `${bodyText.slice(0, 10000)}\n${bodyText.slice(-10000)}`};
}

export function classifyDetailAvailabilitySnapshot(snapshot, {targetUrl, classifySnapshot, now = Date.now()}) {
  if (!snapshot || typeof classifySnapshot !== 'function') return null;
  let externalId;
  let errorRoute = false;
  try {
    const target = new URL(targetUrl);
    const actual = new URL(snapshot.url);
    const isXhs = url => /(^|\.)xiaohongshu\.com$/.test(url.hostname);
    const noteId = url => url.pathname.match(/\/(?:explore|discovery\/item)\/([^/?]+)/)?.[1] || '';
    externalId = noteId(target);
    if (!externalId || !isXhs(target) || !isXhs(actual)) return null;
    const redirectPath = actual.searchParams.get('redirectPath');
    const actualId = noteId(actual) || (redirectPath ? noteId(new URL(redirectPath, actual.origin)) : '');
    if (actualId ? actualId !== externalId : !['/', '/explore', '/explore/', '/404', '/404/'].includes(actual.pathname)) return null;
    errorRoute = /^\/404\/?$/.test(actual.pathname);
  } catch { return null; }
  // A login/challenge/network screen is never a per-post business outcome.
  if (/安全验证|滑动验证|完成验证|访问过于频繁|访问频繁|扫码登录|登录后查看|网络异常|网络连接失败|网络开小差/.test(`${snapshot.title} ${snapshot.bodyText}`)) return null;
  const page = classifySnapshot({...snapshot, platform: 'xiaohongshu', url: targetUrl});
  const toast = snapshot.notices?.some(value => /^(该内容暂时无法查看|当前笔记暂时无法浏览)[。！]?$/.test(value));
  if (page?.evidence?.includes('xhs_unavailable_qr_layout') &&
      !errorRoute && !snapshot.unavailableDialog && !toast) return null;
  if (!page?.unavailable && !toast) return null;
  const evidence = page?.evidence || ['xhs_unavailable_toast'];
  // A Web-only QR restriction does not prove that the author deleted the post.
  const status = evidence.some(signal => ['xhs_deleted_copy', 'xhs_page_gone_countdown'].includes(signal))
    ? 'deleted' : 'page_unavailable';
  return normalizeDetailAvailability({platform: 'xiaohongshu', externalId, status,
    code: 'TARGET_POST_UNAVAILABLE', evidence, observedAt: new Date(now).toISOString()}, {externalId, now});
}
