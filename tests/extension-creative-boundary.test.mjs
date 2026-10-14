import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  approvedCreativeInsertions,
  normalizeCreativePresentationEngine,
  assertCreativePresentationBoundary,
} from "../scripts/creative-presentation-boundary.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const current = await readFile(new URL("../sidebar/sidebar-logic.js", import.meta.url), "utf8");
const shipping = await readFile(new URL("../extension-build/sidebar/sidebar-logic.js", import.meta.url), "utf8");
const baseline = execFileSync("git", ["show", "HEAD:sidebar/sidebar-logic.js"], {cwd: root, encoding: "utf8", maxBuffer: 24 * 1024 * 1024});
const reviewed = normalizeCreativePresentationEngine(current, {requireIntegrated: true});
const blocks = [...current.matchAll(/^[ \t]*\/\/ @creative-view:start ([a-z0-9-]+)\n[\s\S]*?^[ \t]*\/\/ @creative-view:end \1\n/gm)];

test("only 13 frozen reviewed presentation insertions differ from HEAD and shipping", () => {
  assert.equal(approvedCreativeInsertions.length, 13);
  assert.equal(blocks.length, 13);
  assert.ok(Object.isFrozen(approvedCreativeInsertions));
  for (const block of approvedCreativeInsertions) assert.ok(Object.isFrozen(block));
  const result = assertCreativePresentationBoundary(current, {baseline, shipping});
  assert.equal(result.approvedBlocks, 13);
  assert.ok(result.originalBytes > 100_000);
});

test("classic baseline stays byte-identical; current installation cannot silently omit all hooks", () => {
  assert.equal(normalizeCreativePresentationEngine(reviewed), reviewed);
  assert.throws(() => normalizeCreativePresentationEngine(reviewed, {requireIntegrated: true}), /insertion set is absent/);
});

for (const block of blocks) test(`any body edit in approved insertion ${block[1]} is rejected`, () => {
  const modified = block[0].replace(/\n/, "\n  /* unreviewed */\n");
  assert.throws(() => normalizeCreativePresentationEngine(current.replace(block[0], modified)), /unreviewed insertion bytes|reviewed anchors/);
});

test("removing one insertion is rejected instead of silently weakening the bridge", () => {
  assert.throws(() => normalizeCreativePresentationEngine(current.replace(blocks[0][0], "")), /missing, duplicate, or unknown/);
});

test("duplicating a valid insertion is rejected even though its hash is valid", () => {
  assert.throws(() => normalizeCreativePresentationEngine(current + blocks[0][0]), /missing, duplicate, or unknown/);
});

test("unknown, renamed, mismatched, nested and malformed markers are rejected", () => {
  for (const replacement of [
    current.replace(/@creative-view:start imports/, "@creative-view:start unknown"),
    current.replace(/@creative-view:end imports/, "@creative-view:end unknown"),
    current.replace(/@creative-view:end imports/, "@creative-view:start imports"),
    current.replace(/@creative-view:start imports/, "@creative-view: start imports"),
    current + '\nconst marker = "@creative-view:start made-up";\n',
  ]) assert.throws(() => normalizeCreativePresentationEngine(replacement), /boundary/);
});

test("moving unchanged valid bytes to a different function is rejected by its exact anchor", () => {
  const block = blocks.find(match => match[1] === "opportunity-image")[0];
  const source = current.replace(block, "").replace("function handleShareKeywordOpportunityAsImage() {", block + "function handleShareKeywordOpportunityAsImage() {");
  assert.throws(() => normalizeCreativePresentationEngine(source), /reviewed anchors/);
});

test("the allowlist never erases unmarked engine edits, additions, removals or whitespace", () => {
  const mutations = [
    current.replace("async function handleRunKeywordOpportunity() {", "async function handleRunKeywordOpportunity() {\n  return;"),
    current.replace("keywordOpportunityCancelRequested = true;", "keywordOpportunityCancelRequested = false;"),
    current.replace("keywordOpportunityInFlight = false;", "keywordOpportunityInFlight = true;"),
    current + "\n// unreviewed engine addition\n",
    current.replace("async function handleRunKeywordOpportunity() {", "async  function handleRunKeywordOpportunity() {"),
  ];
  for (const mutated of mutations) {
    assert.notEqual(mutated, current);
    assert.throws(() => assertCreativePresentationBoundary(mutated, {baseline, shipping}), /original engine bytes differ/);
  }
});

test("the bridge only renders or shares existing result snapshots, never starts capture or AI", () => {
  const inserted = blocks.map(block => block[0]).join("\n");
  assert.doesNotMatch(inserted, /\b(?:fetch|setInterval|setTimeout|MutationObserver|handleRunKeywordOpportunity|handleRunBenchmarkDiscovery|handleExpandKeywords|startKeywordAnalysis|captureKeywordOpportunitySamples|analyzeKeywordOpportunity|updateKeywordInsightState|setCurrentCapture|setCurrentRuntime)\s*\(/);
  assert.doesNotMatch(inserted, /chrome\.(?:tabs|storage|runtime|scripting)|\b(?:keywordOpportunityResult|keywordBenchmarkResult|keywordOpportunityInFlight|keywordBenchmarkInFlight|expandedKeywordsBuffer)\s*=/);
  assert.match(inserted, /document\.documentElement\.classList\.contains\("sv-next"\)/);
  assert.match(inserted, /navigator\.clipboard\.writeText/);
  assert.match(inserted, /starvoice:presentation-mode/);
});

test("reference snapshots are themselves validated, never broadly stripped", () => {
  const changedReference = current.replace(blocks[0][0], blocks[0][0].replace('"./creative-results.js"', '"./unreviewed.js"'));
  assert.throws(() => assertCreativePresentationBoundary(current, {baseline: changedReference, shipping}), /unreviewed insertion bytes/);
  assert.throws(() => assertCreativePresentationBoundary(current, {baseline, shipping: shipping + "\n"}), /original engine bytes differ from shipping/);
});
