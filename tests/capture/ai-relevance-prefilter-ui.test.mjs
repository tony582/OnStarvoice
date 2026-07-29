import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sidebarHtml = await readFile(
  new URL("../../sidebar/sidebar.html", import.meta.url),
  "utf8",
);
const sidebarLogic = await readFile(
  new URL("../../sidebar/sidebar-logic.js", import.meta.url),
  "utf8",
);
const sidebarUi = await readFile(
  new URL("../../sidebar/sidebar-ui.js", import.meta.url),
  "utf8",
);
const sidebarCss = await readFile(
  new URL("../../sidebar/sidebar.css", import.meta.url),
  "utf8",
);
const captureSyncSource = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);
const captureSettingsSource = await readFile(
  new URL("../../utils/capture-settings.js", import.meta.url),
  "utf8",
);
const constantsSource = await readFile(
  new URL("../../utils/constants.js", import.meta.url),
  "utf8",
);

function readSourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test("AI relevance prefilter is a search-only enhancement option with safe copy", () => {
  const bloggerStart = sidebarHtml.indexOf('id="bloggerTab"');
  const searchStart = sidebarHtml.indexOf('id="searchTab"');
  const monitorStart = sidebarHtml.indexOf('id="monitorTab"');
  assert.ok(bloggerStart >= 0 && searchStart > bloggerStart);
  assert.ok(monitorStart > searchStart);

  const bloggerSection = sidebarHtml.slice(bloggerStart, searchStart);
  const searchSection = sidebarHtml.slice(searchStart, monitorStart);
  const optionMatches = sidebarHtml.match(
    /data-detail-setting="ai-relevance-prefilter"/g,
  );

  assert.equal(optionMatches?.length, 1);
  assert.doesNotMatch(bloggerSection, /ai-relevance-prefilter/);
  assert.match(searchSection, /AI 精准筛选/);
  assert.match(searchSection, /后台 DeepSeek/);
  assert.match(searchSection, /仅在高置信度判定无关时跳过增强/);
  assert.match(searchSection, /服务异常都会继续采集/);
  assert.ok(
    searchSection.indexOf('data-detail-setting="auto-sync"') <
      searchSection.indexOf('data-detail-setting="ai-relevance-prefilter"'),
  );
  assert.ok(
    searchSection.indexOf('data-detail-setting="ai-relevance-prefilter"') <
      searchSection.indexOf('data-detail-setting="metrics"'),
  );
});

test("AI relevance prefilter uses one persisted setting shared by manual and unattended runs", () => {
  assert.match(
    captureSettingsSource,
    /ENABLE_AI_RELEVANCE_PREFILTER:\s*"capture\.enableAiRelevancePrefilter"/,
  );
  assert.match(
    captureSettingsSource,
    /enableAiRelevancePrefilter:\s*false/,
  );
  assert.match(
    sidebarLogic,
    /handleDetailCaptureAiRelevancePrefilterToggleChange/,
  );
  assert.match(
    sidebarLogic,
    /enableAiRelevancePrefilter:\s*Boolean\(\s*settings\?\.enableAiRelevancePrefilter/,
  );
  assert.match(
    sidebarLogic,
    /relevanceKeyword:\s*capturedKeyword/,
  );
  assert.match(
    constantsSource,
    /RELEVANCE_PREFILTER:\s*"\/api\/relevance\/prefilter"/,
  );
});

test("capture settings default the AI relevance prefilter off and persist explicit choices", async () => {
  const storage = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(
            keys
              .filter((key) => Object.hasOwn(storage, key))
              .map((key) => [key, storage[key]]),
          );
        },
        async set(values) {
          Object.assign(storage, values);
        },
      },
    },
  };

  const moduleUrl = new URL(
    `../../utils/capture-settings.js?ai-prefilter=${Date.now()}`,
    import.meta.url,
  );
  const {getCaptureSettings, saveCaptureSettings} = await import(moduleUrl);

  assert.equal((await getCaptureSettings()).enableAiRelevancePrefilter, false);

  const enabled = await saveCaptureSettings({
    enableAiRelevancePrefilter: true,
  });
  assert.equal(enabled.enableAiRelevancePrefilter, true);
  assert.equal(storage["capture.enableAiRelevancePrefilter"], true);

  const disabled = await saveCaptureSettings({
    enableAiRelevancePrefilter: false,
  });
  assert.equal(disabled.enableAiRelevancePrefilter, false);
  assert.equal(storage["capture.enableAiRelevancePrefilter"], false);
});

