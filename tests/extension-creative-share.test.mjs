import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {
  buildCreativeShareReport,
  buildCreativeShareText,
  layoutCreativeShareReport,
  openCreativeSharePreview,
} from "../sidebar/creative-share.js";

const opportunity = {
  keyword: "安吉星", platform: "xiaohongshu", generatedAt: "2026-10-14T01:25:00Z",
  distributionSummary: "互动集中在少数真实使用经历，官方活动样本互动较少。",
  ruleMetrics: {sampleCount: 80, detailSampleCount: 12, heatLevel: "high", highBandStart: 1, highBandEnd: 11, highBandCount: 11, cliffDropRatio: .84, highBandAvgLikes: 4280, medianLikes: 8, p80Likes: 68, p90Likes: 80, maxLikes: 19000, top5AvgLikes: 8000, top10AvgLikes: 4600, midBandAvgLikes: 120, cliffIndex: 11},
  analysisSource: "llm_with_rule_metrics",
  coreWinningSubtopics: ["紧急救援", "服务续费"],
  hotTopicDirections: [{name: "紧急救援经历", sampleCount: 11, shareRatio: .1375, avgLikes: 4280, bandPresence: "high_mid", userIntent: "关心服务能否及时响应", whyItWorks: "具体经历比功能清单更容易讨论", organicViability: "medium", organicNote: "需结合真实场景复核", representativeTitles: ["夜间故障求助记录"]}],
  recommendedAngles: [{title: "一次救援的完整经过", audiencePainPoint: "等待时长不明确", formatSuggestion: "时间线", executionHint: "交代联系时间与到达时间"}],
  _listItems: [{title: "夜间故障求助记录", author: "车主甲", likes: 321, collects: 20, comments: 0, url: "https://example.test/note/a"}],
};
const benchmark = {
  keyword: "安吉星", platformLabel: "小红书", generatedAt: 1791941100000,
  sampleCount: 20, candidateCount: 6, minOccurrence: 2,
  candidates: Array.from({length: 6}, (_, i) => ({
    authorName: `候选作者${i + 1}`, authorProfileUrl: `https://example.test/user/${i + 1}`,
    occurrenceCount: 3, maxLikes: 6442, averageLikes: 4216, averageCollects: 12, averageComments: 0,
    avgEngagement: 4228, totalEngagement: 12684,
    profile: {bloggerName: `账号${i + 1}`, followersCount: 900, likedAndCollectedCount: 24000, description: "记录日常用车"},
    analysis: {recommendationReason: "三个样本都围绕日常用车", focusAssessment: "需要打开主页确认持续产出", growthPotential: "medium", tags: ["使用经历", "长期记录"]},
    topItems: [{title: `代表作品${i + 1}`, likes: 100, collects: 9, comments: 0, url: `https://example.test/note/${i + 1}`}],
  })),
};
const longtail = {
  seedKeyword: "安吉星", platformLabel: "小红书", ts: "2026-10-14T01:25:00Z", totalKeywords: 18,
  summary: "用户在续费前关注服务内容和实际价格。",
  categories: [{id: "renewal", name: "续费决策", icon: "🤔", insight: "用户会比较价格和已有替代方式", keywords: ["安吉星续费价格", "安吉星免费功能"], sampleKeyword: "安吉星续费价格", samples: [{title: "续费时是否保留免费功能", author: "车主乙", likes: 0, url: "https://example.test/note/renewal"}]}],
};
const freeze = object => { Object.freeze(object); Object.values(object).forEach(value => { if (value && typeof value === "object") freeze(value); }); return object; };

test("all reports are deterministic read-only models with actual metadata", () => {
  for (const [kind, snapshot] of Object.entries({opportunity, benchmark, longtail})) {
    const copy = structuredClone(snapshot);
    const report = buildCreativeShareReport(kind, freeze(copy));
    assert.equal(report.keyword, "安吉星");
    assert.equal(report.platform, "小红书");
    assert.match(report.generatedAt, /北京时间/);
    assert.deepEqual(copy, snapshot);
    assert.deepEqual(buildCreativeShareReport(kind, copy), report);
  }
  assert.equal(buildCreativeShareReport("opportunity", {}).generatedAt, "未记录");
  assert.equal(buildCreativeShareReport("opportunity", {}).platform, "平台未记录");
  assert.throws(() => buildCreativeShareReport("unknown", {}), /未知/);
});

