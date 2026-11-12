import {spawn} from 'node:child_process';
import {accessSync, constants, mkdirSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {readArticleDocument} from './article-dom.mjs';
import {canonicalArticleUrl} from '../core/wechat-article-evidence.mjs';
import {resolvePreviewChrome, SYSTEM_CHROME} from './chrome-cache.mjs';
import {visitLocalPreviewPage} from './local-selfcheck.mjs';

// A copied WeChat Channels share link opens WeChat's public preview page in an ordinary browser. That page
// requests its own post data (feed/get_feed_info); this resolver opens the link in a headless Chrome on this
// computer and reads that response, exactly what the page shows: caption, publish time, author and counts.
// It never sends requests of its own to WeChat and never logs in. One Chrome process, a few tabs at a time.
export const SHARE_LINK = /^https:\/\/weixin\.qq\.com\/sph\/[A-Za-z0-9_-]{4,40}$/u;
export const DEFAULT_CHROME = SYSTEM_CHROME;
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const FEED_API = /^https:\/\/channels\.weixin\.qq\.com\/finder-preview\/api\/feed\/get_feed_info(?:\?|$)/u;

export class PreviewError extends Error {
  constructor(code, message = code) { super(message); this.name = 'PreviewError'; this.code = code; }
}

export function chromeAvailable(path = resolvePreviewChrome().path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
/** The page's own answer → the bounded fields a post needs; anything malformed is refused. */
export function readFeedInfo(body) {
  let json;
  try { json = JSON.parse(body); } catch { throw new PreviewError('preview_invalid'); }
  const data = json?.data;
  if (json?.errCode !== 0 || !data || typeof data !== 'object') throw new PreviewError('preview_refused');
  if (data.errMsg && data.errMsg.type !== 0) return {unavailable: true, reason: text(data.errMsg.msg ?? data.errMsg.title ?? '', 120)};
  const feed = data.feedInfo ?? {}, author = data.authorInfo ?? {};
  const createtime = Number(feed.createtime);
  if (typeof feed.description !== 'string' || !Number.isSafeInteger(createtime) || createtime < 1_262_304_000
    || createtime > Date.now() / 1000 + 86_400 || !text(author.nickname, 200).trim()) throw new PreviewError('preview_incomplete');
  return {unavailable: false, description: text(feed.description, 20_000), createtime, nickname: text(author.nickname, 200),
    avatarUrl: text(author.headImgUrl, 1000), likeCountFmt: text(feed.likeCountFmt, 20), favCountFmt: text(feed.favCountFmt, 20),
    forwardCountFmt: text(feed.forwardCountFmt, 20), commentCountFmt: text(feed.commentCountFmt, 20),
    coverUrl: text(feed.coverUrl, 2000), isImage: Array.isArray(feed.picInfo) && feed.picInfo.length > 0,
    exportId: text(data.sceneInfo?.dynamicExportId, 200)};
}

export function createSharePreview({chromePath, chromeExplicit = false, profileDir, port = 9333, maxTabs = 2,
  browserOptions, onDiagnostic = () => {}, onWarning = browserOptions?.onWarning ?? console.error,
  selfcheckTimeoutMs = 10_000,
  timeoutMs = 15_000, spawnImpl = spawn, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket} = {}) {
  if (typeof profileDir !== 'string' || !profileDir) throw new PreviewError('preview_unavailable', 'A private Chrome profile directory is required');
  const requestedPath = chromePath;
  const selected = resolvePreviewChrome({...browserOptions, chromePath, chromeExplicit,
    ...(chromeExplicit ? {onWarning: () => {}} : {})});
  chromePath = selected.path;
  const checkRequired = selected.source === 'managed' || chromeExplicit;
  const explicitPathChanged = chromeExplicit && requestedPath && requestedPath !== selected.path;
  let chrome = null, socket = null, connecting = null, connectionAbort = null, seq = 0, active = 0, generation = 0;
  let preparation = null, checkAbort = null, closed = false, checkState = checkRequired ? 'pending' : 'ready', checkError = null;
  const waiting = new Map(), listeners = new Set(), queue = [], activeJobs = new Set(), ownedBrowsers = new Set();
  const abortError = signal => signal?.reason instanceof PreviewError ? signal.reason : new PreviewError('aborted');
  const reset = () => {
    generation++;
    const oldSocket = socket, oldChrome = chrome;
    socket = null; chrome = null; connecting = null;
    connectionAbort?.abort(new PreviewError('preview_unavailable')); connectionAbort = null;
    for (const [, entry] of waiting) { entry.cleanup(); entry.reject(new PreviewError('preview_unavailable')); }
    waiting.clear();
    for (const job of activeJobs) job.controller.abort(new PreviewError('preview_unavailable'));
    try { oldSocket?.close(); } catch { /* closed */ }
    try { if (oldChrome?.exitCode == null && oldChrome?.signalCode == null) oldChrome?.kill('SIGTERM'); } catch { /* gone */ }
  };
  const send = (method, params = {}, sessionId, signal, onLateResult) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    if (!socket) { reject(new PreviewError('preview_unavailable')); return; }
    const id = ++seq;
    const aborted = () => {
      if (onLateResult) entry.canceled = true;
      else waiting.delete(id);
      cleanup(); reject(abortError(signal));
    };
    const cleanup = () => signal?.removeEventListener('abort', aborted);
    const entry = {resolve, reject, cleanup, canceled: false, onLateResult};
    waiting.set(id, entry);
    signal?.addEventListener('abort', aborted, {once: true});
    try { socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})})); }
    catch (error) { waiting.delete(id); cleanup(); reject(error); }
  });
  const connect = () => connecting ??= (async () => {
    const epoch = generation;
    const controller = new AbortController(); connectionAbort = controller;
    if (!chromeAvailable(chromePath)) throw new PreviewError('preview_unavailable', 'Google Chrome is not installed');
    mkdirSync(profileDir, {recursive: true, mode: 0o700});
    chrome = spawnImpl(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profileDir}`, '--window-size=430,932', 'about:blank'], {stdio: 'ignore'});
    const process = chrome;
    ownedBrowsers.add(process);
    chrome.on('exit', () => { ownedBrowsers.delete(process); if (chrome === process) reset(); });
    chrome.on('error', () => {
      if (!process.pid) ownedBrowsers.delete(process); // Failed spawn: no OS process to wait for.
      if (chrome === process) reset();
    });
    let version = null;
    for (let i = 0; i < 40 && !version; i++) {
      if (epoch !== generation) throw new PreviewError('preview_unavailable');
      try { version = await whileActive(Promise.resolve(fetchImpl(`http://127.0.0.1:${port}/json/version`,
        {signal: controller.signal})).then(response => response.json()), controller.signal); } catch { await sleep(250); }
    }
    if (epoch !== generation) throw new PreviewError('preview_unavailable');
    if (!version?.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1')) { reset(); throw new PreviewError('preview_unavailable'); }
    socket = new WebSocketImpl(version.webSocketDebuggerUrl);
    const openedSocket = socket;
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, {once: true});
      socket.addEventListener('error', () => reject(new PreviewError('preview_unavailable')), {once: true});
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const entry = message.id ? waiting.get(message.id) : null;
      if (entry) {
        waiting.delete(message.id); entry.cleanup();
        if (entry.canceled) { if (!message.error) entry.onLateResult?.(message.result); }
        else message.error ? entry.reject(new PreviewError('preview_cdp_error')) : entry.resolve(message.result);
      }
      else for (const listener of listeners) listener(message);
    });
    socket.addEventListener('close', () => { if (socket === openedSocket) reset(); });
  })();
  const whileActive = (operation, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError(signal)); return; }
    const aborted = () => reject(abortError(signal));
    signal.addEventListener('abort', aborted, {once: true});
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
  const readArticle = async (link, sessionId, signal) => {
    let observed = null, repeatedReason = null, repeatedFailures = 0;
    while (!signal.aborted) {
      const expression = `(${readArticleDocument.toString()})(document,${JSON.stringify({expectedUrl: link, capturedAt: new Date().toISOString()})})`;
      const result = await send('Runtime.evaluate', {expression, returnByValue: true}, sessionId, signal);
      if (result.exceptionDetails) throw new PreviewError('article_preview_dom_error');
      const value = result.result?.value;
      if (value?.ok === true && value.article?.url === link && value.article?.source === 'page_dom') {
        repeatedReason = null; repeatedFailures = 0;
        const signature = JSON.stringify([value.article.title, value.article.account, value.article.publishedAt, value.article.bodyBlocks]);
        // The current DOM must have stopped changing; no private page state is used as a readiness shortcut.
        if (signature === observed) return value.article;
        observed = signature;
      } else {
        observed = null;
        if (!value?.retryable) throw new PreviewError(value?.reason || 'article_preview_incomplete');
        const reason = value.reason || 'article_preview_incomplete';
        repeatedFailures = value.readyState === 'complete' ? (reason === repeatedReason ? repeatedFailures + 1 : 1) : 0;
        repeatedReason = value.readyState === 'complete' ? reason : null;
        if (repeatedFailures >= 8) throw new PreviewError(reason);
      }
      await whileActive(sleep(250), signal);
    }
    throw abortError(signal);
  };
  const resolveOne = async (link, kind, signal) => {
    await whileActive(connect(), signal);
    // Creation may succeed after its caller has stopped. Keep that one CDP response handler until it
    // arrives (or this shared browser closes), so a late target is closed instead of becoming an orphan.
    const closeTarget = targetId => send('Target.closeTarget', {targetId}, undefined,
      kind === 'selfcheck' ? signal : AbortSignal.timeout(1000)).catch(() => {});
    const {targetId} = await send('Target.createTarget', {url: 'about:blank'}, undefined, signal,
      result => { if (result?.targetId) void closeTarget(result.targetId); });
    let listener = null;
    try {
      const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true}, undefined, signal);
      if (kind === 'article' || kind === 'selfcheck') {
        // Keep Chrome's normal desktop UA. The Channels-only mobile override never applies to article tabs.
        await send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false}, sessionId, signal);
        await send('Emulation.setLocaleOverride', {locale: 'zh-CN'}, sessionId, signal);
        await send('Emulation.setTimezoneOverride', {timezoneId: 'Asia/Shanghai'}, sessionId, signal);
        await send('Page.enable', {}, sessionId, signal);
        const loaded = new Promise(resolve => {
          listener = message => { if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') resolve(); };
          listeners.add(listener);
        });
        const navigation = await send('Page.navigate', {url: link}, sessionId, signal);
        if (navigation.errorText) throw new PreviewError('article_preview_navigation_failed');
        await whileActive(loaded, signal);
        if (kind === 'selfcheck') {
          const result = await send('Runtime.evaluate', {expression: '({url:location.href,readyState:document.readyState,text:document.body?.textContent})',
            returnByValue: true}, sessionId, signal);
          const value = result.result?.value;
          if (result.exceptionDetails || value?.url !== link || value?.readyState !== 'complete'
            || value?.text !== new URL(link).pathname.split('/').at(-1)) throw new PreviewError('preview_selfcheck_content_invalid');
          return;
        }
        return await readArticle(link, sessionId, signal);
      }
      await send('Network.enable', {}, sessionId, signal);
      await send('Emulation.setUserAgentOverride', {userAgent: MOBILE_UA}, sessionId, signal);
      const body = new Promise((resolve, reject) => {
        let requestId = null;
        listener = async message => {
          if (message.sessionId !== sessionId) return;
          if (message.method === 'Network.responseReceived' && FEED_API.test(message.params.response.url)) requestId = message.params.requestId;
          if (message.method === 'Network.loadingFinished' && message.params.requestId === requestId) {
            try { resolve((await send('Network.getResponseBody', {requestId}, sessionId, signal)).body); } catch (error) { reject(error); }
          }
        };
        listeners.add(listener);
      });
      await send('Page.navigate', {url: link}, sessionId, signal);
      return readFeedInfo(await whileActive(body, signal));
    } finally {
      if (listener) listeners.delete(listener);
      await closeTarget(targetId);
    }
  };
  const pump = () => {
    while (active < Math.max(1, maxTabs) && queue.length) {
      const job = queue.shift();
      if (job.controller.signal.aborted) continue;
      active++;
      activeJobs.add(job);
      const timer = setTimeout(() => job.controller.abort(new PreviewError('preview_timeout')), timeoutMs);
      resolveOne(job.link, job.kind, job.controller.signal).then(job.resolve, job.reject).finally(() => {
        clearTimeout(timer); job.cleanup(); activeJobs.delete(job); active--; pump();
      });
    }
  };
  const enqueue = (link, kind, signal) => new Promise((resolve, reject) => {
    const controller = new AbortController();
    const aborted = () => {
      controller.abort(new PreviewError('aborted'));
      const index = queue.indexOf(job);
      if (index >= 0) { queue.splice(index, 1); job.cleanup(); reject(abortError(controller.signal)); }
    };
    const job = {link, kind, controller, resolve, reject, cleanup: () => signal?.removeEventListener('abort', aborted)};
    if (signal?.aborted) { reject(new PreviewError('aborted')); return; }
    signal?.addEventListener('abort', aborted, {once: true});
    queue.push(job); pump();
  });
  // One shared preparation per runner process; both WeChat platforms await it before content enters the queue.
  const prepare = ({signal} = {}) => {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (closed) return Promise.reject(new PreviewError('aborted'));
    if (!preparation) preparation = (async () => {
      if (!checkRequired) return;
      const started = performance.now(); checkAbort = new AbortController();
      const timer = setTimeout(() => checkAbort.abort(new PreviewError('preview_selfcheck_timeout')),
        Math.max(1, Math.min(10_000, selfcheckTimeoutMs)));
      try {
        if (explicitPathChanged) throw new PreviewError('preview_explicit_unavailable');
        await visitLocalPreviewPage((url, _marker, selfcheckSignal) => resolveOne(url, 'selfcheck', selfcheckSignal), {signal: checkAbort.signal});
      } catch (error) {
        if (closed || error.code === 'aborted') throw new PreviewError('aborted');
        const elapsedMs = Math.round(performance.now() - started);
        const oldChrome = chrome, pending = [...ownedBrowsers].filter(child => child.exitCode == null && child.signalCode == null);
        const exited = pending.map(child => new Promise(resolve => child.once('exit', resolve)));
        let timer;
        reset();
        // A socket close may already have reset chrome; only an actual exit releases ownership.
        for (const child of pending) if (child !== oldChrome) { try { child.kill('SIGTERM'); } catch { /* Still wait for exit. */ } }
        const stopped = !pending.length || await Promise.race([Promise.all(exited).then(() => true),
          new Promise(resolve => {timer = setTimeout(() => resolve(false), 2000);})]);
        clearTimeout(timer);
        const fallbackPath = browserOptions?.systemChrome ?? SYSTEM_CHROME;
        const fallback = !chromeExplicit && stopped && !closed && chromeAvailable(fallbackPath);
        try { onDiagnostic({event: 'preview_browser_selfcheck_failed', code: error.code ?? 'preview_selfcheck_failed', elapsedMs,
          explicit: chromeExplicit, fallback, browserStopped: stopped}); } catch { /* Optional local diagnostics. */ }
        if (!fallback) throw new PreviewError('preview_browser_selfcheck_failed');
        chromePath = fallbackPath;
        try { onWarning('独立预览浏览器自检未通过，当前暂用系统 Chrome；本次启动仅提示一次。'); } catch { /* A warning cannot block fallback. */ }
      } finally { clearTimeout(timer); checkAbort = null; }
      if (closed) throw new PreviewError('aborted');
    })().then(() => { checkState = 'ready'; }, error => { checkState = 'failed'; checkError = error; throw error; });
    return signal ? whileActive(preparation, signal) : preparation;
  };
  return {
    start() { prepare().catch(() => {}); },
    prepare,
    status: () => ({readyForSearch: !closed && checkState === 'ready' && chromeAvailable(chromePath),
      reason: closed || checkState === 'failed' ? checkError?.code ?? 'preview_unavailable'
        : checkState === 'pending' ? 'preview_warming' : chromeAvailable(chromePath) ? null : 'preview_unavailable'}),
    /** Resolve one copied share link; at most `maxTabs` pages load at once, the rest wait in order. */
    resolve(link, {signal} = {}) {
      if (typeof link !== 'string' || !SHARE_LINK.test(link)) return Promise.reject(new PreviewError('share_link_invalid'));
      return prepare({signal}).then(() => enqueue(link, 'channels', signal));
    },
    /** Offline-tested candidate. Actual article DOM selectors/page behavior still require acceptance. */
    resolveArticle(link, {signal} = {}) {
      const canonical = canonicalArticleUrl(link);
      if (!canonical) return Promise.reject(new PreviewError('article_link_invalid'));
      return prepare({signal}).then(() => enqueue(canonical, 'article', signal));
    },
    available: () => !closed && checkState === 'ready' && chromeAvailable(chromePath),
    close() {
      closed = true; checkAbort?.abort(new PreviewError('aborted'));
      queue.splice(0).forEach(job => { job.cleanup(); job.reject(new PreviewError('aborted')); });
      for (const job of activeJobs) job.controller.abort(new PreviewError('aborted'));
      const oldChrome = chrome;
      reset();
      for (const child of ownedBrowsers) if (child !== oldChrome && child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGTERM'); } catch { /* closed */ }
      }
    },
  };
}