test("AI skips persist as a terminal filtered detail state and settle without opening a worker", () => {
  assert.match(captureSyncSource, /FILTERED:\s*'filtered'/);
  assert.match(
    captureSyncSource,
    /status:\s*DETAIL_CAPTURE_STATUS\.FILTERED/,
  );

  const allSkippedSection = readSourceSection(
    captureSyncSource,
    "// 全部已采过或被 AI 高置信度过滤",
    "const results = [];",
  );
  assert.match(allSkippedSection, /phase:\s*'detail_item_filtered'/);
  assert.match(allSkippedSection, /phase:\s*'detail_item_skipped'/);
  assert.match(allSkippedSection, /recordId,/);
  assert.match(allSkippedSection, /state:\s*'filtered'/);
});

test("filtered records are terminal for pending, retry and sync-blocker logic including legacy records", () => {
  const section = readSourceSection(
    sidebarLogic,
    "function isAiRelevanceFilteredPayload(payload = {})",
    "function isDetailCaptureRetryable(record)",
  );
  const context = vm.createContext({});
  vm.runInContext(
    `${section}\nglobalThis.__isDone = isDetailCaptureDone;`,
    context,
  );
  const isDone = context.__isDone;

  assert.equal(
    isDone({type: "keyword_notes", payload: {detailCaptureStatus: "filtered"}}),
    true,
  );
  assert.equal(
    isDone({
      type: "keyword_notes",
      payload: {
        aiRelevancePrefilter: {executionDisposition: "skip_expensive"},
      },
    }),
    true,
  );
  assert.equal(
    isDone({
      type: "keyword_notes",
      payload: {captureTrace: {state: "filtered"}},
    }),
    true,
  );
  assert.equal(
    isDone({
      type: "keyword_notes",
      payload: {detailCaptureStatus: "done", detailPayload: {title: "ok"}},
    }),
    true,
  );
  assert.equal(
    isDone({type: "keyword_notes", payload: {detailCaptureStatus: "failed"}}),
    false,
  );

  const blockerSection = readSourceSection(
    sidebarLogic,
    "function summarizeDetailCaptureBlockers(records = [])",
    "function buildDetailCaptureBlockerMessage(summary)",
  );
  assert.match(blockerSection, /isDetailCaptureDone\(record\)/);
});

test("record cards visibly explain AI filtering with keyword, confidence and reason and no retry", () => {
  const helperSection = readSourceSection(
    sidebarUi,
    "function formatAiRelevanceConfidence(value)",
    "function resolveDetailCaptureStatusRow(record)",
  );
  const context = vm.createContext({});
  vm.runInContext(
    `${helperSection}\nglobalThis.__resolve = resolveAiRelevanceFilteredStatus;`,
    context,
  );
  const status = context.__resolve({
    aiRelevancePrefilter: {
      executionDisposition: "skip_expensive",
      keyword: "别克壁纸",
      confidence: 0.99,
      reason: "内容主体为大众汽车",
    },
  });
  assert.equal(status.text, "AI 已判定无关 · 已跳过增强");
  assert.match(status.detail, /关键词「别克壁纸」/);
  assert.match(status.detail, /置信度 99%/);
  assert.match(status.detail, /内容主体为大众汽车/);

  const rowSection = readSourceSection(
    sidebarUi,
    "function resolveDetailCaptureStatusRow(record)",
    "function resolveDetailCaptureErrorText(payload = {})",
  );
  assert.match(rowSection, /resolveAiRelevanceFilteredStatus\(payload\)/);
  assert.match(
    rowSection,
    /if \(filteredStatus\)[\s\S]*?actions:\s*""/,
  );
  assert.match(sidebarCss, /\.comment-status-row\.is-ai-filtered/);
  assert.match(sidebarCss, /\.comment-status-title\.is-ai-filtered/);
});

test("task progress explains AI prefilter start, completion and per-item skips", () => {
  const actionCopySection = readSourceSection(
    sidebarLogic,
    "function resolveCaptureTaskActionCopy(progress = {})",
    "function resolveSearchFilterDisplayLabel(",
  );
  assert.match(actionCopySection, /phase === "detail_ai_prefilter_start"/);
  assert.match(actionCopySection, /AI 正在判断搜索结果相关性/);
  assert.match(actionCopySection, /phase === "detail_ai_prefilter_done"/);
  assert.match(actionCopySection, /AI 筛选完成/);
  assert.match(actionCopySection, /failedOpenCount/);
  assert.match(actionCopySection, /超时或异常后继续采集/);
  assert.match(actionCopySection, /phase === "detail_item_filtered"/);
  assert.match(actionCopySection, /AI 已跳过/);
});
