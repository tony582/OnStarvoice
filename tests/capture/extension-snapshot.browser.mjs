import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {createServer} from "node:http";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extensionDir = join(repoRoot, "extension-build");

assert.equal(
  existsSync(join(extensionDir, "manifest.json")),
  true,
  "run scripts/sync-extension-build.zsh first",
);

async function findBundledChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    "/tmp/codex-playwright-browsers",
  ].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try {
      entries = await readdir(root, {withFileTypes: true});
    } catch {
      continue;
    }
    const versions = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const version of versions) {
      for (const architecture of ["chrome-mac-arm64", "chrome-mac"]) {
        const candidate = join(
          root,
          version,
          architecture,
          "Chromium.app/Contents/MacOS/Chromium",
        );
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return "";
}

async function resolveChromiumExecutable() {
  const configured = String(process.env.CHROMIUM_EXECUTABLE_PATH || "").trim();
  if (configured && existsSync(configured)) return configured;
  const bundled = await findBundledChromium();
  if (bundled) return bundled;
  throw new Error(
    "extension smoke test requires open-source Chromium; set CHROMIUM_EXECUTABLE_PATH",
  );
}

function deriveUnpackedExtensionId(path) {
  const digest = createHash("sha256").update(resolve(path)).digest().subarray(0, 16);
  let id = "";
  for (const byte of digest) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

async function waitUntil(read, {timeoutMs = 15_000, intervalMs = 50} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw lastError || new Error("condition not reached before timeout");
}

async function resolveLoadedExtensionId(profileDir) {
  return await waitUntil(async () => {
    for (const filename of ["Preferences", "Secure Preferences"]) {
      const path = join(profileDir, "Default", filename);
      let document;
      try {
        document = JSON.parse(await readFile(path, "utf8"));
      } catch {
        continue;
      }
      const settings = document?.extensions?.settings || {};
      for (const [extensionId, entry] of Object.entries(settings)) {
        const configuredPath = String(entry?.path || "");
        const manifestName = String(entry?.manifest?.name || "");
        if (
          resolve(configuredPath || ".") === resolve(extensionDir) ||
          manifestName === "StarVoice 星语"
        ) {
          return extensionId;
        }
      }
    }
    return "";
  }).catch(() => deriveUnpackedExtensionId(extensionDir));
}

async function openCdpTarget(port, url) {
  const response = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    {method: "PUT"},
  );
  if (!response.ok) {
    throw new Error(`failed to create CDP target: HTTP ${response.status}`);
  }
  return await response.json();
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let sequence = 0;
  const pending = new Map();
  const opened = new Promise((resolvePromise, rejectPromise) => {
    socket.addEventListener("open", resolvePromise, {once: true});
    socket.addEventListener("error", rejectPromise, {once: true});
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data || "{}"));
    if (!message.id || !pending.has(message.id)) return;
    const {resolvePromise, rejectPromise} = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      rejectPromise(new Error(message.error.message || "CDP command failed"));
    } else {
      resolvePromise(message.result || {});
    }
  });
  socket.addEventListener("close", () => {
    for (const {rejectPromise} of pending.values()) {
      rejectPromise(new Error("CDP socket closed"));
    }
    pending.clear();
  });

  return {
    async send(method, params = {}) {
      await opened;
      sequence += 1;
      return await new Promise((resolvePromise, rejectPromise) => {
        pending.set(sequence, {resolvePromise, rejectPromise});
        socket.send(JSON.stringify({id: sequence, method, params}));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        "browser evaluation failed",
    );
  }
  return response.result?.value;
}

const executable = await resolveChromiumExecutable();
const fixtureCards = Array.from(
  {length: 4},
  (_, index) => `
    <article class="note-item" data-note-id="fixture-note-${index + 1}">
      <a class="cover" href="/explore/fixture-note-${index + 1}">
        <img alt="测试笔记 ${index + 1}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
      </a>
      <div class="title">测试笔记 ${index + 1}</div>
      <span class="author">测试作者 ${index + 1}</span>
      <span class="like-count">${100 + index}</span>
    </article>`,
).join("");
const fixtureServer = createServer((_request, response) => {
  response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
  response.end(
    `<!doctype html><meta charset="utf-8"><title>StarVoice fixture</title>
     <style>body{min-height:1800px}.feeds-container{display:grid;grid-template-columns:repeat(2,240px);gap:24px}.note-item{min-height:260px}</style>
     <main class="feeds-container">${fixtureCards}</main>`,
  );
});
await new Promise((resolvePromise, rejectPromise) => {
  fixtureServer.once("error", rejectPromise);
  fixtureServer.listen(0, "127.0.0.1", resolvePromise);
});
const fixturePort = fixtureServer.address().port;
const sourceUrl = `http://www.xiaohongshu.com:${fixturePort}/search_result?keyword=starvoice-fixture`;
const weiboUrl = `http://s.weibo.com:${fixturePort}/weibo?q=starvoice-fixture`;
const profileDir = await mkdtemp(join(tmpdir(), "starvoice-extension-smoke-"));
const chrome = spawn(
  executable,
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--no-proxy-server",
    "--host-resolver-rules=MAP www.xiaohongshu.com 127.0.0.1, MAP s.weibo.com 127.0.0.1",
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "about:blank",
  ],
  {stdio: ["ignore", "ignore", "pipe"]},
);
let browserErrors = "";
chrome.stderr.setEncoding("utf8");
chrome.stderr.on("data", (chunk) => {
  browserErrors = `${browserErrors}${chunk}`.slice(-20_000);
});

