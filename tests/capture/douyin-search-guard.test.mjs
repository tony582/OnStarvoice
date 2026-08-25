import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoDouyinSearchServiceAbnormalPage,
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
    isConnected = true,
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
    this.isConnected = isConnected;
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
    const descendants = [];
    const visit = (node) => {
      for (const child of node?.children || []) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);
    return descendants;
  }

  querySelector() {
    return null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  getAttribute(name) {
    if (name === "aria-hidden") return this.ariaHidden;
    if (name === "data-e2e-aweme-id" && this.insideResultCard) {
      return "7391234567890123456";
    }
    if (name === "data-id" || name === "data-item-id") {
      return this.resultCardId;
    }
    return this.attributes[name] || "";
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (
        (current.insideResultCard &&
          selector.includes("[data-e2e-aweme-id]")) ||
        (current.attributes["data-id"] && selector.includes("[data-id]")) ||
        (current.attributes["data-item-id"] &&
          selector.includes("[data-item-id]")) ||
        (current.resultCardMarker &&
          selector.includes(current.resultCardMarker))
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
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

test("only dedicated Douyin identity and valid work links suppress card copy", () => {
  for (const scenario of [
    {
      resultCardMarker: '[id^="waterfall_item_"]',
      attributes: {id: "waterfall_item_7391234567890123456"},
    },
    {
      resultCardMarker: "[data-e2e-aweme-id]",
      attributes: {"data-e2e-aweme-id": "7391234567890123456"},
    },
    {
      resultCardMarker: "[data-modal-id]",
      attributes: {"data-modal-id": "7391234567890123456"},
    },
    {
      resultCardMarker: 'a[data-href*="/video/"]',
      attributes: {"data-href": "/video/7391234567890123456"},
    },
    {
      resultCardMarker: 'a[data-url*="/note/"]',
      attributes: {
        "data-url": "https://www.douyin.com/note/7391234567890123456",
      },
    },
    {
      resultCardMarker: 'a[href*="modal_id="]',
      attributes: {
        href: "/search/test?modal_id=7391234567890123456",
      },
    },
  ]) {
    const workTitle = new FakeNode({
      text: "服务出现异常",
      ...scenario,
    });
    const root = new FakeNode({text: "搜索页", children: [workTitle]});
    assert.equal(
      findDouyinSearchServiceAbnormalNode({root, pageUrl: searchUrl}),
      null,
      `must exclude ${scenario.resultCardMarker}`,
    );
  }
});

test("a semantic title sibling is excluded only when its result-card ancestor has canonical identity", () => {
  const workTitle = new FakeNode({text: "服务出现异常"});
  const workLink = new FakeNode({
    resultCardMarker: 'a[href*="/video/"]',
    attributes: {href: "/video/7391234567890123456"},
  });
  const card = new FakeNode({
    text: "服务出现异常",
    resultCardMarker: ".search-result-card",
    children: [workTitle, workLink],
  });
  workTitle.parentElement = card;
  workLink.parentElement = card;
  const root = new FakeNode({text: "搜索页", children: [card]});
  card.parentElement = root;

  assert.equal(
    findDouyinSearchServiceAbnormalNode({root, pageUrl: searchUrl}),
    null,
  );

  workLink.attributes.href = "/video/1234567";
  assert.equal(
    findDouyinSearchServiceAbnormalNode({root, pageUrl: searchUrl}),
    card,
    "a result-looking wrapper without canonical work identity is not trusted",
  );
});

test("a strong result card stays excluded when its canonical link owns generic data identity", () => {
  for (const genericAttribute of ["data-id", "data-item-id"]) {
    const challengeCopy =
      "请选择所有符合上述描述的图片，并拖拽到下方 拖拽到这里";
    const workTitle = new FakeNode({text: challengeCopy});
    const workLink = new FakeNode({
      resultCardMarker: 'a[href*="/video/"]',
      attributes: {
        href: "/video/7391234567890123456",
        [genericAttribute]: "7391234567890123456",
      },
    });
    const card = new FakeNode({
      text: challengeCopy,
      resultCardMarker: ".search-result-card",
      children: [workTitle, workLink],
    });
    workTitle.parentElement = card;
    workLink.parentElement = card;
    const root = new FakeNode({text: "搜索页", children: [card]});
    card.parentElement = root;

    assert.equal(
      findDouyinSearchSecurityChallengeNode({root, pageUrl: searchUrl}),
      null,
      `${genericAttribute} on the canonical link must not hide its strong card ancestor`,
    );
  }
});

test("generic numeric data-id and data-item-id containers cannot hide the blocking state", () => {
  for (const resultCardMarker of ["[data-id]", "[data-item-id]"]) {
    const blockingNode = new FakeNode({
      text: "服务出现异常",
      resultCardMarker,
      resultCardId: "7391234567890123456",
    });
    const root = new FakeNode({text: "搜索页", children: [blockingNode]});

    assert.equal(
      findDouyinSearchServiceAbnormalNode({root, pageUrl: searchUrl}),
      blockingNode,
      `${resultCardMarker} is not trusted work identity`,
    );
  }
});

test("invalid or off-domain result-like links cannot hide the blocking state", () => {
  for (const scenario of [
    {
      resultCardMarker: 'a[href*="/video/"]',
      attributes: {href: "/video/1234567"},
    },
    {
      resultCardMarker: 'a[href*="/video/"]',
      attributes: {href: "https://example.com/video/7391234567890123456"},
    },
    {
      resultCardMarker: 'a[href*="modal_id="]',
      attributes: {href: "/search/test?modal_id=not-a-work-id"},
    },
  ]) {
    const blockingNode = new FakeNode({
      text: "服务出现异常",
      ...scenario,
    });
    const root = new FakeNode({text: "搜索页", children: [blockingNode]});
    assert.equal(
      findDouyinSearchServiceAbnormalNode({root, pageUrl: searchUrl}),
      blockingNode,
    );
  }
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
    let clock = 0;
    let confirmationCallback = null;
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
      now: () => clock,
      setTimer: (callback) => {
        confirmationCallback = callback;
        return 1;
      },
      clearTimer: () => {
        confirmationCallback = null;
      },
    });

    assert.equal(detected, null);
    hiddenAncestor.ariaHidden = "";
    observerCallback([{type: "attributes", target: hiddenAncestor}]);
    assert.equal(detected, null, "one render frame is not terminal");
    clock = 1500;
    confirmationCallback();
    assert.equal(detected?.code, DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE);
    observer.disconnect();
  } finally {
    globalThis.MutationObserver = OriginalMutationObserver;
  }
});

