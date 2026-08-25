import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const sourcePath = resolve(repoRoot, "utils/capture/douyin-blogger.js");
const shippingPath = resolve(
  repoRoot,
  "extension-build/utils/capture/douyin-blogger.js",
);

const source = await readFile(sourcePath, "utf8");
const shippingSource = await readFile(shippingPath, "utf8");

function getFunctionSource(moduleSource, functionName) {
  const start = moduleSource.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `missing function ${functionName}`);
  const next = moduleSource.indexOf("\nfunction ", start + 1);
  return moduleSource.slice(start, next === -1 ? moduleSource.length : next);
}

test("shipping Douyin blogger capture matches the source module", () => {
  assert.equal(shippingSource, source);
});

test("Douyin profile capture requires an explicit scoped works container", () => {
  const resolver = getFunctionSource(source, "resolveBloggerNotesRoot");

  assert.match(
    resolver,
    /rootSelectors\.filter\(\s*isSafeDouyinBloggerNotesRootSelector/,
  );
  assert.match(resolver, /findBloggerNotesRootInScope/);
  assert.match(resolver, /isSafeDouyinBloggerProfileScope/);
  assert.doesNotMatch(resolver, /getFirstMatch\([^)]*,\s*document\)/);
  assert.doesNotMatch(resolver, /document\.querySelector\(["']main["']\)/);
  assert.doesNotMatch(resolver, /\.closest\(["']main["']\)/);
  assert.doesNotMatch(resolver, /document\.body/);

  const scopeGuard = getFunctionSource(
    source,
    "isSafeDouyinBloggerProfileScope",
  );
  assert.match(scopeGuard, /tagName !== "main"/);
  assert.match(scopeGuard, /id !== "root"/);
  assert.match(scopeGuard, /id !== "app"/);
});

test("Douyin work extraction and scrolling never rediscover cards from the page body", () => {
  const extractor = getFunctionSource(
    source,
    "extractDouyinProfileNoteCards",
  );
  const scrollTarget = getFunctionSource(
    source,
    "findDouyinBloggerNotesScrollTarget",
  );
  const cardContainer = getFunctionSource(
    source,
    "resolveProfileNoteCardContainer",
  );

  assert.match(extractor, /notesRoot\.querySelectorAll/);
  assert.doesNotMatch(extractor, /notesRoot\s*\|\|\s*document/);
  assert.doesNotMatch(scrollTarget, /document\.querySelector/);
  assert.doesNotMatch(scrollTarget, /document\.body/);
  assert.doesNotMatch(cardContainer, /document\.body/);
});

test("missing Douyin works container reports a retryable capture error", () => {
  assert.match(source, /DOUYIN_BLOGGER_NOTES_ROOT_NOT_READY/);
  assert.match(
    source,
    /抖音博主作品列表尚未加载，请稍后重试/,
  );
  assert.match(source, /error\.retryable = true/);
  assert.match(source, /retryable: !isCanceled\(\) && error\?\.retryable === true/);
});

test("zero Douyin profile cards require a visible explicit empty state", () => {
  assert.match(source, /PROFILE_SCAN_RESULTS_UNCONFIRMED_EMPTY/);
  assert.match(
    source,
    /allItems\.length === 0[\s\S]*?findExplicitDouyinBloggerEmptyState/u,
  );
  const emptyState = getFunctionSource(
    source,
    "findExplicitDouyinBloggerEmptyState",
  );
  assert.match(emptyState, /暂无作品/);
  assert.match(emptyState, /isVisibleDouyinBloggerStateNode/);
  assert.doesNotMatch(emptyState, /document\.body/);
});