let client = null;
try {
  const activePort = await waitUntil(async () => {
    try {
      const content = await readFile(join(profileDir, "DevToolsActivePort"), "utf8");
      const port = Number(content.split(/\r?\n/)[0]);
      return Number.isSafeInteger(port) && port > 0 ? port : null;
    } catch {
      return null;
    }
  });
  const extensionId = await resolveLoadedExtensionId(profileDir);
  const controlUrl = `chrome-extension://${extensionId}/sidebar/sidebar.html`;
  const controlTarget = await openCdpTarget(activePort, controlUrl);
  client = createCdpClient(controlTarget.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await waitUntil(async () =>
    await evaluate(client, "location.href.startsWith('chrome-extension://') && document.readyState === 'complete'"),
  );
  assert.equal(
    await evaluate(client, "chrome.runtime.getManifest().name"),
    "StarVoice 星语",
  );
  assert.equal(
    await evaluate(client, "chrome.runtime.getManifest().version"),
    "0.3.35",
  );

  const sourceTab = await evaluate(
    client,
    `(async () => {
      const tab = await chrome.tabs.create({url: ${JSON.stringify(sourceUrl)}, active: false});
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await chrome.tabs.get(tab.id);
        if ((current.url || '').startsWith('http://www.xiaohongshu.com:')) {
          return current;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return await chrome.tabs.get(tab.id);
    })()`,
  );
  const sourceTabId = sourceTab?.id;
  assert.equal(Number.isSafeInteger(sourceTabId), true, JSON.stringify(sourceTab));
  assert.match(String(sourceTab?.url || ""), /^http:\/\/www\.xiaohongshu\.com:/u);

  const taskId = "extension-snapshot-task";
  const begin = await evaluate(
    client,
    `chrome.runtime.sendMessage({
      type: 'onstarvoice:begin-capture-task',
      taskId: ${JSON.stringify(taskId)},
      sourceTabId: ${sourceTabId},
      platform: 'xiaohongshu',
      label: '快照验收任务',
      progress: {phase: 'detail_prepare', message: '准备详情采集'},
    })`,
  );
  assert.equal(begin?.ok, true, JSON.stringify(begin));
  const groupId = begin.data.group.groupId;
  assert.equal(begin.data.session.persistent, true);
  assert.equal(begin.data.session.taskId, taskId);
  assert.equal(begin.data.session.runId, `capture-task:${taskId}`);

  const native = await evaluate(
    client,
    `(async () => {
      const tab = await chrome.tabs.get(${sourceTabId});
      const group = await chrome.tabGroups.get(${groupId});
      const targets = await chrome.debugger.getTargets();
      return {
        tabGroupId: tab.groupId,
        groupTitle: group.title,
        attached: targets.some(target => target.tabId === ${sourceTabId} && target.attached),
      };
    })()`,
  );
  assert.deepEqual(native, {
    tabGroupId: groupId,
    groupTitle: "StarVoice 采集任务",
    attached: true,
  });

  await waitUntil(async () =>
    await evaluate(
      client,
      `(() => {
        const panel = document.querySelector('#debugSessionPanel');
        return panel && !panel.hidden;
      })()`,
    ),
  );
  const unknownPercent = await evaluate(
    client,
    `(() => {
      const track = document.querySelector('.debug-session-progress-track');
      const percent = document.querySelector('#debugSessionProgressPercent');
      return {
        indeterminate: track.classList.contains('is-indeterminate'),
        ariaValueNow: track.getAttribute('aria-valuenow'),
        percentHidden: percent.hidden,
      };
    })()`,
  );
  assert.deepEqual(unknownPercent, {
    indeterminate: true,
    ariaValueNow: null,
    percentHidden: true,
  });

  const updated = await evaluate(
    client,
    `chrome.runtime.sendMessage({
      type: 'onstarvoice:update-capture-task',
      taskId: ${JSON.stringify(taskId)},
      progress: {
        phase: 'detail_capturing',
        message: '正在采集详情',
        progressPercent: 42,
        current: 1,
        total: 2,
        workerMode: 'single',
        workerStates: [{label: '工作页 A', state: 'collecting'}],
      },
    })`,
  );
  assert.equal(updated?.ok, true, JSON.stringify(updated));
  await waitUntil(async () =>
    (await evaluate(
      client,
      "document.querySelector('#debugSessionProgressPercent')?.textContent",
    )) === "42%",
  );
  const knownPercent = await evaluate(
    client,
    `(() => {
      const track = document.querySelector('.debug-session-progress-track');
      const percent = document.querySelector('#debugSessionProgressPercent');
      return {
        indeterminate: track.classList.contains('is-indeterminate'),
        ariaValueNow: track.getAttribute('aria-valuenow'),
        percentHidden: percent.hidden,
        text: percent.textContent,
      };
    })()`,
  );
  assert.deepEqual(knownPercent, {
    indeterminate: false,
    ariaValueNow: "42",
    percentHidden: false,
    text: "42%",
  });

  const listRunId = "list-run-extension-snapshot";
  const relay = await evaluate(
    client,
    `chrome.runtime.sendMessage({
      type: 'onstarvoice:relay-to-content',
      tabId: ${sourceTabId},
      payload: {
        action: 'captureKeywordNotes',
        taskId: ${JSON.stringify(taskId)},
        listCaptureRunId: ${JSON.stringify(listRunId)},
        keyword: 'starvoice-fixture',
        minLikes: 0,
        maxDetectedItems: 2,
        maxScrollTimes: 1,
        waitMinMs: 100,
        waitMaxMs: 100,
        stallTimeoutMs: 1000,
        maxDurationMs: 3000,
      },
    })`,
  );
  assert.equal(relay?.ok, true, JSON.stringify(relay));
  assert.notEqual(relay?.data?.ok, false, JSON.stringify(relay));
  const overlay = await evaluate(
    client,
    `chrome.scripting.executeScript({
      target: {tabId: ${sourceTabId}},
      func: () => {
        const host = document.querySelector('[data-osv-list-harvest-host="true"]');
        const tracedCards = Array.from(
          document.querySelectorAll('[data-osv-capture-sequence]'),
        ).map(card => ({
          sequence: Number(card.getAttribute('data-osv-capture-sequence')),
          runId: card.getAttribute('data-osv-capture-run'),
          state: card.getAttribute('data-osv-capture-state'),
        }));
        return {
          hostState: host?.getAttribute('data-state') || '',
          markedCount: Number(host?.getAttribute('data-marked-count') || 0),
          runId: host?.getAttribute('data-list-capture-run') || '',
          pointerEvents: host ? getComputedStyle(host).pointerEvents : '',
          tracedCards,
        };
      },
    }).then(results => results[0]?.result)`,
  );
  assert.equal(overlay.hostState, "completed", JSON.stringify(overlay));
  assert.equal(overlay.pointerEvents, "none", JSON.stringify(overlay));
  assert.equal(overlay.runId, listRunId, JSON.stringify(overlay));
  assert.ok(overlay.markedCount >= 2, JSON.stringify(overlay));
  assert.deepEqual(
    overlay.tracedCards
      .map((card) => card.sequence)
      .filter(Number.isFinite)
      .sort((left, right) => left - right)
      .slice(0, 2),
    [1, 2],
  );
  assert.equal(
    overlay.tracedCards.every((card) => card.runId === listRunId),
    true,
  );

  const workerTabId = await evaluate(
    client,
    "chrome.tabs.create({url: 'about:blank', active: false}).then(tab => tab.id)",
  );
  const registered = await evaluate(
    client,
    `chrome.runtime.sendMessage({
      type: 'onstarvoice:register-capture-task-tab',
      taskId: ${JSON.stringify(taskId)},
      tabId: ${workerTabId},
      role: 'detail_worker',
    })`,
  );
  assert.equal(registered?.ok, true, JSON.stringify(registered));
  assert.equal(
    await evaluate(client, `chrome.tabs.get(${workerTabId}).then(tab => tab.groupId)`),
    groupId,
  );

  const ended = await evaluate(
    client,
    `chrome.runtime.sendMessage({
      type: 'onstarvoice:end-capture-task',
      taskId: ${JSON.stringify(taskId)},
      reason: 'completed',
      status: 'completed',
    })`,
  );
  assert.equal(ended?.ok, true, JSON.stringify(ended));
  const cleanup = await evaluate(
    client,
    `(async () => {
      const sourceTab = await chrome.tabs.get(${sourceTabId});
      const targets = await chrome.debugger.getTargets();
      const runtime = (await chrome.storage.local.get('onstarvoice.runtime'))['onstarvoice.runtime'];
      let workerExists = true;
      try { await chrome.tabs.get(${workerTabId}); } catch { workerExists = false; }
      return {
        sourceGroupId: sourceTab.groupId,
        attached: targets.some(target => target.tabId === ${sourceTabId} && target.attached),
        workerExists,
        cancellation: runtime?.captureTaskCancellation || null,
      };
    })()`,
  );
  assert.deepEqual(cleanup, {
    sourceGroupId: -1,
    attached: false,
    workerExists: false,
    cancellation: null,
  });

  const weiboTabId = await evaluate(
    client,
    `chrome.tabs.create({url: ${JSON.stringify(weiboUrl)}, active: false}).then(tab => tab.id)`,
  );
  await waitUntil(async () =>
    await evaluate(
      client,
      `chrome.tabs.get(${weiboTabId}).then(tab =>
        (tab.url || '').startsWith('http://s.weibo.com:'))`,
    ),
  );
  const rejected = await evaluate(
    client,
    `chrome.runtime.sendMessage({
      type: 'onstarvoice:begin-capture-task',
      taskId: 'weibo-must-not-use-debug',
      sourceTabId: ${weiboTabId},
      platform: 'xiaohongshu',
    })`,
  );
  assert.equal(rejected?.ok, false, JSON.stringify(rejected));
  assert.equal(rejected.error.code, "capture_task_platform_unsupported");

  process.stdout.write(
    `StarVoice extension snapshot lifecycle and platform guards: PASS (${basename(executable)})\n`,
  );
} catch (error) {
  if (browserErrors) {
    error.message = `${error.message}\nChromium stderr:\n${browserErrors}`;
  }
  throw error;
} finally {
  client?.close();
  chrome.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    if (chrome.exitCode !== null) return resolvePromise();
    const timer = setTimeout(() => {
      chrome.kill("SIGKILL");
      resolvePromise();
    }, 3_000);
    chrome.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
  await rm(profileDir, {recursive: true, force: true});
  await new Promise((resolvePromise) => fixtureServer.close(resolvePromise));
}
