import assert from "node:assert/strict";
import test from "node:test";

import {
  createDouyinSearchServiceAbnormalError,
  createDouyinSearchSecurityChallengeError,
  DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE,
  DOUYIN_SEARCH_SECURITY_CHALLENGE_CODE,
  findDouyinSearchServiceAbnormalNode,
  findDouyinSearchSecurityChallengeNode,
  isDouyinSearchServiceAbnormalCandidate,
  isDouyinSearchServiceAbnormalText,
  isDouyinSearchSecurityChallengeCandidate,
  isDouyinSearchSecurityChallengeText,
  observeDouyinSearchServiceAbnormalPage,
  observeDouyinSearchSecurityChallengePage,
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
    attributes = {},
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
    this.attributes = {...attributes};
    this.id = attributes.id || "";
    this.className = attributes.class || "";
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
    return this.attributes[name] || "";
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

test("the structured error stops only the current keyword and remains retryable", () => {
  const error = createDouyinSearchServiceAbnormalError({pageUrl: searchUrl});

  assert.equal(error.code, DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE);
  assert.equal(error.securityBlocked, false);
  assert.equal(error.requiresManualAction, false);
  assert.equal(error.stopBatch, false);
  assert.equal(error.fatal, false);
  assert.equal(error.retryable, true);
  assert.equal(error.keywordScoped, true);
});

test("Douyin semantic image verification copy is a high-confidence security challenge", () => {
  const challengeText =
    "能满足人的口渴的东西 请选择所有符合上述描述的图片，并拖拽到下方 拖拽到这里 提交";
  assert.equal(
    isDouyinSearchSecurityChallengeText({text: challengeText}),
    true,
  );
  assert.equal(
    isDouyinSearchSecurityChallengeText({
      text: "请选择一张喜欢的图片并提交",
    }),
    false,
    "generic image copy must not stop a task",
  );
  assert.equal(
    isDouyinSearchSecurityChallengeText({title: "验证码中间页"}),
    true,
  );
});

test("the security challenge must be visible, on Douyin, and outside result cards", () => {
  const text =
    "请选择所有符合上文描述的图片，并拖拽到下方 拖拽到这里";
  assert.equal(
    isDouyinSearchSecurityChallengeCandidate({
      pageUrl: searchUrl,
      text,
      visible: true,
      insideResultCard: false,
    }),
    true,
  );
  assert.equal(
    isDouyinSearchSecurityChallengeCandidate({
      pageUrl: searchUrl,
      text,
      visible: false,
      insideResultCard: false,
    }),
    false,
  );
  assert.equal(
    isDouyinSearchSecurityChallengeCandidate({
      pageUrl: searchUrl,
      text,
      visible: true,
      insideResultCard: true,
    }),
    false,
  );
  assert.equal(
    isDouyinSearchSecurityChallengeCandidate({
      pageUrl: "https://www.douyin.com/verify?from=search",
      text,
      visible: true,
      insideResultCard: false,
    }),
    true,
    "a Douyin verification redirect must not downgrade to a retryable page failure",
  );
  assert.equal(
    isDouyinSearchSecurityChallengeCandidate({
      pageUrl: "https://example.com/verify",
      text,
      visible: true,
      insideResultCard: false,
    }),
    false,
  );
});

test("the security guard detects the modal even when stale result cards remain mounted", () => {
  const staleCard = new FakeNode({
    text: "请选择所有符合上述描述的图片，并拖拽到下方 拖拽到这里",
    insideResultCard: true,
  });
  const challenge = new FakeNode({
    text: "请选择所有符合上述描述的图片，并拖拽到下方 拖拽到这里",
  });
  const root = new FakeNode({
    text: "搜索页",
    children: [staleCard, challenge],
  });
  assert.equal(
    findDouyinSearchSecurityChallengeNode({root, pageUrl: searchUrl}),
    challenge,
  );
});

test("a visible verification iframe is treated as a security challenge", () => {
  const challengeFrame = new FakeNode({
    attributes: {
      src: "https://verify.douyin.com/captcha/index",
      title: "verification challenge",
    },
  });
  const root = new FakeNode({
    text: "搜索页",
    children: [challengeFrame],
  });
  assert.equal(
    findDouyinSearchSecurityChallengeNode({root, pageUrl: searchUrl}),
    challengeFrame,
  );
});

test("the structured security challenge requires human action and stops the batch", () => {
  const error = createDouyinSearchSecurityChallengeError({
    pageUrl: searchUrl,
  });
  assert.equal(error.code, DOUYIN_SEARCH_SECURITY_CHALLENGE_CODE);
  assert.equal(error.securityBlocked, true);
  assert.equal(error.platformSafetyBlocked, true);
  assert.equal(error.requiresManualAction, true);
  assert.equal(error.stopBatch, true);
  assert.equal(error.fatal, true);
  assert.equal(error.retryable, false);
  assert.equal(error.keywordScoped, false);
});

test("a newly visible semantic image challenge is observed immediately", () => {
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
    const modal = new FakeNode({
      text: "请选择所有符合上述描述的图片，并拖拽到下方 拖拽到这里",
      visible: false,
    });
    const root = new FakeNode({text: "搜索页", children: [modal]});
    let detected = null;
    const observer = observeDouyinSearchSecurityChallengePage({
      root,
      pageUrl: searchUrl,
      onDetected: (error) => {
        detected = error;
      },
    });
    assert.equal(detected, null);
    modal.rect = {width: 320, height: 460};
    observerCallback([{type: "attributes", target: modal}]);
    assert.equal(
      detected?.code,
      DOUYIN_SEARCH_SECURITY_CHALLENGE_CODE,
    );
    observer.disconnect();
  } finally {
    globalThis.MutationObserver = OriginalMutationObserver;
  }
});

test("separately rendered instruction and drop-target siblings are detected from their shared container", () => {
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
    const instruction = new FakeNode({
      text: "请选择所有符合上述描述的图片",
    });
    const dropTarget = new FakeNode({text: "拖拽到这里"});
    const modal = new FakeNode({
      text: "请选择所有符合上述描述的图片，并拖拽到下方",
      visible: false,
      children: [instruction, dropTarget],
    });
    instruction.parentElement = modal;
    dropTarget.parentElement = modal;
    const root = new FakeNode({text: "搜索页", children: [modal]});
    let detected = null;
    const observer = observeDouyinSearchSecurityChallengePage({
      root,
      pageUrl: searchUrl,
      onDetected: (error) => {
        detected = error;
      },
    });

    assert.equal(detected, null);
    modal.rect = {width: 320, height: 460};
    observerCallback([
      {
        type: "childList",
        target: modal,
        addedNodes: [dropTarget],
      },
    ]);
    assert.equal(
      detected?.code,
      DOUYIN_SEARCH_SECURITY_CHALLENGE_CODE,
    );
    observer.disconnect();
  } finally {
    globalThis.MutationObserver = OriginalMutationObserver;
  }
});
