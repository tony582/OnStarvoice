import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";

const root = new URL("../", import.meta.url);
const [css, rendererSource] = await Promise.all([
  readFile(new URL("sidebar/ui-next.css", root), "utf8"),
  readFile(new URL("sidebar/sidebar-ui.js", root), "utf8"),
]);
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({selector: selector.trim(), body}));
function declarationsFor(selector) {
  const matching = rules.filter(rule => rule.selector.split(",").some(part => part.trim().endsWith(selector)));
  assert.ok(matching.length, `new UI needs an explicit ${selector} rule`);
  for (const rule of matching) {
    for (const part of rule.selector.split(",")) assert.match(part.trim(), /^\.sv-next\b/, "classic CSS must remain untouched");
  }
  return Object.fromEntries(matching.flatMap(({body}) => body.split(";").map(value => {
    const colon = value.indexOf(":");
    return colon < 0 ? null : [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
  }).filter(Boolean)));
}

test("monitor list uses one outer region and flat account rows, not nested cards", () => {
  const section = declarationsFor(".monitor-section");
  assert.equal(section.border, "0");
  assert.match(section["border-top"], /^1px solid /);
  assert.equal(section["border-radius"], "0");
  assert.equal(section.background, "transparent");
  assert.equal(section.padding, "14px 0 0");
  assert.equal(declarationsFor(".monitor-list").gap, "0");
  const item = declarationsFor(".monitor-item");
  assert.equal(item.border, "0");
  assert.match(item["border-bottom"], /^1px solid /);
  assert.equal(item["border-radius"], "0");
  assert.equal(item.background, "transparent");
  assert.equal(item.padding, "14px 0");
  assert.equal(declarationsFor(".monitor-item:last-child")["border-bottom"], "0");
});

test("monitor dates remain readable metadata without the old dashed inner box", () => {
  const grid = declarationsFor(".monitor-item-grid");
  assert.equal(grid.border, "0");
  assert.equal(grid.background, "transparent");
  assert.equal(grid.padding, "0");
  assert.match(grid["grid-template-columns"], /repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.equal(declarationsFor(".monitor-item-title")["font-size"], "13px");
  assert.equal(declarationsFor(".monitor-item-title")["font-weight"], "600");
  assert.equal(declarationsFor(".monitor-item-stat-label")["font-size"], "12px");
  const value = declarationsFor(".monitor-item-stat-value");
  assert.equal(value["font-size"], "12px");
  assert.equal(value["overflow-wrap"], "anywhere");
});

test("monitor actions show their existing labels without replacing the original controls", () => {
  const labels = rules.filter(rule => /\.monitor-item-actions[\s\S]*\.icon-btn(?:\[title\])?::after/.test(rule.selector));
  const migrated = labels.find(rule => /\.icon-btn::after$/.test(rule.selector));
  const beforeMigration = labels.find(rule => /\.icon-btn\[title\]::after$/.test(rule.selector));
  assert.match(migrated?.body || "", /content\s*:\s*attr\(data-instant-tooltip\)/);
  assert.match(beforeMigration?.body || "", /content\s*:\s*attr\(title\)/);
  for (const {selector} of labels) assert.match(selector, /^\.sv-next\b/);
});

test("original tooltip migration keeps monitor action labels available before and after title removal", () => {
  const start = rendererSource.indexOf("const migrateTitleForElement = (element) =>");
  const end = rendererSource.indexOf("const migrateTitleAttrs =", start);
  assert.ok(start >= 0 && end > start);
  class Element {
    constructor(label) { this.attributes = new Map([["title", label]]); this.textContent = ""; }
    hasAttribute(name) { return this.attributes.has(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    matches() { return true; }
  }
  for (const label of ["暂停", "恢复", "删除"]) {
    const element = new Element(label);
    const context = vm.createContext({Element, element, tooltipEl: null, INSTANT_TOOLTIP_TEXT_ATTR: "data-instant-tooltip"});
    const visibleLabel = node => node.getAttribute(node.hasAttribute("title") ? "title" : "data-instant-tooltip");
    assert.equal(visibleLabel(element), label);
    vm.runInContext(`${rendererSource.slice(start, end)}\nmigrateTitleForElement(element);`, context);
    assert.equal(element.hasAttribute("title"), false);
    assert.equal(visibleLabel(element), label);
    assert.equal(element.getAttribute("aria-label"), label);
  }
});

function originalRender(item) {
  const start = rendererSource.indexOf("function renderMonitorSubscriptionCard(");
  const end = rendererSource.indexOf("function formatMonitorFrequency(", start);
  assert.ok(start >= 0 && end > start);
  // Only the pure original renderer runs. No sidebar initialization, storage,
  // listener, network, capture or action handler is imported or executed.
  const context = vm.createContext({
    escapeHtml: value => String(value ?? "").replace(/[&<>\"]/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"}[char])),
    getMonitorStatusClass: status => status === "active" ? "is-active" : "is-insufficient",
    getMonitorStatusLabel: status => status === "active" ? "启用中" : "配额不足",
    resolveMonitorSubscriptionDisplayName: row => row.displayName,
    formatHistoryPlatform: () => "小红书",
    resolveMonitorSubscriptionSubjectType: row => row.subjectType,
    resolveMonitorSubjectUi: type => ({label: type === "official" ? "官方账号" : "关注博主"}),
    formatMonitorDateTime: value => value || "-",
    formatRichMessageHtml: value => value,
  });
  vm.runInContext(rendererSource.slice(start, end), context);
  return context.renderMonitorSubscriptionCard(item, {items: [item]});
}

for (const [status, subjectType, label, next] of [
  ["active", "creator", "暂停", "paused"],
  ["paused_insufficient_balance", "official", "恢复", "active"],
]) {
  test(`original monitor renderer keeps every field and action for ${status}`, () => {
    const html = originalRender({
      id: "fixture-monitor-1", displayName: "监控示例账号", platform: "xiaohongshu", status, subjectType,
      profileUrl: "https://www.xiaohongshu.com/user/profile/demo-monitor-1",
      lastHitAt: "last-hit", lastRunAt: "last-run", nextRunAt: "next-run", createdAt: "created-at",
    });
    for (const field of ["近期命中", "近期执行", "下次执行", "创建时间", "last-hit", "last-run", "next-run", "created-at"]) assert.ok(html.includes(field), `${field} stays visible`);
    assert.equal((html.match(/class="monitor-item-stat"/g) || []).length, 4);
    assert.match(html, /class="monitor-item-title-link" href="https:\/\/www\.xiaohongshu\.com\/user\/profile\/demo-monitor-1"/);
    assert.match(html, new RegExp(`class="icon-btn btn-monitor-toggle"[^>]*data-id="fixture-monitor-1"[^>]*data-next-status="${next}"[^>]*title="${label}"`));
    assert.match(html, /class="icon-btn btn-monitor-delete"[^>]*data-id="fixture-monitor-1"[^>]*title="删除"/);
    if (status === "paused_insufficient_balance") assert.match(html, /monitor-item-hint[\s\S]*配额不足暂停/);
  });
}

test("the original monitor renderer and sidebar event wiring remain byte-identical to HEAD", () => {
  const baseline = execFileSync("git", ["show", "HEAD:sidebar/sidebar-ui.js"], {cwd: root, encoding: "utf8"});
  const hash = source => createHash("sha256").update(source).digest("hex");
  assert.equal(hash(rendererSource), hash(baseline));
});
