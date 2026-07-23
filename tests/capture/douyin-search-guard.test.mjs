import assert from "node:assert/strict";
import test from "node:test";

import {
  createDouyinSearchServiceAbnormalError,
  DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE,
  findDouyinSearchServiceAbnormalNode,
  isDouyinSearchServiceAbnormalCandidate,
  isDouyinSearchServiceAbnormalText,
  observeDouyinSearchServiceAbnormalPage,
} from "../../utils/capture/douyin-search-guard.js";

const searchUrl =
  "https://www.douyin.com/search/%E5%87%AF%E8%BF%AA%E6%8B%89%E5%85%8B?type=general";

class FakeNode {
  constructor({
    text = "",
    visible = true,
    insideResultCard = false,
    resultCardMarker = "",
    resultCardId = "",
    style = null,
    hidden = false,
    ariaHidden = "",
    parentElement = null,
    children = [],
  } = {}) {
    this.innerText = text;
    this.textContent = text;
    this.children = children;
    this.insideResultCard = insideResultCard;
    this.resultCardMarker = resultCardMarker;
    this.resultCardId = resultCardId;
    this.hidden = hidden;
    this.ariaHidden = ariaHidden;
    this.parentElement = parentElement;
    this.nodeType = 1;
    this.style = style || {
      display: "block",
      visibility: "visible",
      opacity: "1",
    };
    this.rect = visible
      ? {width: 120, height: 32}
      : {width: 0, height: 0};
    this.ownerDocument = {
      defaultView: {
        getComputedStyle: (node) => node.style,
      },
    };
  }

  matches() {
    return true;
  }

  querySelectorAll() {
    return this.children;
  }

  querySelector() {
    return null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  getAttribute(name) {
    if (name === "aria-hidden") return this.ariaHidden;
    if (name === "data-id" || name === "data-item-id") {
      return this.resultCardId;
    }
    return "";
  }

  closest(selector) {
    return this.insideResultCard ||
      (this.resultCardMarker && selector.includes(this.resultCardMarker))
      ? this
      : null;
  }
}

test("Douyin service-abnormal copy uses an exact bounded match", () => {
  assert.equal(isDouyinSearchServiceAbnormalText("服务出现异常"), true);
  assert.equal(
    isDouyinSearchServiceAbnormalText("服务出现异常，请稍后重试"),
    true,
  );
  assert.equal(isDouyinSearchServiceAbnormalText("网络异常"), false);
  assert.equal(isDouyinSearchServiceAbnormalText("服务异常"), false);
  assert.equal(
    isDouyinSearchServiceAbnormalText("遇到服务出现异常时怎么办"),
    false,
  );
});

test("the guard only accepts a visible Douyin search-page state outside result cards", () => {
  assert.equal(
    isDouyinSearchServiceAbnormalCandidate({
      pageUrl: searchUrl,
      text: "服务出现异常",
      visible: true,
      insideResultCard: false,
    }),
    true,
  );
  assert.equal(
    isDouyinSearchServiceAbnormalCandidate({
      pageUrl: searchUrl,
      text: "服务出现异常",
      visible: false,
      insideResultCard: false,
    }),
    false,
  );
  assert.equal(
    isDouyinSearchServiceAbnormalCandidate({
      pageUrl: searchUrl,
      text: "服务出现异常",
      visible: true,
      insideResultCard: true,
    }),
    false,
    "a work title with the same copy must not stop the task",
  );
  assert.equal(
    isDouyinSearchServiceAbnormalCandidate({
      pageUrl: "https://www.douyin.com/video/123",
      text: "服务出现异常",
      visible: true,
      insideResultCard: false,
    }),
    false,
  );
});

test("the DOM guard still detects the blocking state when stale cards remain mounted", () => {
  const staleCardTitle = new FakeNode({
    text: "普通作品",
    insideResultCard: true,
  });
  const blockingNode = new FakeNode({text: "服务出现异常"});
  const root = new FakeNode({
    text: "搜索页",
    children: [staleCardTitle, blockingNode],
  });

  assert.equal(
    findDouyinSearchServiceAbnormalNode({
      root,
      pageUrl: searchUrl,
    }),
    blockingNode,
  );
});

test("real Douyin result-card selector variants cannot be mistaken for the blocking state", () => {
  for (const resultCardMarker of [
    "[data-id]",
    'a[data-href*="/video/"]',
    'a[data-url*="/note/"]',
  ]) {
    const workTitle = new FakeNode({
      text: "服务出现异常",
      resultCardMarker,
      resultCardId:
        resultCardMarker === "[data-id]" ? "7391234567890123456" : "",
    });
    const root = new FakeNode({text: "搜索页", children: [workTitle]});
    assert.equal(
      findDouyinSearchServiceAbnormalNode({root, pageUrl: searchUrl}),
      null,
      `must exclude ${resultCardMarker}`,
    );
  }
});

test("a generic data-id container does not hide the real blocking state", () => {
  const blockingNode = new FakeNode({
    text: "服务出现异常",
    resultCardMarker: "[data-id]",
    resultCardId: "search-container",
  });
  const root = new FakeNode({text: "搜索页", children: [blockingNode]});

  assert.equal(
    findDouyinSearchServiceAbnormalNode({root, pageUrl: searchUrl}),
    blockingNode,
  );
});

test("a pre-mounted blocking copy hidden by an ancestor is ignored", () => {
  const hiddenAncestor = new FakeNode({ariaHidden: "true"});
  const blockingNode = new FakeNode({
    text: "服务出现异常",
    parentElement: hiddenAncestor,
  });
  const root = new FakeNode({text: "搜索页", children: [blockingNode]});

  assert.equal(
    findDouyinSearchServiceAbnormalNode({root, pageUrl: searchUrl}),
    null,
  );
});

test("an ancestor visibility mutation detects a pre-mounted long blocking subtree", () => {
  const OriginalMutationObserver = globalThis.MutationObserver;
  let observerCallback = null;
  class FakeMutationObserver {
    constructor(callback) {
      observerCallback = callback;
    }

    observe() {}

    disconnect() {}
  }
  globalThis.MutationObserver = FakeMutationObserver;

  try {
    const hiddenAncestor = new FakeNode({
      text: `这是一个超过二十四个字的预挂载容器，稍后显示服务出现异常并停止任务`,
      ariaHidden: "true",
    });
    const blockingNode = new FakeNode({
      text: "服务出现异常",
      parentElement: hiddenAncestor,
    });
    hiddenAncestor.children = [blockingNode];
    let detected = null;
    const observer = observeDouyinSearchServiceAbnormalPage({
      root: hiddenAncestor,
      pageUrl: searchUrl,
      onDetected: (error) => {
        detected = error;
      },
    });

    assert.equal(detected, null);
    hiddenAncestor.ariaHidden = "";
    observerCallback([{type: "attributes", target: hiddenAncestor}]);
    assert.equal(detected?.code, DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE);
    observer.disconnect();
  } finally {
    globalThis.MutationObserver = OriginalMutationObserver;
  }
});

test("the structured error is non-retryable and stops the whole batch", () => {
  const error = createDouyinSearchServiceAbnormalError({pageUrl: searchUrl});

  assert.equal(error.code, DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE);
  assert.equal(error.securityBlocked, true);
  assert.equal(error.requiresManualAction, true);
  assert.equal(error.stopBatch, true);
  assert.equal(error.fatal, true);
  assert.equal(error.retryable, false);
});