test("text uses every paragraph of the same model without a second copy template", () => {
  for (const [kind, snapshot] of Object.entries({opportunity, benchmark, longtail})) {
    const report = buildCreativeShareReport(kind, snapshot);
    const result = buildCreativeShareText(kind, snapshot);
    let position = 0;
    for (const block of report.blocks) {
      const next = result.indexOf(block.text, position);
      assert.ok(next >= position, `missing or reordered ${kind} paragraph: ${block.text}`);
      position = next + block.text.length;
    }
    assert.ok(result.startsWith(`${report.keyword}｜${report.title}`));
    assert.ok(result.endsWith("StarVoice 星语"));
    assert.doesNotMatch(result, /社媒虾|【核心爆款|❤️|🤔/);
  }
});

test("opportunity preserves rule metrics, meaningful direction fields, angles and source URLs", () => {
  const result = buildCreativeShareText("opportunity", opportunity);
  for (const expected of ["80 条", "12 条", "84%", "4,280", "P80 点赞：68", "断层位置（原始索引）：11", "紧急救援", "关心服务能否及时响应", "具体经历比功能清单更容易讨论", "需结合真实场景复核", "高赞区与中赞区", "14%", "夜间故障求助记录", "https://example.test/note/a", "车主甲", "评论 0", "一次救援的完整经过", "等待时长不明确", "时间线", "交代联系时间与到达时间"]) assert.ok(result.includes(expected), expected);
  assert.match(result, /不代表平台全量表现/);
});

test("benchmark shares every candidate instead of silently cutting after four or five", () => {
  const result = buildCreativeShareText("benchmark", benchmark);
  for (let i = 1; i <= 6; i++) {
    assert.ok(result.includes(`账号${i}`));
    assert.ok(result.includes(`https://example.test/user/${i}`));
    assert.ok(result.includes(`https://example.test/note/${i}`));
  }
  for (const expected of ["收藏 9", "平均评论：0", "粉丝：900", "主页累计赞藏：24,000", "需要打开主页确认持续产出", "长期记录", "记录日常用车"]) assert.ok(result.includes(expected), expected);
});

test("longtail includes the complete keyword list, category evidence and real samples", () => {
  const result = buildCreativeShareText("longtail", longtail);
  for (const expected of ["安吉星免费功能", "用户会比较价格", "样本来源词：安吉星续费价格", "续费时是否保留免费功能", "车主乙", "点赞 0", "https://example.test/note/renewal"]) assert.ok(result.includes(expected), expected);
  assert.match(result, /不代表搜索量或真实需求占比/);
});

test("unknown numbers remain unknown; valid zero is never treated as missing", () => {
  const unknown = buildCreativeShareText("opportunity", {keyword: "test", ruleMetrics: {}});
  assert.match(unknown, /搜索样本 未记录 条/);
  assert.match(unknown, /热度：未记录/);
  const zero = buildCreativeShareText("opportunity", {ruleMetrics: {sampleCount: 0, detailSampleCount: 0, cliffDropRatio: 0, medianLikes: 0}});
  assert.match(zero, /搜索样本 0 条/);
  assert.match(zero, /断层跌幅：0%/);
  assert.match(zero, /中位点赞：0/);
  const unknownProfile = buildCreativeShareText("benchmark", {candidates: [{profile: {followersCount: 0, likedAndCollectedCount: 0}}]});
  assert.match(unknownProfile, /粉丝：未确认/);
  const recordedProfile = buildCreativeShareText("benchmark", {candidates: [{profile: {followersCount: 0, likedAndCollectedCount: 0, captureStatus: "done"}}]});
  assert.match(recordedProfile, /粉丝：0/);
});

test("source aliases are preserved and a metadata-only match cannot hide a later source URL", () => {
  const snapshot = structuredClone(opportunity);
  snapshot._listItems = [{title: "夜间故障求助记录"}];
  snapshot._representativeSamples = [{title: "夜间故障求助记录", detailPageUrl: "https://example.test/detail/real"}];
  assert.match(buildCreativeShareText("opportunity", snapshot), /https:\/\/example\.test\/detail\/real/);
  assert.doesNotThrow(() => buildCreativeShareReport("opportunity", {hotTopicDirections: [null], recommendedAngles: [null]}));
  assert.doesNotThrow(() => buildCreativeShareReport("benchmark", {candidates: [null]}));
  assert.doesNotThrow(() => buildCreativeShareReport("longtail", {categories: [null]}));
});

