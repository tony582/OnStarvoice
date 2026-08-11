import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {resolveCommentScrollTarget} from "../../utils/capture/comments.js";

class FakeNode {
  constructor({
    overflowY = "visible",
    position = "static",
    scrollHeight = 100,
    clientHeight = 100,
    role = "",
    ariaModal = "",
  } = {}) {
    this.parentElement = null;
    this.children = [];
    this.scrollHeight = scrollHeight;
    this.clientHeight = clientHeight;
    this.style = {overflowY, position};
    this.attributes = new Map();
    if (role) this.attributes.set("role", role);
    if (ariaModal) this.attributes.set("aria-modal", ariaModal);
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  querySelectorAll(selector) {
    if (selector !== "*") return [];
    return this.children.flatMap((child) => [
      child,
      ...child.querySelectorAll("*"),
    ]);
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }
}

function withFakeDom(run) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const documentElement = new FakeNode();
  const body = documentElement.append(new FakeNode());
  const fakeWindow = {
    getComputedStyle(node) {
      return node?.style || {overflowY: "visible", position: "static"};
    },
  };
  globalThis.window = fakeWindow;
  globalThis.document = {body, documentElement};
  try {
    return run({body, documentElement, fakeWindow});
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
}

test("XHS comment scrolling stays inside a fixed detail overlay", () => {
  withFakeDom(({body}) => {
    const overlay = body.append(
      new FakeNode({
        overflowY: "auto",
        position: "fixed",
        scrollHeight: 900,
        clientHeight: 500,
      }),
    );
    const commentContainer = overlay.append(new FakeNode());

    assert.equal(resolveCommentScrollTarget(commentContainer), overlay);
  });
});

test("XHS empty overlay never falls back to scrolling the background window", () => {
  withFakeDom(({body}) => {
    const overlay = body.append(new FakeNode({position: "fixed"}));
    const commentContainer = overlay.append(new FakeNode());

    assert.equal(resolveCommentScrollTarget(commentContainer), null);
  });
});

test("a direct detail page may still use the document scroll surface", () => {
  withFakeDom(({body, fakeWindow}) => {
    const commentContainer = body.append(new FakeNode());

    assert.equal(resolveCommentScrollTarget(commentContainer), fakeWindow);
  });
});

test("explicit XHS empty state is checked before any page scroll", async () => {
  const source = await readFile(
    new URL("../../utils/capture/comments.js", import.meta.url),
    "utf8",
  );
  const containerIndex = source.indexOf(
    "const commentScope =",
  );
  const emptyCheckIndex = source.indexOf(
    "hasExplicitEmptyCommentsState(commentScope)",
    containerIndex,
  );
  const scrollIndex = source.indexOf(
    "await scrollElementIntoView(commentContainer)",
    containerIndex,
  );

  assert.ok(containerIndex >= 0);
  assert.ok(emptyCheckIndex > containerIndex);
  assert.ok(scrollIndex > emptyCheckIndex);
  assert.match(source, /reason:\s*"confirmed_zero"/u);
  assert.match(source, /return overlayBoundary \? null : window;/u);
});