test("the synchronous guard requires the same abnormal signature for two polls and 1.5 seconds", () => {
  const blockingNode = new FakeNode({text: "服务出现异常"});
  const root = new FakeNode({text: "搜索页", children: [blockingNode]});
  let clock = 0;

  assert.doesNotThrow(() =>
    assertNoDouyinSearchServiceAbnormalPage({
      root,
      pageUrl: searchUrl,
      now: () => clock,
    }),
  );
  clock = 1499;
  assert.doesNotThrow(() =>
    assertNoDouyinSearchServiceAbnormalPage({
      root,
      pageUrl: searchUrl,
      now: () => clock,
    }),
  );
  clock = 1500;
  assert.throws(
    () =>
      assertNoDouyinSearchServiceAbnormalPage({
        root,
        pageUrl: searchUrl,
        now: () => clock,
      }),
    (error) => error?.code === DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE,
  );
});

test("a transient abnormal frame followed by trusted results does not stop the observer", () => {
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
    let clock = 0;
    let confirmationCallback = null;
    const blockingNode = new FakeNode({text: "服务出现异常"});
    const root = new FakeNode({text: "搜索页", children: [blockingNode]});
    let detected = null;
    const observer = observeDouyinSearchServiceAbnormalPage({
      root,
      pageUrl: searchUrl,
      onDetected: (error) => {
        detected = error;
      },
      now: () => clock,
      setTimer: (callback) => {
        confirmationCallback = callback;
        return 1;
      },
      clearTimer: () => {
        confirmationCallback = null;
      },
    });
    assert.equal(detected, null);
    assert.equal(typeof confirmationCallback, "function");

    blockingNode.isConnected = false;
    const realResult = new FakeNode({
      text: "真实作品",
      resultCardMarker: '[id^="waterfall_item_"]',
      attributes: {id: "waterfall_item_7391234567890123456"},
    });
    root.children = [realResult];
    observerCallback([
      {type: "childList", target: root, addedNodes: [realResult]},
    ]);
    clock = 2000;
    confirmationCallback?.();
    assert.equal(detected, null);
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
  assert.equal(
    isDouyinSearchSecurityChallengeText({
      title: "验证码中间页是什么 - 抖音搜索",
    }),
    false,
    "a search/result title quoting the phrase is not the platform challenge page",
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
      pageUrl: searchUrl,
      text,
      visible: true,
      insideResultCard: false,
      containsResultCard: true,
    }),
    false,
    "aggregate page/list copy inherited from a result card is not a dialog",
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

test("result-card verification wording cannot poison an aggregate page wrapper", () => {
  const challengeText =
    "请选择所有符合上述描述的图片，并拖拽到下方 拖拽到这里";
  const quotedResult = new FakeNode({
    text: challengeText,
    resultCardMarker: '[id^="waterfall_item_"]',
    attributes: {id: "waterfall_item_7391234567890123456"},
  });
  const aggregate = new FakeNode({
    text: `搜索页 ${challengeText}`,
    children: [quotedResult],
  });

  assert.equal(
    findDouyinSearchSecurityChallengeNode({
      root: aggregate,
      pageUrl: searchUrl,
    }),
    null,
  );
});

test("a sibling verification dialog still wins while quoted result cards remain mounted", () => {
  const challengeText =
    "请选择所有符合上述描述的图片，并拖拽到下方 拖拽到这里";
  const quotedResult = new FakeNode({
    text: challengeText,
    resultCardMarker: '[id^="waterfall_item_"]',
    attributes: {id: "waterfall_item_7391234567890123456"},
  });
  const dialog = new FakeNode({text: challengeText});
  const aggregate = new FakeNode({
    text: `搜索页 ${challengeText}`,
    children: [quotedResult, dialog],
  });

  assert.equal(
    findDouyinSearchSecurityChallengeNode({
      root: aggregate,
      pageUrl: searchUrl,
    }),
    dialog,
  );
});

test("detail and profile guards require structured challenge UI, not business copy", () => {
  const challengeText =
    "请选择所有符合上述描述的图片，并拖拽到下方 拖拽到这里";
  const ordinaryCaption = new FakeNode({text: challengeText});
  const ordinaryPage = new FakeNode({
    text: `验证码教程 ${challengeText}`,
    children: [ordinaryCaption],
  });
  assert.equal(
    findDouyinSearchSecurityChallengeNode({
      root: ordinaryPage,
      pageUrl: "https://www.douyin.com/video/7391234567890123456",
      title: "captcha challenge tutorial - 抖音",
      requireStructuredContainer: true,
    }),
    null,
  );

  const dialog = new FakeNode({
    text: challengeText,
    attributes: {role: "dialog"},
  });
  const challengedPage = new FakeNode({
    text: challengeText,
    children: [dialog],
  });
  assert.equal(
    findDouyinSearchSecurityChallengeNode({
      root: challengedPage,
      pageUrl: "https://www.douyin.com/user/example",
      requireStructuredContainer: true,
    }),
    dialog,
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

test("generic numeric data-id containers cannot hide an immediate security challenge", () => {
  const challengeText =
    "请选择所有符合上述描述的图片，并拖拽到下方 拖拽到这里";
  for (const resultCardMarker of ["[data-id]", "[data-item-id]"]) {
    const challenge = new FakeNode({
      text: challengeText,
      resultCardMarker,
      resultCardId: "7391234567890123456",
    });
    const root = new FakeNode({text: "搜索页", children: [challenge]});
    assert.equal(
      findDouyinSearchSecurityChallengeNode({root, pageUrl: searchUrl}),
      challenge,
      `${resultCardMarker} is not trusted work identity`,
    );
  }
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
