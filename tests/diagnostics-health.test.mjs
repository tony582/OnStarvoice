import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBrowserRuntimeHealthSnapshot,
  buildDiagnosticsReport,
  sanitizeDiagnosticText,
} from "../utils/diagnostics.js";

test("browser runtime health is bounded and ignores arbitrary page or credential data", () => {
  const now = Date.now();
  const health = buildBrowserRuntimeHealthSnapshot({
    now,
    sampledAt: new Date(now).toISOString(),
    runtime: {
      platform: "douyin",
      pageType: "note_detail",
      detailReady: false,
      lastUpdatedAt: now - 500,
      lastCaptureProgressAt: now - 1200,
      lastPageUrl: "https://www.douyin.com/private/post?cookie=runtime-secret",
      body: "private-runtime-body",
    },
    diagnosticsState: {
      recentStages: [{
        at: new Date(now - 1000).toISOString(),
        source: "api",
        stageKey: "api.sync",
        metrics: {
          requestLatencyMs: 999999999,
          body: "private-stage-body",
          url: "https://voice.example.com/api/private",
        },
      }],
      recentErrors: [{
        at: new Date(now - 700).toISOString(),
        source: "api",
        error: {
          code: "timeout",
          message: "Cookie=diagnostic-secret https://voice.example.com/private",
        },
      }],
    },
    tabObservation: {
      available: true,
      tracked: true,
      status: "complete",
      active: true,
      discarded: false,
      frozen: true,
      autoDiscardable: true,
      url: "https://www.douyin.com/private/tab",
      title: "private-post-title",
    },
    eventLoopObservation: {
      sampleCount: 999,
      averageLagMs: 12.3456,
      maxLagMs: 999999999,
      rawText: "private-loop-text",
    },
    memoryObservation: {
      usedJSHeapSize: 128 * 1024 * 1024,
      totalJSHeapSize: 192 * 1024 * 1024,
      jsHeapSizeLimit: 256 * 1024 * 1024,
      cookie: "private-memory-cookie",
    },
  });

  assert.equal(health.cpu.available, false);
  assert.equal(health.cpu.reason, "browser_extension_api_unavailable");
  assert.deepEqual(health.cpu.proxyMetrics, [
    "event_loop_lag",
    "heap_usage",
    "tab_lifecycle",
    "request_latency",
  ]);
  assert.equal(health.eventLoop.sampleCount, 10);
  assert.equal(health.eventLoop.averageLagMs, 12.3);
  assert.equal(health.eventLoop.maxLagMs, 120000);
  assert.equal(health.heap.available, true);
  assert.equal(health.heap.usedMb, 128);
  assert.equal(health.heap.limitMb, 256);
  assert.equal(health.heap.utilizationPct, 50);
  assert.equal(health.tab.status, "complete");
  assert.equal(health.tab.discarded, false);
  assert.equal(health.tab.frozen, true);
  assert.equal(health.network.recentRequestLatencyMs, 120000);
  assert.equal(health.network.recentTimeoutCount, 1);
  assert.equal(health.runtime.stateAgeMs, 500);
  assert.equal(health.runtime.captureProgressAgeMs, 1200);

  const serialized = JSON.stringify(health);
  for (const forbidden of [
    "https://",
    "runtime-secret",
    "private-runtime-body",
    "private-stage-body",
    "diagnostic-secret",
    "private-post-title",
    "private-loop-text",
    "private-memory-cookie",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.ok(serialized.length < 2200);

  const unavailable = buildBrowserRuntimeHealthSnapshot({
    eventLoopObservation: {averageLagMs: null, maxLagMs: null},
    memoryObservation: {
      usedJSHeapSize: null,
      totalJSHeapSize: null,
      jsHeapSizeLimit: null,
    },
  });
  assert.equal(unavailable.eventLoop.available, false);
  assert.equal(unavailable.eventLoop.averageLagMs, null);
  assert.equal(unavailable.heap.available, false);
  assert.equal(unavailable.heap.usedMb, null);
});

test("diagnostic text redacts full URLs, bearer credentials and cookie values", () => {
  const sanitized = sanitizeDiagnosticText(
    "Cookie=secret-cookie Authorization: Bearer abc.def https://voice.example.com/private?q=1 Bearer_secret cookie_secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature123 0123456789abcdef0123456789abcdef01234567 AKIAIOSFODNN7EXAMPLE",
  );
  assert.equal(sanitized.includes("secret-cookie"), false);
  assert.equal(sanitized.includes("abc.def"), false);
  assert.equal(sanitized.includes("https://"), false);
  assert.equal(sanitized.includes("Bearer_secret"), false);
  assert.equal(sanitized.includes("cookie_secret"), false);
  assert.equal(sanitized.includes("eyJhbGci"), false);
  assert.equal(sanitized.includes("0123456789abcdef"), false);
  assert.equal(sanitized.includes("AKIAIOSFODNN7EXAMPLE"), false);
  assert.match(sanitized, /\[REDACTED\]/u);
  assert.match(sanitized, /\[URL_REDACTED\]/u);
});

test("diagnostic text redacts known secret-token families", () => {
  for (const credential of [
    ["xoxb", "123456789012", "123456789012", "abcdefghijklmnop"].join("-"),
    ["glpat", "abcdefghijklmnopqrst"].join("-"),
    ["ghp", "123456789012345678901234567890123456"].join("_"),
    ["sk", "live", "123456789012345678901234"].join("_"),
  ]) {
    const sanitized = sanitizeDiagnosticText(
      `request failed with ${credential}`,
      1000,
    );
    assert.equal(sanitized.includes(credential), false, credential);
    assert.match(sanitized, /\[REDACTED\]/u, credential);
  }
});

test("browser health codes reject known secret-token families", () => {
  for (const credential of [
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb_123456789012_123456789012_abcdefghijklmnop",
    "glpat_abcdefghijklmnopqrst",
    ["ghp", "123456789012345678901234567890123456"].join("_"),
  ]) {
    const health = buildBrowserRuntimeHealthSnapshot({
      diagnosticsState: {
        recentErrors: [{
          source: "api",
          at: "2026-08-25T01:50:00.000Z",
          error: {code: credential},
        }],
      },
    });
    assert.equal(health.network.lastErrorCode, "unknown", credential);
    assert.equal(JSON.stringify(health).includes(credential), false, credential);
  }
});

test("diagnostics export includes browser proxies without exporting tab URLs", async () => {
  const previousChrome = globalThis.chrome;
  const now = Date.now();
  const stored = {
    "onstarvoice.runtime": {
      clientUuid: "diagnostic-browser-a",
      clientLabel: "Chrome on macOS",
      appVersion: "0.3.93",
      platform: "douyin",
      pageType: "note_detail",
      detailReady: false,
      lastActiveTabId: 42,
      lastPageUrl:
        "https://www.douyin.com/video/7391234567890123456?cookie=page-secret",
      lastUpdatedAt: now - 300,
      lastCaptureProgressAt: now - 900,
    },
    "onstarvoice.taskLedger": {
      runs: [{
        id: "diagnostic-task-a",
        status: "running",
        runnerTabId: 42,
        progress: {
          current: 1,
          total: 2,
          phase: "detail_capture",
          message:
            "Cookie=task-secret https://www.douyin.com/private/task",
        },
      }],
    },
    "onstarvoice.diagnostics": {
      recentActions: [{
        at: new Date(now - 600).toISOString(),
        source: "cookie_secret",
        action: "Bearer_secret",
        stage: "authorization_secret",
        status: "token_secret",
      }],
      recentErrors: [{
        at: new Date(now - 500).toISOString(),
        source: "api",
        error: {
          code: "network_error",
          message:
            "Cookie=error-secret https://voice.example.com/private/api",
        },
      }],
      recentStages: [{
        at: new Date(now - 400).toISOString(),
        source: "bearer_secret",
        stageKey: "cookie_secret",
        status: "authorization_secret",
        label: "token_secret",
      }],
    },
  };

  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => ({[key]: stored[key] ?? null}),
        set: async () => undefined,
      },
    },
    tabs: {
      get: async () => ({
        id: 42,
        status: "complete",
        active: true,
        discarded: false,
        frozen: false,
        autoDiscardable: true,
        url: "https://www.douyin.com/private/tab?cookie=tab-secret",
        title: "private-post-title",
      }),
    },
  };

  try {
    const report = await buildDiagnosticsReport({
      sourceUrl: "https://voice.example.com/private/extra",
      cookie: "extra-secret",
    });
    assert.equal(report.browserRuntime.cpu.available, false);
    assert.equal(report.browserRuntime.eventLoop.available, true);
    assert.equal(report.browserRuntime.tab.available, true);
    assert.equal(report.browserRuntime.tab.tracked, true);
    assert.equal(report.browserRuntime.tab.status, "complete");
    assert.equal(report.browserRuntime.tab.discarded, false);
    assert.equal(report.browserRuntime.tab.frozen, false);
    assert.equal(report.browserRuntime.network.recentNetworkErrorCount, 1);
    assert.equal(report.page.host, "douyin.com");
    assert.equal(report.page.path, "/work/:id");

    const serialized = JSON.stringify(report);
    for (const forbidden of [
      "https://",
      "page-secret",
      "task-secret",
      "error-secret",
      "tab-secret",
      "extra-secret",
      "private-post-title",
      "Bearer_secret",
      "bearer_secret",
      "cookie_secret",
      "authorization_secret",
      "token_secret",
      "7391234567890123456",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    if (previousChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = previousChrome;
    }
  }
});
