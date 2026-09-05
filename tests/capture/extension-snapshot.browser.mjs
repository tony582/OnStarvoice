import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {createServer} from "node:https";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {execFile, spawn} from "node:child_process";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extensionDir = join(repoRoot, "extension-build");
const artifactDir = resolve(
  String(
    process.env.STARVOICE_SNAPSHOT_ARTIFACT_DIR ||
      join(tmpdir(), "starvoice-extension-snapshot-artifacts"),
  ),
);
const sidebarScreenshotPath = join(
  artifactDir,
  "sidebar-dark-running.png",
);
const waitOverlayScreenshotPath = join(
  artifactDir,
  "platform-wait-countdown.png",
);

assert.equal(
  existsSync(join(extensionDir, "manifest.json")),
  true,
  "run scripts/sync-extension-build.zsh first",
);
const extensionManifest = JSON.parse(
  await readFile(join(extensionDir, "manifest.json"), "utf8"),
);
await mkdir(artifactDir, {recursive: true});

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

async function createFixtureTlsCredentials(directory) {
  const configPath = join(directory, "openssl.cnf");
  const keyPath = join(directory, "fixture.key.pem");
  const certificatePath = join(directory, "fixture.cert.pem");
  await writeFile(
    configPath,
    `[req]
prompt = no
distinguished_name = fixture_identity
x509_extensions = fixture_extensions

[fixture_identity]
CN = StarVoice browser fixture

[fixture_extensions]
basicConstraints = critical, CA:TRUE
keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign
extendedKeyUsage = serverAuth
subjectAltName = @fixture_names

[fixture_names]
DNS.1 = www.xiaohongshu.com
DNS.2 = www.douyin.com
DNS.3 = s.weibo.com
IP.1 = 127.0.0.1
`,
  );
  const opensslExecutable =
    String(process.env.OPENSSL_EXECUTABLE || "openssl").trim() || "openssl";
  await execFileAsync(opensslExecutable, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-config",
    configPath,
    "-extensions",
    "fixture_extensions",
  ]);
  return {
    key: await readFile(keyPath),
    cert: await readFile(certificatePath),
  };
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

async function captureViewportScreenshot(
  client,
  outputPath,
  {width, height},
) {
  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(
    client,
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))).then(() => true)",
  );
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  assert.ok(
    String(screenshot?.data || "").length > 100,
    `empty Chromium screenshot: ${outputPath}`,
  );
  await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  return outputPath;
}

async function captureAttachedTabScreenshot(
  controlClient,
  tabId,
  outputPath,
  {width, height},
) {
  const data = await evaluate(
    controlClient,
    `(async () => {
      const target = {tabId: ${tabId}};
      await chrome.debugger.sendCommand(target, 'Page.enable');
      await chrome.debugger.sendCommand(
        target,
        'Emulation.setDeviceMetricsOverride',
        {
          width: ${width},
          height: ${height},
          deviceScaleFactor: 1,
          mobile: false,
        },
      );
      await chrome.scripting.executeScript({
        target: {tabId: ${tabId}},
        func: () => new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))),
      });
      const screenshot = await chrome.debugger.sendCommand(
        target,
        'Page.captureScreenshot',
        {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false,
        },
      );
      return screenshot?.data || '';
    })()`,
  );
  assert.ok(
    String(data || "").length > 100,
    `empty Chromium tab screenshot: ${outputPath}`,
  );
  await writeFile(outputPath, Buffer.from(data, "base64"));
  return outputPath;
}

