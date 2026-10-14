import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";

const root = new URL("../", import.meta.url);
const read = file => readFile(new URL(file, root), "utf8");
const [adapter, css] = await Promise.all([read("sidebar/ui-next.js"), read("sidebar/ui-next.css")]);
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({selector: selector.trim(), body}));
const nextSelectors = rules.flatMap(rule => rule.selector.split(/,\s*(?=\.sv-next)/).map(selector => ({selector: selector.trim(), body: rule.body})));
const hidden = selector => nextSelectors.some(rule => rule.selector === selector && /display\s*:\s*none/.test(rule.body));

test("retired platform entry points are hidden only in the opt-in presentation", () => {
  for (const selector of [
    '.sv-next #dropdownPlatformMenu [data-platform="weibo"]',
    '.sv-next #unsupportedPlatformGrid [data-platform="weibo"]',
    '.sv-next #taskCenterPlatformFilter option[value="weibo"]',
    '.sv-next .sync-history-filter-item[data-platform-filter="weibo"]',
  ]) assert.ok(hidden(selector), selector);
  for (const rule of nextSelectors.filter(rule => /(?:weibo|sv-retired-platform|sv-platform-unavailable)/.test(rule.selector))) {
    assert.match(rule.selector, /^\.sv-next\b/, "classic platform access is outside this UI-only change");
  }
  assert.match(adapter, /for \(const option of all\('#taskCenterPlatformFilter option\[value="weibo"\]'\)\) attr\(option, "hidden", ""\)/);
});

