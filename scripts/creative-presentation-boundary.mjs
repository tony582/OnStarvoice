/**
 * Explicitly reviewed, insertion-only Creative presentation bridge.
 * Never learn hashes from the working tree: each edit requires a new review.
 * Everything outside these exact blocks must still match HEAD and shipping.
 */
import {createHash} from "node:crypto";

export const approvedCreativeInsertions = Object.freeze([
  {id: "imports", sha256: "5ca8c409a1f9f82fcb780224b133002731615c5ce14c9880fbc801c13b0133ba",
    before: '  normalizeAuthCodeInput,\n} from "../utils/auth-code.js";\nimport {extractNoteId} from "../utils/helpers.js";\nimport {detectPlatformFromUrl} from "../utils/platform/page-routing.js";\n',
    after: 'import {\n  buildCaptureRecoveryAnnouncementKey,\n  resolveCaptureRecoveryView,\n} from "../utils/capture-recovery-ui.js";'},
  {id: "benchmark-render", sha256: "67efc2a3d34c3e6cd7badfd62e7dd39e566b32f33955780f645cb7e9f0244001",
    before: '  const result = keywordBenchmarkResult;\n  if (!result) {\n    return "";\n  }\n',
    after: '  const candidates = Array.isArray(result.candidates) ? result.candidates : [];\n  const potentialLabels = {\n    high: "优先对标",\n    medium: "可观察",'},
  {id: "opportunity-render", sha256: "cead0be6a46ae9ea190730cdb083cce3792c9bc7bfa7ccb2ec663a5cb914d61a",
    before: '  `;\n}\n\nfunction renderKeywordOpportunityResult() {\n',
    after: '  const result = keywordOpportunityResult;\n  if (!result) {\n    return "";\n  }'},
  {id: "presentation-helpers", sha256: "aa68e26d7f4d2841763d17b578616cc69ed6fa28c0290e86b817edb3476c523e",
    before: '\n  return lines.join("\\n").trim();\n}\n\n',
    after: 'function handleCopyBenchmarkDiscovery(btn) {\n  // @creative-view:start benchmark-copy\n  if (isCreativePresentation()) return copyCreativeResult("benchmark", keywordBenchmarkResult, btn);\n  // @creative-view:end benchmark-copy'},
  {id: "benchmark-copy", sha256: "edf0f94a08826fa1f7f910058ba25acb11838a8d39e4b1d8a7d8af1e9023f75f",
    before: '  });\n}\n// @creative-view:end presentation-helpers\nfunction handleCopyBenchmarkDiscovery(btn) {\n',
    after: '  const text = buildBenchmarkDiscoveryShareText();\n  if (!text || !btn) {\n    showMessage("暂无对标账号结果可复制", "warning");\n    return;'},
  {id: "benchmark-image", sha256: "22ec33f0c091a2ffaedce454bc7fa477aca845a8f80d6dbbb4e977080139161d",
    before: '  };\n}\n\nfunction handleShareBenchmarkDiscoveryAsImage() {\n',
    after: '  const data = buildBenchmarkDiscoveryShareData();\n  if (!data) {\n    showMessage("暂无对标账号结果可分享", "warning");\n    return;'},
  {id: "opportunity-copy", sha256: "2e0f2553e66fe13a951244320356f9a5e15164e25774ed7d48c555abaebdf67d",
    before: '  }\n}\n\nfunction handleCopyKeywordOpportunity(btn) {\n',
    after: '  const text = buildKeywordOpportunityShareText();\n  if (!text || !btn) {\n    return;\n  }'},
  {id: "opportunity-image", sha256: "61fb48b5e46e613580fe29f4aa1132467bc35717ee21b6eb680ee1dcd69c8c18",
    before: '  };\n}\n\nfunction handleShareKeywordOpportunityAsImage() {\n',
    after: '  const data = buildKeywordOpportunityShareData();\n  if (!data) {\n    showMessage("暂无判断赛道机会结果可分享", "warning");\n    return;'},
  {id: "longtail-summary", sha256: "50028986aa9b110e09f68bde8588cea48f548bb6cfd92dfddbe4473bdc0bf585",
    before: '  `;\n}\n\nfunction renderInsightSummaryCard(draft) {\n',
    after: '  const analysis = draft.analysisResult;\n  if (!analysis) {\n    return "";\n  }'},
  {id: "longtail-categories", sha256: "3646c9c5470c73595484da3bc583a5960bd720ad4ab1c4ce1653cedb24c41108",
    before: '  return `${sourceLabel}<ul class="keyword-insight-sample-list">${itemsHtml}</ul>`;\n}\n\nfunction renderInsightCategories(draft) {\n',
    after: '  const analysis = draft.analysisResult;\n  const categories = Array.isArray(analysis?.categories)\n    ? analysis.categories\n    : [];'},
  {id: "longtail-copy", sha256: "ce6f0bbd02576647a6fc0db5c93df886e93ac0a7a9a904d5eb76385248a6abb4",
    before: '  }\n}\n\nfunction handleCopyInsight(btn) {\n',
    after: '  const draft = getKeywordInsightState();\n  const analysis = draft.analysisResult;\n  if (!analysis || !btn) return;\n'},
  {id: "longtail-image", sha256: "c2af079db2e3f83d7dbf7ff1140adcc575f7f67b1a8031fcc1f7d73be236effb",
    before: '  };\n}\n\nfunction handleShareAsImage() {\n',
    after: '  const data = buildInsightShareData();\n  if (!data) {\n    showMessage("暂无洞察结果可分享", "warning");\n    return;'},
  {id: "mode-render-listener", sha256: "df501d388487f3b80c404816ac567f03c4b575109ebb02ef9e9c577172fe3893",
    before: '\n// ==================== 导出 ====================\n\n// 自动初始化\n',
    after: 'if (document.readyState === "loading") {\n  document.addEventListener("DOMContentLoaded", initSidebar);\n} else {\n  initSidebar();'},
].map(block => Object.freeze(block)));

