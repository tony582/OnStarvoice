import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../../utils/capture/douyin-single-note.js", import.meta.url),
  "utf8",
);

function sliceFunction(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end > start, `missing end marker ${endMarker}`);
  return source.slice(start, end);
}

test("Douyin API metrics distinguish a proven zero from a missing field", () => {
  const context = vm.createContext({
    normalizeNonNegativeInteger(value) {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
    },
    resolveDouyinAccountTypeFromApiAuthor() {
      return "";
    },
  });
  vm.runInContext(
    `${sliceFunction(
      "function extractDouyinBloggerMetricsFromApiDetail(",
      "function extractDouyinInlineBloggerMetrics(",
    )}\nglobalThis.__extract = extractDouyinBloggerMetricsFromApiDetail;`,
    context,
  );

  const provenZero = context.__extract({
    author: {follower_count: 0, total_favorited: 0},
  });
  assert.equal(provenZero.followersCount, 0);
  assert.equal(provenZero.followersCountKnown, true);
  assert.equal(provenZero.likedAndCollectedCount, 0);
  assert.equal(provenZero.likedAndCollectedCountKnown, true);

  const missing = context.__extract({author: {}});
  assert.equal(missing.followersCount, 0);
  assert.equal(missing.followersCountKnown, false);
  assert.equal(missing.likedAndCollectedCountKnown, false);
});

test("Douyin metric labels explicitly prove a displayed zero", () => {
  const context = vm.createContext({
    cleanText: (value) => String(value || "").trim(),
    parseDouyinMetricCount: (value) => Number(value),
  });
  vm.runInContext(
    `${sliceFunction(
      "function extractDouyinMetricSignalByLabels(",
      "function extractDouyinMetricByLabels(",
    )}\nglobalThis.__extract = extractDouyinMetricSignalByLabels;`,
    context,
  );

  assert.deepEqual(
    structuredClone(context.__extract("粉丝 0", ["粉丝"])),
    {count: 0, known: true},
  );
  assert.deepEqual(
    structuredClone(context.__extract("暂未展示", ["粉丝"])),
    {count: 0, known: false},
  );
});

test("Douyin required metrics reject default zeros but accept known zeros", () => {
  const context = vm.createContext({
    normalizeNonNegativeInteger(value) {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
    },
  });
  vm.runInContext(
    `${sliceFunction(
      "function hasRequiredDouyinBloggerMetrics(",
      "// ── 主采集函数",
    )}\nglobalThis.__hasRequired = hasRequiredDouyinBloggerMetrics;`,
    context,
  );

  assert.equal(
    context.__hasRequired({
      bloggerFollowersCount: 0,
      bloggerLikedAndCollectedCount: 0,
    }),
    false,
  );
  assert.equal(
    context.__hasRequired({
      bloggerFollowersCount: 0,
      bloggerFollowersCountKnown: true,
      bloggerLikedAndCollectedCount: 0,
      bloggerLikedAndCollectedCountKnown: true,
    }),
    true,
  );
});