test("retired view reads the snapshot without changing the collector's runtime or registry", () => {
  const toggle = adapter.split("\n").find(line => line.includes('classList.toggle("sv-retired-platform"'));
  assert.ok(toggle);
  for (const [runtime, expected] of [
    [{platform: "weibo", selectedPlatform: "xiaohongshu"}, true],
    [{platform: "xiaohongshu", selectedPlatform: "weibo"}, true],
    [{platform: "xiaohongshu", selectedPlatform: "xiaohongshu"}, false],
    [{platform: "douyin", selectedPlatform: "douyin"}, false],
    [undefined, false],
  ]) {
    const calls = [];
    vm.runInNewContext(toggle, {snapshot: {runtime}, document: {body: {classList: {toggle: (...args) => calls.push(args)}}}});
    assert.deepEqual(calls, [["sv-retired-platform", expected]]);
  }
  assert.doesNotMatch(adapter, /(?:setCurrentRuntime|setCurrentMonitor|setCurrentCapture|saveCaptureSettings|updateMonitor|requestCaptureCancelSignal)\s*\(/);
  assert.doesNotMatch(adapter, /dataset\.(?:pagePlatform|selectedPlatform)\s*=/);
  assert.doesNotMatch(adapter, /classList\.(?:add|remove|toggle)\(\s*["']is-unsupported-platform-cover-visible["']/);
});

test("retired page uses its own notice and leaves settings, tasks and running feedback accessible", () => {
  assert.match(adapter, /element\("section", "sv-platform-unavailable"\)/);
  assert.match(adapter, /目前支持小红书和抖音/);
  const notice = nextSelectors.find(rule => /sv-retired-platform.*\.sv-platform-unavailable$/.test(rule.selector) && /display\s*:\s*block/.test(rule.body));
  assert.ok(notice);
  assert.match(notice.selector, /:not\(\.sv-settings-view\)/);
  assert.match(notice.selector, /:not\(\.sv-tasks-view\)/);
  assert.match(notice.selector, /:not\(\.sv-ideas-view\)/);
  for (const rule of nextSelectors.filter(rule => /sv-retired-platform/.test(rule.selector) && /display\s*:\s*none/.test(rule.body))) {
    assert.doesNotMatch(rule.selector, /#(?:settingsTab|historyTab|progressContainer|debugSessionPanel|btnCancel)\b|\.sv-feedback\b/);
  }
  assert.ok(hidden(".sv-next body.sv-retired-platform #currentPlatformLogo"));
  assert.match(adapter, /replaceCopy\(\$\("#currentPlatformName"\), "切换平台"\)/);
  const hideIdeas = nextSelectors.filter(rule => /sv-retired-platform.*#keywordStrategyModalOverlay$/.test(rule.selector) && /display\s*:\s*none/.test(rule.body));
  for (const rule of hideIdeas) assert.match(rule.selector, /:not\(\.sv-ideas-view\)/, "an existing creative task must keep its dedicated stop surface");
  assert.match(adapter, /strategy\.contains\(event\.target\) && document\.body\.classList\.contains\("sv-retired-platform"\) && !ideasSelected/);
});

test("classic unmount removes only the owned retired-platform class and restores hidden option attributes", () => {
  const unmount = adapter.slice(adapter.indexOf("function unmount()"), adapter.indexOf("const disclosure ="));
  assert.match(unmount, /classList\.remove\([^;]*"sv-retired-platform"/);
  const attr = adapter.match(/const attr = \(node, name, value\) => \{[\s\S]*?\n  \};/)?.[0];
  assert.ok(attr);
  for (const initial of [null, "existing"]) {
    const attributes = new Map(initial === null ? [] : [["hidden", initial]]);
    const node = {
      getAttribute: name => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: name => attributes.delete(name),
    };
    const undo = [];
    vm.runInNewContext(`${attr}\nattr(node, "hidden", "");`, {node, undo});
    assert.equal(attributes.get("hidden"), "");
    undo[0]();
    assert.equal(attributes.get("hidden") ?? null, initial);
  }
});

function guidanceHarness(text, retired = false, buttonAttributes = {}) {
  const start = adapter.indexOf("const guidanceCopies = new Map();");
  const end = adapter.indexOf("\n\n    // Keep the original strategy", start);
  assert.ok(start >= 0 && end > start);
  const node = {textContent: text};
  const platformName = {textContent: "微博"};
  const attributes = new Map(Object.entries(buttonAttributes));
  const platformButton = {
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
  };
  const undo = [];
  const context = vm.createContext({undo, document: {body: {classList: {contains: name => name === "sv-retired-platform" && retired}}}, $: selector => {
    assert.ok(["#monitorTabHint .guidance-content", "#currentPlatformName", "#btnPlatformMenu"].includes(selector), "never rewrite collected content or unrelated labels");
    if (selector === "#btnPlatformMenu") return platformButton;
    return selector === "#currentPlatformName" ? platformName : node;
  }});
  vm.runInContext(adapter.slice(start, end), context);
  return {node, platformName, platformButton, undo, update: () => vm.runInContext("updatePlatformGuidance();", context)};
}

test("retired platform native title, migrated tooltip and accessible label are neutral and reversible", () => {
  const original = {title: "当前页面平台：微博", "data-instant-tooltip": "当前视图：微博", "aria-label": "切换微博平台"};
  const harness = guidanceHarness("已就绪", true, original);
  harness.update();
  harness.update();
  for (const name of Object.keys(original)) assert.equal(harness.platformButton.getAttribute(name), "切换平台");
  harness.undo[0]();
  for (const [name, value] of Object.entries(original)) assert.equal(harness.platformButton.getAttribute(name), value);
});

test("platform tooltip restoration respects late engine writes and never invents missing attributes", () => {
  const harness = guidanceHarness("已就绪", true, {"data-instant-tooltip": "当前页面平台：微博"});
  harness.update();
  assert.equal(harness.platformButton.getAttribute("data-instant-tooltip"), "切换平台");
  assert.equal(harness.platformButton.getAttribute("title"), null);
  assert.equal(harness.platformButton.getAttribute("aria-label"), null);
  harness.platformButton.setAttribute("data-instant-tooltip", "当前页面平台：抖音");
  harness.update();
  harness.undo[0]();
  assert.equal(harness.platformButton.getAttribute("data-instant-tooltip"), "当前页面平台：抖音");
  assert.equal(harness.platformButton.getAttribute("title"), null);
  assert.equal(harness.platformButton.getAttribute("aria-label"), null);
});

test("the retired platform header uses real accessible text and restores classic's original name", () => {
  const harness = guidanceHarness("已就绪", true);
  harness.update();
  assert.equal(harness.platformName.textContent, "切换平台");
  harness.update();
  harness.undo[0]();
  assert.equal(harness.platformName.textContent, "微博", "repeat runtime snapshots must not replace the saved original with presentation text");
});

test("the monitor hint is updated after runtime rendering and reversibly restored for classic", () => {
  const original = "请前往抖音、小红书或微博账号主页后，再选择账号用途";
  const harness = guidanceHarness(original);
  harness.update();
  assert.equal(harness.node.textContent, "请前往小红书或抖音账号主页后，再选择账号用途");
  harness.node.textContent = original;
  harness.update();
  assert.doesNotMatch(harness.node.textContent, /微博/);
  harness.undo[0]();
  assert.equal(harness.node.textContent, original);
  const refresh = adapter.slice(adapter.indexOf("const updateState = () =>"));
  assert.match(refresh, /updatePlatformGuidance\(\)/);
});

test("guidance restoration never overwrites a later engine-owned ready message", () => {
  const harness = guidanceHarness("请前往抖音、小红书或微博账号主页后，再选择账号用途");
  harness.update();
  harness.node.textContent = "已就绪：当前是小红书账号主页";
  harness.undo[0]();
  assert.equal(harness.node.textContent, "已就绪：当前是小红书账号主页");
});

test("historical renderers, platform registry, capture engine and shared state stay byte-identical to HEAD", async () => {
  for (const file of ["sidebar/sidebar.html", "sidebar/sidebar-ui.js", "sidebar/sidebar-logic.js", "sidebar/state.js", "sidebar/task-center-ui.js", "sidebar/renderers/weibo.js", "utils/platform/registry.js"]) {
    const baseline = execFileSync("git", ["show", `HEAD:${file}`], {cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024});
    const hash = value => createHash("sha256").update(value).digest("hex");
    assert.equal(hash(await read(file)), hash(baseline), file);
  }
});