const measure = (text, style) => Array.from(text).length * style.size * .65;
test("pagination wraps CJK, long URLs and multiline text without deleting any character", () => {
  const report = buildCreativeShareReport("longtail", longtail);
  report.blocks.push({role: "body", text: `${"长标题与完整证据".repeat(120)}\n\nhttps://example.test/${"unbroken".repeat(120)}`});
  const layout = layoutCreativeShareReport(report, measure);
  assert.ok(layout.pages.length > 1);
  for (let i = 0; i < report.blocks.length; i++) {
    const lines = layout.pages.flat().filter(line => line.blockIndex === i);
    assert.equal(lines.map(line => line.text).join(""), report.blocks[i].text.replaceAll("\n", ""));
    for (const line of lines) {
      assert.ok(line.y >= 164);
      assert.ok(line.y + line.height <= 954);
      assert.ok(measure(line.text, line) <= 640);
    }
  }
});

test("image metrics use measured two-column rows without changing or dropping report blocks", () => {
  const report = buildCreativeShareReport("opportunity", opportunity);
  const before = structuredClone(report);
  const layout = layoutCreativeShareReport(report, measure);
  const rows = layout.pages.flat().filter(line => line.metricColumn !== undefined);
  assert.ok(rows.some(line => line.metricColumn === 0));
  assert.ok(rows.some(line => line.metricColumn === 1));
  for (const line of rows) {
    assert.ok(measure(line.text, line) <= 308);
    assert.ok(line.metricRowBottom <= 954);
    assert.ok([40, 372].includes(line.x));
  }
  report.blocks.forEach((block, i) => {
    const reconstructed = layout.pages.flat().filter(line => line.blockIndex === i).map(line => line.text).join("");
    assert.equal(reconstructed, block.text.replaceAll("\n", ""));
  });
  assert.deepEqual(report, before);
  assert.ok(layout.pages.flat().some(line => line.role === "body" && line.size === 18));
  assert.ok(layout.pages.flat().some(line => line.role === "heading" && line.size === 22));
  assert.ok(layout.pages.flat().some(line => line.role === "meta" && line.size === 16));
});

test("only the final page tightens to its content, with a 420px floor and a separated footer", () => {
  const report = buildCreativeShareReport("longtail", longtail);
  // One 30-line paragraph puts 27 lines on page 1 and exactly 3 on the final page.
  report.blocks = [{role: "body", text: Array.from({length: 30}, (_, i) => `完整内容第 ${i + 1} 行`).join("\n")}];
  const layout = layoutCreativeShareReport(report, measure);
  assert.equal(layout.pages.length, 2);
  assert.equal(layout.pages[1].length, 3);
  assert.deepEqual(layout.pageHeights, [1020, 420]);
  for (const [index, lines] of layout.pages.entries()) {
    const footerTop = layout.pageHeights[index] - 47;
    const contentBottom = Math.max(...lines.map(line => Math.max(line.y + line.height, line.metricRowBottom || 0)));
    assert.ok(contentBottom < footerTop, "footer divider must stay below all report content");
    assert.ok(layout.pageHeights[index] >= 420 && layout.pageHeights[index] <= 1020);
  }
});

