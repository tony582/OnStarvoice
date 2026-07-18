import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {resolveCommentsCountKnown} from "../../utils/capture/single-note.js";

class FakeNode {
  constructor(textContent = "", {hidden = false, ariaHidden = false} = {}) {
    this.textContent = textContent;
    this.hidden = hidden;
    this.parentElement = null;
    this.nextElementSibling = null;
    this._ariaHidden = ariaHidden;
    this._children = [];
    this._selectors = new Map();
    this._ignoredAncestor = null;
  }

  add(selector, node) {
    const nodes = this._selectors.get(selector) || [];
    nodes.push(node);
    this._selectors.set(selector, nodes);
    return this;
  }

  append(node) {
    node.parentElement = this;
    this._children.push(node);
    return this;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    if (selector === "*") {
      return this._children.flatMap((child) => [
        child,
        ...child.querySelectorAll("*"),
      ]);
    }
    return this._selectors.get(selector) || [];
  }

  getAttribute(name) {
    if (name === "aria-hidden") return this._ariaHidden ? "true" : null;
    return null;
  }

  closest(selector) {
    if (selector.includes("[hidden]") && (this.hidden || this._ariaHidden)) {
      return this;
    }
    if (selector.includes(".recommend") && this._ignoredAncestor) {
      return this._ignoredAncestor;
    }
    return null;
  }

  contains(candidate) {
    return (
      candidate === this ||
      this._children.some((child) => child.contains(candidate))
    );
  }
}

function detailWithCommentCount(text, options = {}) {
  const detail = new FakeNode();
  const engageBar = new FakeNode();
  const count = new FakeNode(text, options);
  detail.add(".buttons.engage-bar-style", engageBar);
  engageBar.add(".left .chat-wrapper .count", count);
  return detail;
}

function detailWithCommentState(text, options = {}) {
  const detail = new FakeNode();
  const comments = new FakeNode();
  const state = new FakeNode(text, options);
  detail.add(".comments-container", comments);
  detail.append(comments);
  comments.append(state);
  return {detail, comments, state};
}

test("XHS marks an actual numeric comment-count node as known, including zero", () => {
  assert.equal(resolveCommentsCountKnown(detailWithCommentCount("0")), true);
  assert.equal(
    resolveCommentsCountKnown(detailWithCommentCount("评论 1.2万")),
    true,
  );
});

test("XHS does not treat a missing or loading comment-count node as known zero", () => {
  assert.equal(resolveCommentsCountKnown(new FakeNode()), false);
  assert.equal(
    resolveCommentsCountKnown(detailWithCommentCount("加载中 0%")),
    false,
  );
  assert.equal(
    resolveCommentsCountKnown(detailWithCommentCount("正在加载评论")),
    false,
  );
});

test("XHS accepts only explicit empty-comment copy in the current detail region", () => {
  assert.equal(
    resolveCommentsCountKnown(detailWithCommentState("暂无评论").detail),
    true,
  );
  assert.equal(
    resolveCommentsCountKnown(
      detailWithCommentState("这是一片荒地 点击评论").detail,
    ),
    true,
  );
  assert.equal(
    resolveCommentsCountKnown(detailWithCommentState("点击评论").detail),
    false,
  );
  assert.equal(
    resolveCommentsCountKnown(detailWithCommentState("评论加载中").detail),
    false,
  );
});

test("XHS ignores hidden or recommendation-area empty states", () => {
  assert.equal(
    resolveCommentsCountKnown(
      detailWithCommentState("暂无评论", {hidden: true}).detail,
    ),
    false,
  );

  const {detail, state} = detailWithCommentState("暂无评论");
  const recommendation = new FakeNode();
  detail.append(recommendation);
  recommendation.append(state);
  state._ignoredAncestor = recommendation;
  assert.equal(resolveCommentsCountKnown(detail), false);
});

test("single-note payload carries the comment-count certainty marker", async () => {
  const source = await readFile(
    new URL("../../utils/capture/single-note.js", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /commentsCountKnown:\s*interactions\.commentsCountKnown/u,
  );
});
