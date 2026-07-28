import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const {
  hasExplicitDouyinApiCommentCount,
  resolveDouyinCommentCountEvidence,
} = await import(
  `../../utils/capture/douyin-single-note.js?comment-count-certainty=${Date.now()}`
);

const singleNoteSource = await readFile(
  new URL("../../utils/capture/douyin-single-note.js", import.meta.url),
  "utf8",
);

function textNode(text) {
  return {
    textContent: text,
    innerText: text,
    getAttribute() {
      return "";
    },
  };
}

function detailRootWithTexts(...texts) {
  return {
    textContent: "",
    innerText: "",
    querySelectorAll() {
      return texts.map((text) => textNode(text));
    },
  };
}

test("Douyin API comment_count is proven when explicitly present, including zero", () => {
  assert.equal(
    hasExplicitDouyinApiCommentCount({statistics: {comment_count: 0}}),
    true,
  );
  assert.equal(
    hasExplicitDouyinApiCommentCount({statistics: {comment_count: 12}}),
    true,
  );
  assert.equal(hasExplicitDouyinApiCommentCount({statistics: {}}), false);
  assert.equal(
    hasExplicitDouyinApiCommentCount({statistics: {comment_count: null}}),
    false,
  );
});

test("Douyin DOM comment count is known only when its count node contains a number", () => {
  assert.deepEqual(
    resolveDouyinCommentCountEvidence({commentNode: textNode("22")}),
    {count: 22, known: true, source: "dom_count"},
  );
  assert.deepEqual(
    resolveDouyinCommentCountEvidence({commentNode: textNode("评论 0")}),
    {count: 0, known: true, source: "dom_count"},
  );
  assert.deepEqual(
    resolveDouyinCommentCountEvidence({commentNode: textNode("评论 1.2万")}),
    {count: 12000, known: true, source: "dom_count"},
  );
  assert.deepEqual(
    resolveDouyinCommentCountEvidence({commentNode: textNode("评论加载中")}),
    {count: null, known: false, source: "unknown"},
  );
});

test("Douyin comment count does not concatenate duplicate DOM representations", () => {
  assert.deepEqual(
    resolveDouyinCommentCountEvidence({
      commentNode: {
        textContent: "35",
        innerText: "35",
        getAttribute(name) {
          return name === "aria-label" ? "评论 35" : "";
        },
      },
    }),
    {count: 35, known: true, source: "dom_count"},
  );
  assert.deepEqual(
    resolveDouyinCommentCountEvidence({
      commentNode: textNode("评论 22 22"),
    }),
    {count: 22, known: true, source: "dom_count"},
  );
  assert.deepEqual(
    resolveDouyinCommentCountEvidence({
      commentNode: textNode("评论 22 回复 3"),
    }),
    {count: null, known: false, source: "unknown"},
  );
});

test("Douyin DOM count is unknown when rendered representations disagree", () => {
  assert.deepEqual(
    resolveDouyinCommentCountEvidence({
      commentNode: {
        textContent: "2222",
        innerText: "22",
        getAttribute(name) {
          return name === "aria-label" ? "评论 22" : "";
        },
      },
    }),
    {count: null, known: false, source: "dom_conflict"},
  );
  assert.deepEqual(
    resolveDouyinCommentCountEvidence({
      commentNode: {
        textContent: "3535",
        innerText: "35",
        getAttribute(name) {
          return name === "title" ? "评论 35" : "";
        },
      },
    }),
    {count: null, known: false, source: "dom_conflict"},
  );
});

test("Douyin API comment count wins over a stale or malformed DOM count", () => {
  assert.deepEqual(
    resolveDouyinCommentCountEvidence({
      commentNode: textNode("2222"),
      apiDetail: {statistics: {comment_count: 22}},
    }),
    {count: 22, known: true, source: "api_statistics"},
  );
});

test("Douyin DOM fallback accepts explicit API evidence or a scoped empty state", () => {
  assert.deepEqual(
    resolveDouyinCommentCountEvidence({
      apiDetail: {statistics: {comment_count: 8}},
    }),
    {count: 8, known: true, source: "api_statistics"},
  );
  assert.deepEqual(
    resolveDouyinCommentCountEvidence({
      detailRoot: detailRootWithTexts("暂无评论"),
    }),
    {count: 0, known: true, source: "dom_empty_state"},
  );
  assert.deepEqual(
    resolveDouyinCommentCountEvidence({
      detailRoot: detailRootWithTexts("正在加载评论"),
    }),
    {count: null, known: false, source: "unknown"},
  );
});

test("both API and DOM payload paths publish comment-count provenance", () => {
  assert.match(
    singleNoteSource,
    /comments:\s*commentsCountKnown \? stats\.comment_count : null,\s*commentsCountKnown,\s*commentsCountSource:/u,
  );
  assert.match(
    singleNoteSource,
    /comments:\s*interactions\.comments,\s*commentsCountKnown:\s*interactions\.commentsCountKnown,\s*commentsCountSource:\s*interactions\.commentsCountSource,/u,
  );
});