function browser({failBlob = false, dpr = 3} = {}) {
  const calls = {blobs: 0, downloads: [], clipboard: [], urls: new Map(), revoked: [], canvases: [], messages: [], text: []};
  class Element {
    constructor(tag, ownerDocument) { this.tagName = tag; this.ownerDocument = ownerDocument; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.style = {}; this.hidden = false; this.disabled = false; this.textContent = ""; }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
    removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== callback)); }
    emit(type, properties = {}) { const event = {target: this, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...properties}; for (const fn of this.listeners.get(type) || []) fn(event); return event; }
    click() { if (this.disabled) return; if (this.tagName === "a") calls.downloads.push({href: this.href, filename: this.download}); else this.emit("click"); }
    focus() { this.ownerDocument.activeElement = this; }
    get isConnected() { return this === this.ownerDocument.body || !!this.parentElement?.isConnected; }
    remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null; } }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(selector.split(",").map(x => x.trim()).includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]); }
  }
  const document = new Element("document"); document.ownerDocument = document;
  document.createElement = tag => {
    const element = new Element(tag, document);
    if (tag === "canvas") {
      element.getContext = () => ({font: "", measureText: value => ({width: Array.from(value).length * 9}), scale() {}, fillRect() {}, fillText(value, x, y) { calls.text.push({value, x, y, font: this.font}); }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}});
      element.toBlob = callback => { calls.blobs++; if (failBlob) throw new Error("fixture canvas error"); queueMicrotask(() => callback(new Blob(["png"], {type: "image/png"}))); };
      calls.canvases.push(element);
    }
    return element;
  };
  document.body = document.createElement("body");
  const prior = document.createElement("button"); prior.textContent = "导出图片"; document.body.append(prior); prior.focus();
  const windowTarget = new Element("window", document);
  const window = {
    addEventListener: windowTarget.addEventListener.bind(windowTarget),
    removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    emit: windowTarget.emit.bind(windowTarget),
    listeners: windowTarget.listeners,
    devicePixelRatio: dpr,
    URL: {createObjectURL(blob) { const key = `blob:${calls.urls.size + calls.revoked.length}`; calls.urls.set(key, blob); return key; }, revokeObjectURL(url) { calls.urls.delete(url); calls.revoked.push(url); }},
    navigator: {clipboard: {async write(items) { calls.clipboard.push(items); }}},
    ClipboardItem: class { constructor(data) { this.data = data; } },
  };
  const options = {document, window, onMessage: (...args) => calls.messages.push(args)};
  const find = (tag, content) => document.body.querySelectorAll(tag).find(element => element.textContent === content);
  return {document, window, options, calls, prior, find};
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("normal image metadata appears once in the header while complete text keeps its metadata", async () => {
  const env = browser();
  const controller = openCreativeSharePreview("opportunity", opportunity, env.options); await controller.ready;
  assert.equal(env.calls.text.filter(line => line.value === "安吉星").length, 1);
  assert.equal(env.calls.text.filter(line => line.value.startsWith("关键词：")).length, 0);
  assert.equal(env.calls.text.filter(line => line.value.startsWith("平台：")).length, 0);
  assert.equal(env.calls.text.filter(line => line.value.includes(controller.report.generatedAt)).length, 1);
  assert.match(buildCreativeShareText("opportunity", opportunity), /小红书 · 生成时间：2026-10-14 09:25/);
  controller.close();
});

test("exceptionally long header fields retain their complete text in image pagination", async () => {
  const env = browser();
  const keyword = "超长关键词".repeat(35);
  const controller = openCreativeSharePreview("longtail", {...longtail, seedKeyword: keyword}, env.options); await controller.ready;
  const bodyLines = env.calls.text.filter(line => line.y >= 164 && line.y <= 954).map(line => line.value).join("");
  assert.ok(bodyLines.includes(`关键词：${keyword}`));
  controller.close();
});

test("preview creates only the current page, caps pixel density, and requires a real click for export", async () => {
  const env = browser();
  const controller = openCreativeSharePreview("benchmark", benchmark, env.options);
  await controller.ready;
  assert.ok(controller.pageCount > 1);
  assert.equal(env.calls.blobs, 1);
  assert.equal(env.calls.canvases.length, 1);
  assert.equal(env.calls.canvases[0].width, 1440);
  assert.equal(env.calls.canvases[0].height, 2040);
  assert.equal(env.calls.downloads.length, 0);
  assert.equal(env.calls.clipboard.length, 0);
  env.find("button", "下一页").click(); await settle();
  assert.equal(env.calls.blobs, 2);
  assert.equal(env.calls.urls.size, 1);
  assert.equal(env.calls.revoked.length, 1);
  env.find("button", "下载本页").click();
  assert.match(env.calls.downloads[0].filename, /-2of\d+\.png$/);
  env.find("button", "复制本页图片").click(); await settle();
  assert.equal(env.calls.clipboard.length, 1);
  controller.close();
  assert.equal(env.calls.urls.size, 0);
  assert.equal(env.calls.canvases[0].width, 0);
  assert.equal(env.document.activeElement, env.prior);
});