const digest = value => createHash("sha256").update(value).digest("hex");
const fail = message => { throw new Error(`Creative presentation boundary: ${message}`); };

/** Strip only the complete, byte-exact reviewed insertion set at its reviewed anchors. */
export function normalizeCreativePresentationEngine(source, {requireIntegrated = false} = {}) {
  if (typeof source !== "string") throw new TypeError("Creative engine must be a UTF-8 source string");
  const markers = [...source.matchAll(/^[ \t]*\/\/ @creative-view:(start|end) ([a-z0-9-]+)\n/gm)];
  const markerCount = (source.match(/@creative-view:/g) || []).length;
  if (markerCount !== markers.length) fail("malformed marker; no source was stripped");
  if (!markers.length) {
    if (requireIntegrated) fail("required reviewed insertion set is absent");
    return source;
  }
  if (markers.length !== approvedCreativeInsertions.length * 2) fail("missing, duplicate, or unknown insertion");
  const blocks = [];
  for (let index = 0; index < approvedCreativeInsertions.length; index++) {
    const expected = approvedCreativeInsertions[index];
    const start = markers[index * 2], end = markers[index * 2 + 1];
    if (start[1] !== "start" || end[1] !== "end" || start[2] !== expected.id || end[2] !== expected.id) fail(`unknown, nested, reordered, or mismatched insertion: expected ${expected.id}`);
    const begin = start.index, finish = end.index + end[0].length;
    const block = source.slice(begin, finish);
    if (digest(block) !== expected.sha256) fail(`unreviewed insertion bytes: ${expected.id}`);
    if (!source.slice(0, begin).endsWith(expected.before) || !source.slice(finish).startsWith(expected.after)) fail(`insertion moved outside reviewed anchors: ${expected.id}`);
    blocks.push({begin, finish});
  }
  let normalized = source;
  for (const {begin, finish} of blocks.reverse()) normalized = normalized.slice(0, begin) + normalized.slice(finish);
  return normalized;
}

/** Also rejects every unmarked edit, insertion, removal, or whitespace change in the engine. */
export function assertCreativePresentationBoundary(current, {baseline, shipping}) {
  const normalized = normalizeCreativePresentationEngine(current, {requireIntegrated: true});
  for (const [label, reference] of [["HEAD", baseline], ["shipping", shipping]]) {
    if (typeof reference !== "string") throw new TypeError(`Missing ${label} source for Creative engine boundary`);
    if (normalized !== normalizeCreativePresentationEngine(reference)) fail(`original engine bytes differ from ${label}`);
  }
  return {approvedBlocks: approvedCreativeInsertions.length, originalBytes: Buffer.byteLength(normalized)};
}
