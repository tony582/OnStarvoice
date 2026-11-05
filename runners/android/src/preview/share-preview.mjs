import {spawn} from 'node:child_process';
import {accessSync, constants, mkdirSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';

// A copied WeChat Channels share link opens WeChat's public preview page in an ordinary browser. That page
// requests its own post data (feed/get_feed_info); this resolver opens the link in a headless Chrome on this
// computer and reads that response, exactly what the page shows: caption, publish time, author and counts.
// It never sends requests of its own to WeChat and never logs in. One Chrome process, a few tabs at a time.
export const SHARE_LINK = /^https:\/\/weixin\.qq\.com\/sph\/[A-Za-z0-9_-]{4,40}$/u;
export const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const FEED_API = /^https:\/\/channels\.weixin\.qq\.com\/finder-preview\/api\/feed\/get_feed_info(?:\?|$)/u;

export class PreviewError extends Error {
  constructor(code, message = code) { super(message); this.name = 'PreviewError'; this.code = code; }
}

export function chromeAvailable(path = DEFAULT_CHROME) {
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

export function createSharePreview({chromePath = DEFAULT_CHROME, profileDir, port = 9333, maxTabs = 2,
  timeoutMs = 15_000, spawnImpl = spawn, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket} = {}) {
  if (typeof profileDir !== 'string' || !profileDir) throw new PreviewError('preview_unavailable', 'A private Chrome profile directory is required');
  let chrome = null, socket = null, connecting = null, seq = 0, active = 0;
  const waiting = new Map(), listeners = new Set(), queue = [];
  const reset = () => {
    for (const [, entry] of waiting) entry.reject(new PreviewError('preview_unavailable'));
    waiting.clear();
    try { socket?.close(); } catch { /* closed */ }
    try { chrome?.kill('SIGTERM'); } catch { /* gone */ }
    socket = null; chrome = null; connecting = null;
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (!socket) { reject(new PreviewError('preview_unavailable')); return; }
    const id = ++seq;
    waiting.set(id, {resolve, reject});
    socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
  });
  const connect = () => connecting ??= (async () => {
    if (!chromeAvailable(chromePath)) throw new PreviewError('preview_unavailable', 'Google Chrome is not installed');
    mkdirSync(profileDir, {recursive: true, mode: 0o700});
    chrome = spawnImpl(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profileDir}`, '--window-size=430,932', 'about:blank'], {stdio: 'ignore'});
    chrome.on('exit', reset);
    let version = null;
    for (let i = 0; i < 40 && !version; i++) {
      try { version = await (await fetchImpl(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(250); }
    }
    if (!version?.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1')) { reset(); throw new PreviewError('preview_unavailable'); }
    socket = new WebSocketImpl(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, {once: true});
      socket.addEventListener('error', () => reject(new PreviewError('preview_unavailable')), {once: true});
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const entry = message.id ? waiting.get(message.id) : null;
      if (entry) { waiting.delete(message.id); message.error ? entry.reject(new PreviewError('preview_cdp_error')) : entry.resolve(message.result); }
      else for (const listener of listeners) listener(message);
    });
    socket.addEventListener('close', reset);
  })();
  const resolveOne = async (link) => {
    await connect();
    const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
    let listener = null, timer = null;
    try {
      const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
      await send('Network.enable', {}, sessionId);
      await send('Emulation.setUserAgentOverride', {userAgent: MOBILE_UA}, sessionId);
      const body = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new PreviewError('preview_timeout')), timeoutMs);
        let requestId = null;
        listener = async message => {
          if (message.sessionId !== sessionId) return;
          if (message.method === 'Network.responseReceived' && FEED_API.test(message.params.response.url)) requestId = message.params.requestId;
          if (message.method === 'Network.loadingFinished' && message.params.requestId === requestId) {
            try { resolve((await send('Network.getResponseBody', {requestId}, sessionId)).body); } catch (error) { reject(error); }
          }
        };
        listeners.add(listener);
      });
      await send('Page.navigate', {url: link}, sessionId);
      return readFeedInfo(await body);
    } finally {
      clearTimeout(timer);
      if (listener) listeners.delete(listener);
      send('Target.closeTarget', {targetId}).catch(() => {});
    }
  };
  const pump = () => {
    while (active < maxTabs && queue.length) {
      const job = queue.shift();
      active++;
      resolveOne(job.link).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  };
  return {
    /** Resolve one copied share link; at most `maxTabs` pages load at once, the rest wait in order. */
    resolve(link) {
      if (typeof link !== 'string' || !SHARE_LINK.test(link)) return Promise.reject(new PreviewError('share_link_invalid'));
      return new Promise((resolve, reject) => { queue.push({link, resolve, reject}); pump(); });
    },
    available: () => chromeAvailable(chromePath),
    close() { queue.splice(0).forEach(job => job.reject(new PreviewError('aborted'))); reset(); },
  };
}
