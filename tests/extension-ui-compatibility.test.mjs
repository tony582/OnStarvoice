import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {readMode, saveMode, UI_MODE_KEY, initializeMode} from "../sidebar/ui-mode.js";
import {presentationStatus} from "../sidebar/ui-next.js";
const read = file => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("the default and every unknown preference select the existing UI", () => {
  for (const value of [null, undefined, "", "legacy", "true", "2", "NEXT", "unsupported"]) assert.equal(readMode({getItem: () => value}), "legacy");
  assert.equal(readMode({getItem: () => "next"}), "next");
  assert.equal(readMode({getItem() {throw new Error("storage blocked");}}), "legacy");
});
test("UI preference writes only its own per-profile key and tolerates blocked storage", () => {
  const writes = [];
  assert.equal(saveMode({setItem: (...args) => writes.push(args)}, "next"), true);
  assert.equal(saveMode({setItem: (...args) => writes.push(args)}, "garbage"), true);
  assert.deepEqual(writes, [[UI_MODE_KEY, "next"], [UI_MODE_KEY, "legacy"]]);
  assert.equal(saveMode({setItem() {throw new Error("quota");}}, "next"), false);
  assert.equal(saveMode(undefined, "next"), false);
});
test("header status is derived from existing state and never invents a heartbeat", () => {
  assert.deepEqual(presentationStatus(), {text: "连接中", state: "waiting"});
  assert.equal(presentationStatus({runtime: {}}).text, "已就绪");
  assert.equal(presentationStatus({runtime: {}, capture: {status: "capturing"}}).text, "采集中");
  assert.equal(presentationStatus({runtime: {captureDebugSession: {state: "attached"}}}).text, "采集中");
  assert.equal(presentationStatus({runtime: {}, sync: {status: "syncing"}}).text, "同步中");
});
test("compact 44px header keeps live status left and the original platform control right without duplicate branding", async () => {
  const [adapter, css] = await Promise.all([read("sidebar/ui-next.js"), read("sidebar/ui-next.css")]);
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, declarations]) => ({selector: selector.trim(), declarations}));
  assert.doesNotMatch(adapter, /["']sv-brand["']/);
  assert.doesNotMatch(css, /\.sv-brand\b/);
  assert.match(adapter, /status\.setAttribute\("aria-live", "polite"\)/);
  const headers = rules.filter(rule => rule.selector === ".sv-next .header");
  assert.ok(headers.length > 0);
  for (const {declarations} of headers) {
    assert.match(declarations, /(?:^|;)\s*padding:\s*5px\s+\d+px\s*(?:;|$)/, "wide and narrow header must keep 5px vertical padding");
    assert.doesNotMatch(declarations, /overflow(?:-y)?:\s*hidden/, "platform menu must not be clipped by its header");
  }
  assert.ok(rules.some(({selector, declarations}) => selector === ".sv-next .header-top" && /min-height:\s*34px/.test(declarations)), "34px control row plus 5px top and bottom equals 44px");
  const status = rules.find(rule => rule.selector === ".sv-next .sv-status");
  assert.ok(status);
  assert.doesNotMatch(status.declarations, /margin(?:-left)?:[^;]*auto/, "status must not be pushed away from the left edge");
  assert.match(status.declarations, /white-space:\s*nowrap/);
  const platform = rules.find(rule => rule.selector === ".sv-next .platform-switcher");
  assert.ok(platform);
  assert.match(platform.declarations, /margin:\s*0\s+0\s+0\s+auto|margin-left:\s*auto/);
  assert.match(css, /\.sv-next \.platform-menu \{[^}]*right:\s*0/);
});
test("the presentation modules cannot dispatch, navigate, poll or write business state", async () => {
  const files = await Promise.all([read("sidebar/ui-next.js"), read("sidebar/ui-mode.js")]);
  for (const file of files) {
    const source = file.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(source, /\b(setInterval|setTimeout|requestAnimationFrame|fetch|XMLHttpRequest|WebSocket|MutationObserver)\s*\(/);
    assert.doesNotMatch(source, /chrome\.(?:tabs|scripting|debugger|alarms|storage)|runtime\.(?:reload|sendMessage|connect)/);
    assert.doesNotMatch(source, /location\.(?:reload|assign|replace)|window\.open\s*\(/);
    assert.doesNotMatch(source, /import\s*(?:\([^)]*)?["'][^"']*(?:capture-sync|api\.js|sidebar-logic)/);
  }
  assert.doesNotMatch(files[0], /\b(?:setCurrentCapture|setCurrentRuntime|setCurrentAuth|setCurrentSync|updateCapture|resetCapture)\s*\(/);
});
test("CSS is scoped and preserves running geometry except minimized dock clearance", async () => {
  const css = await read("sidebar/ui-next.css");
  assert.doesNotMatch(css, /@import|@font-face|backdrop-filter\s*:\s*(?!none)[a-z]|@keyframes|animation\s*:/);
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!match[1].includes(".debug-session")) continue;
    if (match[1].includes('#progressContainer[style*="display: block"]')) {
      assert.match(match[1], /\.sv-next body:has\([\s\S]*\) \.debug-session-dock\s*$/);
      assert.match(match[2], /position: static; flex-shrink: 0; align-self: flex-end;/);
      assert.doesNotMatch(match[1], /debug-session-panel/);
      continue;
    }
    for (const rule of match[2].split(";").map(value => value.trim()).filter(Boolean)) {
      assert.match(rule, /^(?:color|border-color|background)\s*:|^line-height:\s*normal$|^bottom:\s*74px$/, rule);
      if (rule.startsWith("bottom:")) assert.match(match[1], /\.debug-session-dock\s*$/);
    }
  }
  for (const selector of css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map(chunk => chunk.split("{").at(-2)).filter(Boolean)) {
    if (selector.trim().startsWith("@")) continue;
    assert.match(selector.trim(), /^(?:html)?\.sv-next/, selector);
  }
});
test("legacy entry keeps its sole engine and renderer; new styles load only on opt-in", async () => {
  const html = await read("sidebar/sidebar.html");
  assert.equal((html.match(/src="sidebar-logic\.js"/g) || []).length, 1);
  assert.equal((html.match(/src="sidebar-ui\.js"/g) || []).length, 1);
  assert.equal((html.match(/src="ui-mode\.js"/g) || []).length, 1);
  assert.doesNotMatch(html, /href="ui-next\.css"|class="sv-next"/);
  const manifest = JSON.parse(await read("manifest.json"));
  assert.equal(manifest.side_panel.default_path, "sidebar/sidebar.html");
});
test("creative and monitor navigation is presentation-only and restores the classic labels", async () => {
  const adapter = await read("sidebar/ui-next.js");
  const css = await read("sidebar/ui-next.css");
  const html = await read("sidebar/sidebar.html");
  assert.match(adapter, /const CAPTURE_TABS = new Set\(\["noteTab", "bloggerTab", "searchTab"\]\)/);
  assert.match(adapter, /move\(strategy, nav\)/);
  assert.match(adapter, /move\(ideas, \$\("#mainTabContent"\)\)/);
  assert.match(adapter, /copy\(\$\("#keywordStrategyModalTitle"\), "创意"\)/);
  assert.match(adapter, /active === "settingsTab" \|\| active === "monitorTab" \? "settings"/);
  assert.match(css, /\.sv-next #mainTabNav \[data-target="monitorTab"\] \{ display: none; \}/);
  assert.match(html, /id="btnToggleKeywordStrategy"\s+title="赛道策略"/);
  assert.doesNotMatch(html, /sv-top-nav|sv-settings-entry|内容创意/);
});
test("three capture tabs and four bottom destinations replace the duplicate data view", async () => {
  const adapter = await read("sidebar/ui-next.js");
  const css = await read("sidebar/ui-next.css");
  assert.match(adapter, /\[\["capture", "采集"\], \["tasks", "任务"\], \["ideas", "创意"\], \["settings", "设置"\]\]/);
  assert.match(adapter, /const btn = key === "ideas" \? strategy : element/);
  assert.match(adapter, /attr\(strategy, "aria-current", null\)/);
  assert.doesNotMatch(adapter, /dataView|sv-data-view|sv-pool-scope|strategy\.disabled\s*=/);
  assert.doesNotMatch(css, /sv-data-view|sv-pool-scope/);
  assert.match(css, /\.sv-next \.sv-top-nav \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.sv-next \.sv-bottom-nav \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
});
test("source and execution choices share equal segments without replacing native controls", async () => {
  const css = await read("sidebar/ui-next.css");
  const adapter = await read("sidebar/ui-next.js");
  assert.match(css, /:is\(\.sv-source-options, \.search-execution-tabs\) \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /label:has\(input:focus-visible\), \.sv-next \.search-execution-tab:focus-visible/);
  assert.match(css, /label:has\(input:disabled\), \.sv-next \.search-execution-tab:disabled/);
  const radioStyle = css.match(/\.sv-next \.sv-source-options input \{([^}]+)\}/)?.[1];
  assert.ok(radioStyle);
  assert.doesNotMatch(radioStyle, /display:\s*none|visibility:\s*hidden/);
  assert.match(adapter, /radio\.type = "radio"/);
  assert.match(adapter, /sourceControl\.click\(\)/);
});
test("settings reuses original menu actions and the original platform control moves right", async () => {
  const adapter = await read("sidebar/ui-next.js");
  const css = await read("sidebar/ui-next.css");
  assert.match(adapter, /move\(\$\("\.platform-switcher"\), \$\("\.header-top"\), \$\("\.header-actions"\)\)/);
  assert.match(adapter, /attr\(\$\("\.header-actions"\), "hidden", ""\)/);
  assert.match(adapter, /all\("#dropdownMoreMenu > a\.dropdown-item"\)/);
  assert.match(adapter, /move\(anchor, acquire \? \$\("#uiAuthCard"\) : help\)/);
  assert.match(adapter, /for \(const id of \["menuBtnCheckUpdate", "menuBtnInterfaceMode"\]\)/);
  assert.match(adapter, /move\(button, appOptions\)/);
  assert.doesNotMatch(adapter, /https:\/\/voice\.minilife\.online|sv-help-links/);
  assert.match(css, /\.sv-next \.header-actions \{ display: none; \}/);
  assert.match(css, /\.sv-next \.platform-menu \{ left: auto; right: 0;/);
  assert.doesNotMatch(css, /platform-trigger-name\s*\{[^}]*display:\s*none/);
});
test("keyword boundaries are scoped styles and do not rebuild the result pool", async () => {
  const adapter = await read("sidebar/ui-next.js");
  const css = await read("sidebar/ui-next.css");
  assert.match(css, /data-pool-group\^="keyword:"\]\s*\{[^}]*border: 1px solid #d6e2f2/);
  assert.match(css, /\.pool-aggregate-label\s*\{[^}]*white-space: normal; overflow-wrap: anywhere/);
  assert.match(css, /data-pool-group\^="keyword:"\] > \.pool-aggregate-toggle:focus-visible/);
  assert.doesNotMatch(adapter, /renderKeywordTabCards|dataPoolGroupCollapsedState|setCurrentDataPool|\.innerHTML\s*=/);
});
test("all original collection options and result actions are still declared once", async () => {
  const html = await read("sidebar/sidebar.html");
  for (const id of ["btnCaptureNote", "btnCaptureBlogger", "btnCaptureSearch", "btnOpenBatchNote", "btnOpenBatchBlogger", "btnToggleKeywordStrategy", "checkboxCaptureComments", "checkboxCaptureBloggerMetrics", "chkSearchBatchMode", "textareaSearchBatchKeywords", "inputKeywordMaxDetectedItems", "inputKeywordMinLikes", "inputBloggerKeywordFilter", "selectSearchSort", "selectSearchPublishTime", "selectSearchContentType", "selectSearchScope", "selectSearchDistance", "selectSearchVideoDuration", "btnSaveSearchKeywordPlan", "btnClearPool", "btnExport", "btnSyncAll", "btnVerify", "btnCodeVisibility", "btnMonitorAddCurrent", "btnMonitorRunNow", "btnDebugSessionStop", "btnDebugSessionMinimize", "btnRetryRecovery", "btnCancel", "menuBtnCheckUpdate"]) assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
});
test("batch entry moves the original URL controls only and accurately labels blogger links", async () => {
  const adapter = await read("sidebar/ui-next.js");
  const css = await read("sidebar/ui-next.css");
  assert.match(adapter, /add\(\$\("#searchManualActionRow"\), element\("details", "sv-batch-entry"\)\)/);
  assert.match(adapter, /\[\["btnOpenBatchNote", "批量采集作品"\], \["btnOpenBatchBlogger", "批量采集博主"\]\]/);
  assert.match(adapter, /move\(button, batchOptions\)/);
  assert.match(adapter, /copy\(bloggerLabelText, "博主主页链接 "\)/);
  assert.match(adapter, /不支持仅填写博主 ID。采集条件沿用博主页设置。/);
  assert.match(adapter, /listen\(document, "starvoice:sidebar-tab", closeBatchOptions\)/);
  assert.match(adapter, /window\.activateSidebarTab\?\.\(button\.id === "btnOpenBatchNote" \? "noteTab" : "bloggerTab"\)/);
  assert.doesNotMatch(adapter, /batchCaptureByUrls|handleRunBatch|btnRunBatch\w+["']\)\.click|bloggerInput\.value\s*=/);
  const menu = css.match(/\.sv-next \.sv-batch-options \{([^}]+)\}/)?.[1];
  assert.ok(menu);
  assert.match(menu, /position:\s*absolute/);
  assert.match(menu, /right:\s*0/);
  assert.match(menu, /top:\s*calc\(100% \+ 8px\)/, "in-flow start row opens the batch choices below it");
  assert.doesNotMatch(menu, /bottom:\s*(?!auto\b)[^;]+/);
  assert.match(menu, /z-index:\s*[1-9]\d*\s*(?:;|$)/);
  assert.match(css, /\.sv-next \.sv-batch-entry \{[^}]*position:\s*relative/, "batch choices stay anchored to their original search-row entry");
});
test("an absent menu or denied localStorage cannot prevent classic UI startup", () => {
  assert.equal(initializeMode({document: {getElementById: () => null}, window: {}}), undefined);
  let loads = 0;
  const menu = {append() {}};
  const button = {setAttribute() {}, addEventListener() {}};
  const document = {getElementById: () => menu, createElement: () => button};
  const window = {get localStorage() {throw new Error("denied");}};
  const controller = initializeMode({document, window, load: () => {loads++;}});
  assert.equal(controller.getMode(), "legacy");
  assert.equal(loads, 0);
  assert.equal(button.textContent, "试用新版界面");
});

for (const failure of ["stylesheet", "mount"]) test(`${failure} failure keeps the classic UI and clears a saved opt-in`, async () => {
  const removals = [], notices = [], writes = [];
  const create = tag => ({tag, setAttribute() {}, addEventListener() {}, remove() {removals.push(tag);}});
  const menu = {...create("menu"), append() {}, classList: {remove() {}}};
  const trigger = {...create("button"), focus() {}};
  const document = {
    getElementById: id => id === "dropdownMoreMenu" ? menu : trigger,
    createElement: create,
    documentElement: {classList: {remove() {}}},
    head: {append(link) {queueMicrotask(() => failure === "stylesheet" ? link.onerror() : link.onload());}},
  };
  const window = {localStorage: {getItem: () => "legacy", setItem: (...args) => writes.push(args)}, showMessage: text => notices.push(text)};
  const controller = initializeMode({document, window, load: async () => ({mountNextUI() {throw new Error("fixture mount failure");}})});
  const originalWarn = console.warn;
  console.warn = () => {};
  try { assert.equal(await controller.setMode("next"), false); }
  finally { console.warn = originalWarn; }
  assert.equal(controller.getMode(), "legacy");
  assert.ok(removals.includes("link"));
  assert.deepEqual(writes.at(-1), [UI_MODE_KEY, "legacy"]);
  assert.match(notices[0], /已保留经典界面/);
});

test("successful mode changes notify result renderers only after the root mode changes", async () => {
  const events = [], writes = [], classes = new Set();
  let mounts = 0, unmounts = 0;
  const create = () => ({setAttribute() {}, addEventListener() {}, remove() {}, focus() {}});
  const menu = {...create(), append() {}, classList: {remove() {}}};
  const document = {
    getElementById: () => menu, createElement: create,
    documentElement: {classList: {remove: key => classes.delete(key)}},
    head: {append(link) {queueMicrotask(() => link.onload());}},
  };
  const window = {
    Event, localStorage: {getItem: () => "legacy", setItem: (...args) => writes.push(args)},
    dispatchEvent: event => events.push({type:event.type,next:classes.has("sv-next")}),
  };
  const controller=initializeMode({document,window,load:async()=>({mountNextUI(){
    mounts++;classes.add("sv-next");return {unmount(){unmounts++;classes.delete("sv-next");}};
  }})});
  assert.equal(await controller.setMode("next"),true);
  assert.equal(await controller.setMode("next"),true);
  assert.equal(events.length,1,"already active must not duplicate events or subscriptions");
  assert.equal(await controller.setMode("legacy"),true);
  assert.equal(await controller.setMode("next"),true);
  assert.deepEqual(events,[{type:"starvoice:presentation-mode",next:true},{type:"starvoice:presentation-mode",next:false},{type:"starvoice:presentation-mode",next:true}]);
  assert.equal(mounts,2);assert.equal(unmounts,1);
  assert.deepEqual(writes.map(entry=>entry[1]),["next","legacy","next"]);
});
