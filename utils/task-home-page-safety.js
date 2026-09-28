(function (root) {
  'use strict';

  // Serialized by chrome.scripting.executeScript: every dependency must live
  // inside this function or be a browser global. This never reads capture data
  // or changes a page; only a boolean leaves the document.
  function readDocument() {
    let url = '';
    try {
      url = String(location.href || '');
      const page = new URL(url);
      if (page.protocol !== 'https:' ||
          !/(^|\.)(douyin\.com|xiaohongshu\.com|weibo\.com)$/iu.test(page.hostname) ||
          !document.documentElement || !document.body ||
          !['interactive', 'complete'].includes(document.readyState)) {
        return {url, safeForCleanup: false};
      }
      const blocked = () => ({url, safeForCleanup: false});
      const compact = value => String(value || '').replace(/\s+/gu, '');
      const visible = node => {
        if (node.isConnected === false) return false;
        const rect = node.getBoundingClientRect();
        if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) throw new Error('Unknown node geometry');
        if (rect.width <= 0 || rect.height <= 0) return false;
        for (let current = node; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (!style) throw new Error('Unknown node visibility');
          if (current.hidden || String(current.getAttribute('aria-hidden') || '').toLowerCase() === 'true' ||
              style.display === 'none' || style.visibility === 'hidden' ||
              Number(style.opacity || 1) <= 0.01) return false;
        }
        return true;
      };
      const cards = '.search-result-card, [id^="waterfall_item_"], [data-e2e-aweme-id], ' +
        '[data-aweme-id], [data-awemeid], .note-item, [data-testid="feed-card"]';
      const outsidePosts = node => !node.closest(cards) && !node.querySelector(cards);
      const title = String(document.title || '').trim();
      if (/^\/(?:login|passport\/login)(?:\/|$)/iu.test(page.pathname) ||
          /^(?:验证码中间页|抖音验证码中间页)$/u.test(compact(title))) return blocked();

      // Match blocking login surfaces, not a normal header's login button.
      const dialogs = '[role="dialog"], [role="alertdialog"], dialog, ' +
        '[class*="login-modal" i], [class*="login-panel" i], [class*="login-container" i]';
      for (const node of document.querySelectorAll(dialogs)) {
        if (visible(node) && outsidePosts(node) &&
            /登录后(?:查看|继续|观看)|扫码登录|登录即可(?:查看|观看)/u.test(String(node.innerText || ''))) return blocked();
      }
      const protectionSurfaces = dialogs + ', [id*="captcha" i], [id*="verify" i], ' +
        '[class*="captcha" i], [class*="verify" i], [class*="challenge" i], ' +
        '[class*="security" i], [data-e2e*="captcha" i], [data-testid*="captcha" i]';
      const candidates = [...document.querySelectorAll(protectionSurfaces)];
      for (const canvas of document.querySelectorAll('canvas')) {
        const parent = canvas.closest('[role="dialog"], dialog, section, aside, div');
        if (parent && !candidates.includes(parent)) candidates.push(parent);
      }
      for (const node of candidates) {
        if (!visible(node) || !outsidePosts(node)) continue;
        const identity = ['id', 'class', 'data-e2e', 'data-testid'].map(key => node.getAttribute(key) || '').join(' ');
        if (/captcha|challenge/iu.test(identity)) return blocked();
        const copy = compact(node.innerText || node.textContent || '');
        if (/请完成下列验证后继续[:：]?/u.test(copy) ||
            (/请选择所有符合(?:上文|上述|下列)?描述的图片/u.test(copy) && /(?:并)?拖拽到(?:下方|这里)/u.test(copy))) return blocked();
      }
      for (const frame of document.querySelectorAll('iframe')) {
        if (!visible(frame) || !outsidePosts(frame)) continue;
        const identity = ['src', 'title', 'name', 'id', 'class'].map(key => frame.getAttribute(key) || '').join(' ');
        if (/captcha|verify|verification|challenge/iu.test(identity)) return blocked();
      }

      if (/(^|\.)xiaohongshu\.com$/iu.test(page.hostname)) {
        // Exact combinations from capture/xiaohongshu-security.js. A feed card
        // quoting these words must never turn its whole page into a safety gate.
        if (!document.body.querySelector(cards)) candidates.push(document.body);
        for (const node of candidates) {
          if (!visible(node) || !outsidePosts(node)) continue;
          const copy = `${title} ${node.innerText || node.textContent || ''}`
            .replace(/[\u2010-\u2015]/gu, '-').replace(/[\u2018\u2019\u201c\u201d\u300c\u300d\u300e\u300f"']/gu, '')
            .replace(/\s+/gu, ' ').trim().toLowerCase();
          if ((copy.includes('安全限制') && copy.includes('访问频繁') && copy.includes('稍后再试') &&
               (copy.includes('300013') || (copy.includes('我要反馈') && copy.includes('返回首页')))) ||
              (copy.includes('scan with logged-in rednote app') && copy.includes('for account security')) ||
              (copy.includes('requests too frequent') && copy.includes('try again after 1 minute'))) return blocked();
        }
      }
      return {url, safeForCleanup: true};
    } catch {
      return {url, safeForCleanup: false};
    }
  }

  root.OnStarvoiceTaskHomePageSafety = Object.freeze({readDocument});
})(globalThis);