async function readTakeoverSnapshot(controlClient, tabId) {
  return await evaluate(
    controlClient,
    `chrome.scripting.executeScript({
      target: {tabId: ${tabId}},
      func: () => {
        const host = document.querySelector('[data-osv-list-harvest-host="true"]');
        return {
          exists: Boolean(host),
          visible: host?.getAttribute('data-takeover-visible') || '',
          waiting: host?.getAttribute('data-takeover-waiting') || '',
          label: host?.getAttribute('data-takeover-label') || '',
          phase: host?.getAttribute('data-takeover-phase') || '',
          reason: host?.getAttribute('data-takeover-reason') || '',
          nextKeyword: host?.getAttribute('data-takeover-next-keyword') || '',
          remainingMs: Number(host?.getAttribute('data-takeover-remaining-ms') || 0),
          deadlineAt: Number(host?.getAttribute('data-takeover-deadline-at') || 0),
        };
      },
    }).then(results => results[0]?.result)`,
  );
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
const douyinFixtureIds = [
  "766193585000000001",
  "766193585000000002",
];
const douyinFixtureCards = douyinFixtureIds
  .map(
    (noteId, index) => `
      <article
        id="${index === 0 ? `waterfall_item_${noteId}` : `search_card_${index + 1}`}"
        class="search-result-card"
        ${index === 1 ? `data-e2e-aweme-id="${noteId}"` : ""}
      >
        <a
          class="cover"
          ${index === 1 ? `href="/jingxuan/search/starvoice-fixture?type=general&modal_id=${noteId}"` : ""}
        >
          <img alt="抖音测试作品 ${index + 1}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
        </a>
        <p class="title">抖音测试作品 ${index + 1}</p>
        <span class="author">抖音作者 ${index + 1}</span>
        <span class="like-count">${200 + index}</span>
        <span class="FnM1bbIQ">00:${String(20 + index).padStart(2, "0")}</span>
      </article>`,
  )
  .join("");
let fixtureRequestCount = 0;
const fixtureTlsDir = await mkdtemp(
  join(tmpdir(), "starvoice-extension-fixture-tls-"),
);
const fixtureTlsCredentials = await createFixtureTlsCredentials(fixtureTlsDir);
const fixtureServer = createServer(fixtureTlsCredentials, (request, response) => {
  fixtureRequestCount += 1;
  response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
  if (String(request.headers.host || "").startsWith("www.douyin.com")) {
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Douyin fixture</title>
       <style>body{min-height:1800px}#search-result-container{display:grid;grid-template-columns:repeat(2,240px);gap:24px}.search-result-card{min-height:260px}.FnM1bbIQ{display:block}</style>
       <input data-e2e="searchbar-input" value="starvoice-fixture">
       <main id="search-result-container">${douyinFixtureCards}</main>`,
    );
    return;
  }
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
const sourceUrl = `https://www.xiaohongshu.com:${fixturePort}/search_result?keyword=starvoice-fixture`;
const douyinSourceUrl =
  `https://www.douyin.com:${fixturePort}/jingxuan/search/starvoice-fixture?type=general`;
const weiboUrl = `https://s.weibo.com:${fixturePort}/weibo?q=starvoice-fixture`;
const profileDir = await mkdtemp(join(tmpdir(), "starvoice-extension-smoke-"));
const chrome = spawn(
  executable,
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    // Keep the isolated browser entirely outside the user's macOS keychain.
    "--use-mock-keychain",
    "--disable-background-networking",
    "--disable-component-update",
    // Trust the short-lived fixture certificate only inside this temporary
    // browser profile; the production-like hostnames still resolve to loopback.
    "--ignore-certificate-errors",
    "--no-proxy-server",
    "--host-resolver-rules=MAP www.xiaohongshu.com 127.0.0.1, MAP www.douyin.com 127.0.0.1, MAP s.weibo.com 127.0.0.1",
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
  await evaluate(
    client,
    "chrome.storage.local.set({'onstarvoice.riskNoticeAcknowledged': true}).then(() => true)",
  );
  await client.send("Page.reload", {ignoreCache: true});
  await waitUntil(async () =>
    await evaluate(
      client,
      "location.href.startsWith('chrome-extension://') && document.readyState === 'complete'",
    ),
  );
  assert.equal(
    await evaluate(client, "chrome.runtime.getManifest().name"),
    "StarVoice 星语",
  );
  assert.equal(
    await evaluate(client, "chrome.runtime.getManifest().version"),
    extensionManifest.version,
  );

  const sourceTab = await evaluate(
    client,
    `(async () => {
      const tab = await chrome.tabs.create({url: ${JSON.stringify(sourceUrl)}, active: false});
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await chrome.tabs.get(tab.id);
        if (((current.url || current.pendingUrl) || '').startsWith('https://www.xiaohongshu.com:')) {
          return current;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return await chrome.tabs.get(tab.id);
    })()`,
  );
  const sourceTabId = sourceTab?.id;
  const sourceTabUrl = String(sourceTab?.url || sourceTab?.pendingUrl || "");
  assert.equal(Number.isSafeInteger(sourceTabId), true, JSON.stringify(sourceTab));
  assert.match(
    sourceTabUrl,
    /^https:\/\/www\.xiaohongshu\.com:/u,
    JSON.stringify(sourceTab),
  );
  await waitUntil(async () =>
    await evaluate(
      client,
      `chrome.tabs.get(${sourceTabId}).then(tab => tab.status === 'complete')`,
    ),
  ).catch(async (error) => {
    const current = await evaluate(
      client,
      `chrome.tabs.get(${sourceTabId})`,
    ).catch(() => null);
    error.message = `${error.message}; fixture requests=${fixtureRequestCount}; tab=${JSON.stringify(current)}`;
    throw error;
  });

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
        keyword: '吉事桔香茶',
        keywordCurrent: 1,
        keywordTotal: 2,
        itemCurrent: 44,
        itemTotal: 50,
        roundCurrent: 1,
        roundTotal: 2,
        runStartedAt: new Date(Date.now() - 73000).toISOString(),
        phaseStartedAt: new Date(Date.now() - 12000).toISOString(),
        updatedAt: new Date().toISOString(),
        workerMode: 'double_buffer',
        workerStates: [
          {label: '工作页 A', state: 'collecting'},
          {label: '工作页 B', state: 'ready'},
        ],
        taskMeta: {
          keywordList: ['吉事桔香茶', '桔香茶'],
          searchFilters: {
            sort: 'latest',
            publishTime: 'week',
          },
          enhancementEnabled: true,
          commentsEnabled: true,
          bloggerMetricsEnabled: true,
        },
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
  await captureViewportScreenshot(client, sidebarScreenshotPath, {
    width: 480,
    height: 1000,
  });
  process.stdout.write(
    `StarVoice dark task screenshot: ${sidebarScreenshotPath}\n`,
  );

  const waitProgressUpdatedAt = new Date().toISOString();
  const waitTakeover = await evaluate(
    client,
    `chrome.runtime.sendMessage({
      type: 'onstarvoice:relay-to-content',
      tabId: ${sourceTabId},
      payload: {
        action: 'setCaptureTaskTakeover',
        taskId: ${JSON.stringify(taskId)},
        active: true,
        label: 'AI 正在接管',
        progress: {
          phase: 'inter_keyword_delay',
          message: '当前关键词已完成，正在安全等待',
          waitReason: '降低连续访问频率，等待后自动继续',
          remainingMs: 15000,
          updatedAt: ${JSON.stringify(waitProgressUpdatedAt)},
          nextKeyword: '别克壁纸',
        },
      },
    })`,
  );
  assert.equal(waitTakeover?.ok, true, JSON.stringify(waitTakeover));
  assert.notEqual(waitTakeover?.data?.ok, false, JSON.stringify(waitTakeover));

  const initialWaitSnapshot = await waitUntil(async () => {
    const snapshot = await readTakeoverSnapshot(client, sourceTabId);
    return snapshot?.waiting === "true" && snapshot.remainingMs > 0
      ? snapshot
      : null;
  });
  assert.equal(initialWaitSnapshot.visible, "true");
  assert.equal(initialWaitSnapshot.phase, "inter_keyword_delay");
  assert.equal(
    initialWaitSnapshot.reason,
    "降低连续访问频率，等待后自动继续",
  );
  assert.equal(initialWaitSnapshot.nextKeyword, "别克壁纸");
  assert.ok(initialWaitSnapshot.remainingMs <= 15_000);
  assert.ok(initialWaitSnapshot.deadlineAt > Date.now());

  const decrementedWaitSnapshot = await waitUntil(
    async () => {
      const snapshot = await readTakeoverSnapshot(client, sourceTabId);
      return snapshot?.waiting === "true" &&
        snapshot.remainingMs >= 0 &&
        snapshot.remainingMs < initialWaitSnapshot.remainingMs
        ? snapshot
        : null;
    },
    {timeoutMs: 4_000, intervalMs: 100},
  );
  assert.equal(decrementedWaitSnapshot.nextKeyword, "别克壁纸");

  await captureAttachedTabScreenshot(
    client,
    sourceTabId,
    waitOverlayScreenshotPath,
    {
      width: 1440,
      height: 900,
    },
  );
  process.stdout.write(
    `StarVoice wait countdown screenshot: ${waitOverlayScreenshotPath}\n`,
  );

  const clearedWaitTakeover = await evaluate(
    client,
    `chrome.runtime.sendMessage({
      type: 'onstarvoice:relay-to-content',
      tabId: ${sourceTabId},
      payload: {
        action: 'setCaptureTaskTakeover',
        taskId: ${JSON.stringify(taskId)},
        active: false,
        clearTrace: true,
        label: 'AI 正在接管',
      },
    })`,
  );
  assert.equal(
    clearedWaitTakeover?.ok,
    true,
    JSON.stringify(clearedWaitTakeover),
  );
  assert.notEqual(
    clearedWaitTakeover?.data?.ok,
    false,
    JSON.stringify(clearedWaitTakeover),
  );
  await waitUntil(async () => {
    const snapshot = await readTakeoverSnapshot(client, sourceTabId);
    return snapshot?.exists === false;
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

  const douyinTab = await evaluate(
    client,
    `(async () => {
      const tab = await chrome.tabs.create({url: ${JSON.stringify(douyinSourceUrl)}, active: false});
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await chrome.tabs.get(tab.id);
        if (((current.url || current.pendingUrl) || '').startsWith('https://www.douyin.com:')) {
          return current;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return await chrome.tabs.get(tab.id);
    })()`,
  );
  const douyinTabId = douyinTab?.id;
  const douyinTabUrl = String(douyinTab?.url || douyinTab?.pendingUrl || "");
  assert.equal(Number.isSafeInteger(douyinTabId), true, JSON.stringify(douyinTab));
  assert.match(
    douyinTabUrl,
    /^https:\/\/www\.douyin\.com:/u,
    JSON.stringify(douyinTab),
  );
  await waitUntil(async () =>
    await evaluate(
      client,
      `chrome.tabs.get(${douyinTabId}).then(tab => tab.status === 'complete')`,
    ),
  ).catch(async (error) => {
    const current = await evaluate(
      client,
      `chrome.tabs.get(${douyinTabId})`,
    ).catch(() => null);
    error.message = `${error.message}; fixture requests=${fixtureRequestCount}; tab=${JSON.stringify(current)}`;
    throw error;
  });
  const douyinTaskId = "extension-snapshot-douyin-task";
  const douyinBegin = await evaluate(
    client,
    `chrome.runtime.sendMessage({
      type: 'onstarvoice:begin-capture-task',
      taskId: ${JSON.stringify(douyinTaskId)},
      sourceTabId: ${douyinTabId},
      platform: 'douyin',
      label: '抖音序号验收任务',
    })`,
  );
  assert.equal(douyinBegin?.ok, true, JSON.stringify(douyinBegin));

  const douyinListRunId = "list-run-douyin-snapshot";
  const douyinRelay = await evaluate(
    client,
    `chrome.runtime.sendMessage({
      type: 'onstarvoice:relay-to-content',
      tabId: ${douyinTabId},
      payload: {
        action: 'captureKeywordNotes',
        taskId: ${JSON.stringify(douyinTaskId)},
        listCaptureRunId: ${JSON.stringify(douyinListRunId)},
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
  assert.equal(douyinRelay?.ok, true, JSON.stringify(douyinRelay));
  assert.notEqual(douyinRelay?.data?.ok, false, JSON.stringify(douyinRelay));
  assert.deepEqual(
    douyinRelay.data.data.items.map((item) => item.noteId),
    douyinFixtureIds,
  );
  assert.deepEqual(
    douyinRelay.data.data.items.map((item) => item.captureTrace?.sequence),
    [1, 2],
  );
  assert.deepEqual(
    douyinRelay.data.data.items.map((item) =>
      new URL(item.url).searchParams.get("modal_id"),
    ),
    douyinFixtureIds,
  );
  const douyinOverlay = await evaluate(
    client,
    `chrome.scripting.executeScript({
      target: {tabId: ${douyinTabId}},
      func: async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const host = document.querySelector('[data-osv-list-harvest-host="true"]');
        return {
          host: host?.getAttribute('data-state') || '',
          marked: Number(host?.getAttribute('data-marked-count') || 0),
          visible: Number(host?.getAttribute('data-visible-marker-count') || 0),
          unresolved: Number(host?.getAttribute('data-unresolved-count') || 0),
          sequences: Array.from(document.querySelectorAll('[data-osv-capture-sequence]'))
            .map(card => Number(card.getAttribute('data-osv-capture-sequence')))
            .filter(Number.isFinite)
            .sort((left, right) => left - right),
        };
      },
    }).then(results => results[0]?.result)`,
  );
  assert.equal(douyinOverlay.host, "completed", JSON.stringify(douyinOverlay));
  assert.equal(douyinOverlay.marked, 2, JSON.stringify(douyinOverlay));
  assert.equal(douyinOverlay.visible, 2, JSON.stringify(douyinOverlay));
  assert.equal(douyinOverlay.unresolved, 0, JSON.stringify(douyinOverlay));
  assert.deepEqual(douyinOverlay.sequences.slice(0, 2), [1, 2]);

  await evaluate(
    client,
    `chrome.tabs.reload(${douyinTabId}).then(() => true)`,
  );
  await waitUntil(async () =>
    await evaluate(
      client,
      `chrome.tabs.get(${douyinTabId}).then(tab => tab.status === 'complete')`,
    ),
  );
  await waitUntil(async () =>
    await evaluate(
      client,
      `(async () => {
        const runtime = (await chrome.storage.local.get('onstarvoice.runtime'))['onstarvoice.runtime'];
        const targets = await chrome.debugger.getTargets();
        return runtime?.captureDebugSession?.taskId === ${JSON.stringify(douyinTaskId)} &&
          runtime?.captureDebugSession?.state === 'attached' &&
          targets.some(target => target.tabId === ${douyinTabId} && target.attached);
      })()`,
    ),
  );
  const douyinRestore = await evaluate(
    client,
    `chrome.runtime.sendMessage({
      type: 'onstarvoice:relay-to-content',
      tabId: ${douyinTabId},
      payload: {
        action: 'restoreListCaptureTraceOverlay',
        runId: ${JSON.stringify(douyinListRunId)},
        platform: 'douyin',
        label: '抖音序号恢复验收',
        items: ${JSON.stringify(douyinRelay.data.data.items)},
      },
    })`,
  );
  assert.equal(douyinRestore?.ok, true, JSON.stringify(douyinRestore));
  assert.equal(
    douyinRestore?.data?.data?.restoredCount,
    2,
    JSON.stringify(douyinRestore),
  );
  const restoredDouyinOverlay = await evaluate(
    client,
    `chrome.scripting.executeScript({
      target: {tabId: ${douyinTabId}},
      func: async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const host = document.querySelector('[data-osv-list-harvest-host="true"]');
        return {
          marked: Number(host?.getAttribute('data-marked-count') || 0),
          visible: Number(host?.getAttribute('data-visible-marker-count') || 0),
          unresolved: Number(host?.getAttribute('data-unresolved-count') || 0),
        };
      },
    }).then(results => results[0]?.result)`,
  );
  assert.deepEqual(
    restoredDouyinOverlay,
    {marked: 2, visible: 2, unresolved: 0},
  );

  const douyinEnded = await evaluate(
    client,
    `chrome.runtime.sendMessage({
      type: 'onstarvoice:end-capture-task',
      taskId: ${JSON.stringify(douyinTaskId)},
      reason: 'completed',
      status: 'completed',
    })`,
  );
  assert.equal(douyinEnded?.ok, true, JSON.stringify(douyinEnded));

  const weiboTabId = await evaluate(
    client,
    `chrome.tabs.create({url: ${JSON.stringify(weiboUrl)}, active: false}).then(tab => tab.id)`,
  );
  await waitUntil(async () =>
    await evaluate(
      client,
      `chrome.tabs.get(${weiboTabId}).then(tab =>
        ((tab.url || tab.pendingUrl) || '').startsWith('https://s.weibo.com:'))`,
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
  await rm(fixtureTlsDir, {recursive: true, force: true});
}