test("short previews draw their footer against the actual shortened canvas height", async () => {
  const env = browser();
  const controller = openCreativeSharePreview("longtail", {seedKeyword: "短结果", totalKeywords: 0, summary: "未形成需求方向。", categories: []}, env.options);
  await controller.ready;
  assert.equal(controller.pageCount, 1);
  const height = env.calls.canvases[0].height / 2;
  assert.ok(height >= 420 && height < 1020);
  const footer = env.calls.text.find(line => line.value === "本次样本分析 · 请结合原文判断");
  assert.equal(footer.y, height - 31);
  const content = env.calls.text.filter(line => line.y >= 164 && line !== footer && !/^1 \/ 1$/.test(line.value));
  assert.ok(content.every(line => line.y < height - 47));
  controller.close();
});

test("preview preserves local zoom and double-click reset without intercepting wheel globally", async () => {
  const env = browser(); const controller = openCreativeSharePreview("longtail", longtail, env.options);
  await controller.ready;
  const image = env.document.body.querySelectorAll("img")[0];
  for (let i = 0; i < 20; i++) env.find("button", "放大").click();
  assert.equal(image.style.width, "300%");
  image.emit("dblclick"); assert.equal(image.style.width, "100%");
  for (let i = 0; i < 20; i++) env.find("button", "缩小").click();
  assert.equal(image.style.width, "50%");
  assert.equal(env.document.listeners.has("wheel"), false);
  assert.equal(env.calls.blobs, 1, "zoom reuses the current bitmap");
  controller.close();
});

test("Escape closes only the preview and returns focus; opening again cleans the previous preview", async () => {
  const env = browser(); const first = openCreativeSharePreview("longtail", longtail, env.options); await first.ready;
  const second = openCreativeSharePreview("opportunity", opportunity, env.options); await second.ready;
  assert.equal(env.document.body.querySelectorAll("section").length, 1);
  assert.equal(env.calls.urls.size, 1);
  const event = env.window.emit("keydown", {key: "Escape"});
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.equal(env.document.body.querySelectorAll("section").length, 0);
  assert.equal(env.document.activeElement, env.prior);
  assert.equal(env.calls.urls.size, 0);
});

test("window capture consumes Escape before the earlier document-capture Creative close listener", async () => {
  const env = browser(); let creativeClosed = 0;
  env.document.addEventListener("keydown", event => { if (event.key === "Escape") creativeClosed++; }, true);
  const controller = openCreativeSharePreview("longtail", longtail, env.options); await controller.ready;
  // Real DOM propagation visits window capture first, independent of the order in
  // which a document-capture listener and this window-capture listener registered.
  const event = env.window.emit("keydown", {key: "Escape"});
  if (!event.stopped) env.document.emit("keydown", {key: "Escape"});
  assert.equal(creativeClosed, 0);
  assert.equal(env.document.body.querySelectorAll("section").length, 0);
  assert.equal(env.window.listeners.get("keydown").length, 0);
  assert.equal(env.document.listeners.get("keydown").length, 1, "the original Creative listener is untouched");
  const source = await readFile(new URL("../sidebar/creative-share.js", import.meta.url), "utf8");
  assert.match(source, /window\.addEventListener\("keydown", onKeyDown, true\)/);
  assert.match(source, /window\.removeEventListener\("keydown", onKeyDown, true\)/);
  assert.doesNotMatch(source, /document\.(?:add|remove)EventListener\("keydown", onKeyDown/);
});

test("failed image generation exposes retry and keeps export disabled", async () => {
  const env = browser({failBlob: true}); const controller = openCreativeSharePreview("longtail", longtail, env.options);
  await controller.ready;
  assert.equal(env.find("button", "重新生成").hidden, false);
  assert.equal(env.find("button", "下载本页").disabled, true);
  assert.equal(env.find("button", "复制本页图片").disabled, true);
  assert.match(env.calls.messages[0][0], /生成失败/);
  controller.close();
});

test("share module stays isolated from collection, network, storage, external assets and animation", async () => {
  const source = await readFile(new URL("../sidebar/creative-share.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:fetch|XMLHttpRequest|WebSocket|setInterval|setTimeout|requestAnimationFrame)\s*\(/);
  assert.doesNotMatch(source, /chrome\.(?:runtime|storage|tabs)|localStorage|sessionStorage|capture-sync|utils\/api|createLinearGradient|new Image\(/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.match(source, /textContent = content/);
});
