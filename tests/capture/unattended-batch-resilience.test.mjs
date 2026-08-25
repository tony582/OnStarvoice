import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {DOUYIN_DOM_PROFILE} from "../../utils/platform/dom-profiles/douyin.js";

const captureSyncSource = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);
const contentSource = await readFile(
  new URL("../../content-v2.js", import.meta.url),
  "utf8",
);
const douyinKeywordSearchSource = await readFile(
  new URL(
    "../../utils/capture/douyin-keyword-search.js",
    import.meta.url,
  ),
  "utf8",
);

function readBatchFunctionSource() {
  const startMarker = "export async function batchCaptureByKeywords({";
  const endMarker = "export async function lightSampleByKeywords({";
  const start = captureSyncSource.indexOf(startMarker);
  const end = captureSyncSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, "batch keyword function start marker missing");
  assert.notEqual(end, -1, "batch keyword function end marker missing");
  return captureSyncSource.slice(start, end).replace(/^export\s+/u, "");
}

function readKeywordSearchPageUrlInspectorSource() {
  const startMarker = "function inspectKeywordSearchPageUrl(";
  const endMarker = "async function waitForKeywordSearchResultsInTab(";
  const start = captureSyncSource.indexOf(startMarker);
  const end = captureSyncSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, "keyword search URL inspector start marker missing");
  assert.notEqual(end, -1, "keyword search URL inspector end marker missing");
  return captureSyncSource.slice(start, end);
}

function inspectKeywordSearchPageUrl(pageUrl, platform, keyword) {
  const sandbox = vm.createContext({URL});
  vm.runInContext(
    `${readKeywordSearchPageUrlInspectorSource()}\nglobalThis.__inspect = inspectKeywordSearchPageUrl;`,
    sandbox,
  );
  return sandbox.__inspect(pageUrl, platform, keyword);
}

function readCaptureSyncFunctionSource(startMarker, endMarker) {
  const start = captureSyncSource.indexOf(startMarker);
  const end = captureSyncSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} missing`);
  assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
  return captureSyncSource.slice(start, end);
}

function createDouyinKeywordLiteralHarness({
  pageUrl = "https://www.douyin.com/jingxuan/search",
  inputKeyword = "",
} = {}) {
  let searchClicks = 0;

  class FakeHTMLElement {
    constructor({value = "", textContent = "", onClick = null} = {}) {
      this.value = value;
      this.textContent = textContent;
      this.onClick = onClick;
    }

    getBoundingClientRect() {
      return {width: 160, height: 32};
    }

    scrollIntoView() {}

    dispatchEvent() {}

    focus() {}

    click() {
      this.onClick?.();
    }
  }

  const input = new FakeHTMLElement({value: inputKeyword});
  const button = new FakeHTMLElement({
    textContent: "搜索",
    onClick: () => {
      searchClicks += 1;
    },
  });
  const document = {
    querySelector: () => button,
    querySelectorAll: (selector) =>
      String(selector).includes("searchbar-input") ||
      String(selector).includes("contenteditable")
        ? [input]
        : [],
  };
  const context = vm.createContext({
    Array,
    Boolean,
    Error,
    HTMLElement: FakeHTMLElement,
    KeyboardEvent: class {},
    Math,
    MouseEvent: class {},
    Number,
    PointerEvent: class {},
    String,
    URL,
    console: {log() {}},
    document,
    window: {
      location: {href: pageUrl},
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        opacity: "1",
      }),
    },
    MESSAGE_TYPE: {RELAY_TO_CONTENT: "relay"},
    assertNoDouyinSearchSecurityChallengeInTab: async () => {},
    createDouyinSearchSecurityChallengeError: () => new Error("security"),
    createDouyinSearchServiceAbnormalError: () => new Error("service"),
    isDouyinPlatform: (platform) => platform === "douyin",
    isDouyinSearchSecurityChallengeError: () => false,
    isDouyinSearchServiceAbnormalError: () => false,
    readDouyinSearchWorkIdsInTab: async () => ({
      captured: true,
      workIds: ["766193585000009991"],
    }),
  });
  context.chrome = {
    runtime: {
      sendMessage: async () => ({ok: true, data: {ok: true}}),
    },
    scripting: {
      executeScript: async ({func, args = []}) => [{result: func(...args)}],
    },
  };

  vm.runInContext(
    `${readCaptureSyncFunctionSource(
      "async function submitKeywordSearchInTab(",
      "async function readDouyinSearchWorkIdsInTab(",
    )}\n${readCaptureSyncFunctionSource(
      "async function isKeywordSearchTargetReadyInTab(",
      "async function waitForKeywordSearchTargetReadyInTab(",
    )}\nglobalThis.__submit = submitKeywordSearchInTab;\nglobalThis.__targetReady = isKeywordSearchTargetReadyInTab;`,
    context,
  );

  return {
    submit: context.__submit,
    targetReady: context.__targetReady,
    searchClicks: () => searchClicks,
  };
}

function readKeywordSearchReadinessSource() {
  const start = captureSyncSource.indexOf(
    "async function waitForKeywordSearchResultsInTab(",
  );
  const end = captureSyncSource.indexOf(
    "async function closeKeywordSearchFilterPanelInTab(",
    start,
  );
  assert.ok(start >= 0, "keyword readiness helper missing");
  assert.ok(end > start, "keyword readiness helper end marker missing");
  return captureSyncSource.slice(start, end);
}

function createKeywordSearchReadinessHarness({snapshots = [], challenge = null} = {}) {
  let now = 0;
  let snapshotIndex = 0;
  let challengeChecks = 0;
  let executeCalls = 0;
  const context = vm.createContext({
    Array,
    Boolean,
    Date: {now: () => now},
    Error,
    Math,
    Number,
    Set,
    String,
    BATCH_KEYWORD_NAV_POLL_MS: 300,
    BATCH_KEYWORD_RESULTS_KEYWORD_MATCH_GRACE_MS: 6000,
    BATCH_KEYWORD_RESULTS_READY_TIMEOUT_MS: 12000,
    BATCH_KEYWORD_RESULTS_STABLE_POLLS: 2,
    DOUYIN_KEYWORD_RESULTS_READY_TIMEOUT_MS: 45000,
    DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE:
      "DOUYIN_SEARCH_SERVICE_ABNORMAL",
    DOUYIN_SEARCH_SERVICE_ABNORMAL_STABLE_POLLS: 2,
    DOUYIN_SEARCH_SERVICE_ABNORMAL_MIN_STABLE_MS: 1500,
    XHS_SECURITY_PAGE_MARKERS: {},
    assertNoDouyinSearchSecurityChallengeInTab: async () => {
      challengeChecks += 1;
      if (challenge) throw challenge;
    },
    chrome: {
      scripting: {
        async executeScript() {
          executeCalls += 1;
          const snapshot =
            snapshots[Math.min(snapshotIndex, Math.max(0, snapshots.length - 1))] ||
            null;
          snapshotIndex += 1;
          return [{result: snapshot}];
        },
      },
    },
    createDouyinSearchServiceAbnormalError: ({message, pageUrl}) => {
      const error = new Error(message || "service abnormal");
      error.code = "DOUYIN_SEARCH_SERVICE_ABNORMAL";
      error.pageUrl = pageUrl || "";
      return error;
    },
    createXhsSecurityBlockError: () => new Error("xhs security block"),
    inspectKeywordSearchPageUrl: () => ({
      searchPathReady: true,
      keywordConflict: false,
    }),
    waitMsWithStop: async (delayMs) => {
      now += Math.max(100, Number(delayMs) || 0);
    },
  });
  vm.runInContext(
    `${readKeywordSearchReadinessSource()}\nglobalThis.__waitForResults = waitForKeywordSearchResultsInTab;`,
    context,
  );
  return {
    wait: context.__waitForResults,
    stats: () => ({challengeChecks, executeCalls}),
  };
}

function readInlineDouyinChallengeReaderSource() {
  return readCaptureSyncFunctionSource(
    "async function readDouyinSearchSecurityChallengeStateInTab(",
    "async function assertNoDouyinSearchSecurityChallengeInTab(",
  );
}

function createInlineDouyinChallengeHarness({includeDialog = false} = {}) {
  class FakeElement {
    constructor({text = "", insideResultCard = false, containsResult = null} = {}) {
      this.innerText = text;
      this.textContent = text;
      this.insideResultCard = insideResultCard;
      this.containsResult = containsResult;
      this.hidden = false;
      this.nodeType = 1;
      this.parentElement = null;
      this.id = "";
      this.className = "";
    }

    getBoundingClientRect() {
      return {width: 320, height: 80};
    }

    getAttribute() {
      return "";
    }

    closest() {
      let current = this;
      while (current) {
        if (current.insideResultCard) return current;
        current = current.parentElement;
      }
      return null;
    }

    querySelector() {
      return this.containsResult;
    }
  }

  const challengeText =
    "请选择所有符合上述描述的图片，并拖拽到下方 拖拽到这里";
  const body = new FakeElement({text: challengeText});
  const resultCard = new FakeElement({
    text: challengeText,
    insideResultCard: true,
  });
  const caption = new FakeElement({text: challengeText});
  caption.parentElement = resultCard;
  const aggregate = new FakeElement({
    text: `搜索页 ${challengeText}`,
    containsResult: resultCard,
  });
  resultCard.parentElement = aggregate;
  aggregate.parentElement = body;
  const dialog = includeDialog ? new FakeElement({text: challengeText}) : null;
  if (dialog) dialog.parentElement = body;
  const candidates = [aggregate, resultCard, caption].concat(dialog ? [dialog] : []);
  const document = {
    title: "",
    body,
    documentElement: body,
    querySelectorAll(selector) {
      return String(selector) === "iframe" ? [] : candidates;
    },
  };
  const context = vm.createContext({
    Array,
    Boolean,
    Element: FakeElement,
    Error,
    Math,
    Node: {DOCUMENT_NODE: 9},
    Number,
    String,
    URL,
    document,
    window: {
      location: {href: "https://www.douyin.com/jingxuan/search"},
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        opacity: "1",
      }),
    },
  });
  context.chrome = {
    scripting: {
      executeScript: async ({func}) => [{result: func()}],
    },
  };
  vm.runInContext(
    `${readInlineDouyinChallengeReaderSource()}\nglobalThis.__readChallenge = readDouyinSearchSecurityChallengeStateInTab;`,
    context,
  );
  return context.__readChallenge;
}

function createDouyinReadinessIdentityHarness() {
  const block = readKeywordSearchReadinessSource();
  const start = block.indexOf(
    "const extractDouyinWorkIdFromUrlValue = (value) =>",
  );
  const end = block.indexOf("const cardNodes = [];", start);
  assert.ok(start >= 0 && end > start, "Douyin readiness ID resolver missing");

  class FakeElement {
    constructor({attrs = {}, text = "", resultLink = false} = {}) {
      this.attrs = {...attrs};
      this.id = String(attrs.id || "");
      this.innerText = text;
      this.textContent = text;
      this.resultLink = resultLink;
    }

    getAttribute(name) {
      return this.attrs[name] ?? null;
    }

    closest() {
      return null;
    }

    querySelector() {
      return null;
    }

    matches() {
      return this.resultLink;
    }
  }

  const context = vm.createContext({
    Array,
    Element: FakeElement,
    Set,
    String,
    decode: (value) => {
      try {
        return decodeURIComponent(String(value || ""));
      } catch {
        return String(value || "");
      }
    },
    douyinResultLinkSelector:
      'a[href*="/video/"],a[href*="/note/"],a[href*="modal_id="]',
  });
  vm.runInContext(
    `${block.slice(start, end)}\nglobalThis.__resolveWorkId = resolveDouyinWorkId;`,
    context,
  );
  return {FakeElement, resolve: context.__resolveWorkId};
}

function createDouyinSemanticStateProbe({text, wrapperAttributes = {}} = {}) {
  const block = readKeywordSearchReadinessSource();
  const start = block.indexOf("const isVisible = (node) => {");
  const end = block.indexOf(
    "const extractDouyinWorkIdFromUrlValue = (value) =>",
    start,
  );
  assert.ok(start >= 0 && end > start, "Douyin semantic-state probe missing");

  class FakeElement {
    constructor({tagName = "div", textContent = "", attributes = {}} = {}) {
      this.tagName = String(tagName).toLowerCase();
      this.textContent = textContent;
      this.innerText = textContent;
      this.attributes = {...attributes};
      this.id = String(attributes.id || "");
      this.className = String(attributes.class || "");
      this.children = [];
      this.parentElement = null;
      this.nodeType = 1;
      this.hidden = false;
    }

    append(child) {
      child.parentElement = this;
      this.children.push(child);
    }

    getAttribute(name) {
      return this.attributes[name] ?? null;
    }

    getBoundingClientRect() {
      return {width: 120, height: 32};
    }

    matches(selectorList) {
      return String(selectorList || "")
        .split(",")
        .map((selector) => selector.trim())
        .some((selector) => {
          if (!selector) return false;
          if (selector === ".search-result-card") {
            return this.className.split(/\s+/u).includes("search-result-card");
          }
          if (selector === "[data-id]" || selector === "[data-item-id]") {
            return Object.hasOwn(
              this.attributes,
              selector.slice(1, -1),
            );
          }
          if (selector === '[id^="waterfall_item_"]') {
            return this.id.startsWith("waterfall_item_");
          }
          const dedicatedAttribute = selector.match(
            /^\[(data-(?:e2e-aweme-id|aweme-id|awemeid|modal-id))\]$/u,
          )?.[1];
          if (dedicatedAttribute) {
            return Object.hasOwn(this.attributes, dedicatedAttribute);
          }
          const linkMatch = selector.match(
            /^a\[(href|data-href|data-url)\*="([^"]+)"\]$/u,
          );
          return Boolean(
            linkMatch &&
              this.tagName === "a" &&
              String(this.attributes[linkMatch[1]] || "").includes(
                linkMatch[2],
              ),
          );
        });
    }

    closest(selector) {
      let current = this;
      while (current?.nodeType === 1) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    }

    querySelector(selector) {
      const pending = [...this.children];
      while (pending.length > 0) {
        const candidate = pending.shift();
        if (candidate.matches(selector)) return candidate;
        pending.push(...candidate.children);
      }
      return null;
    }
  }

  const wrapper = new FakeElement({attributes: wrapperAttributes});
  const semanticNode = new FakeElement({
    tagName: "span",
    textContent: text,
  });
  wrapper.append(semanticNode);
  const documentNode = {
    nodeType: 9,
    querySelectorAll: () => [semanticNode],
  };
  wrapper.parentElement = documentNode;
  const pageUrl = "https://www.douyin.com/search/test?type=general";
  const context = vm.createContext({
    Boolean,
    Element: FakeElement,
    Node: {DOCUMENT_NODE: 9},
    Number,
    String,
    URL,
    document: documentNode,
    window: {
      location: {href: pageUrl},
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        opacity: "1",
      }),
    },
  });
  vm.runInContext(
    `globalThis.__probe = () => {
      const platformKey = 'douyin';
      ${block.slice(start, end)}
      return {
        cardCount: 0,
        keywordMatched: true,
        pageUrl: window.location.href,
        signature: '',
        workIds: [],
        confirmedEmpty: Boolean(confirmedEmptyNode),
        emptyMessage: confirmedEmptyNode
          ? String(confirmedEmptyNode.innerText || confirmedEmptyNode.textContent || '').trim()
          : '',
      };
    };`,
    context,
  );
  return context.__probe();
}

test("Douyin result readiness keeps waiting for a slow result page by default", () => {
  const start = captureSyncSource.indexOf(
    "async function waitForKeywordSearchResultsInTab(",
  );
  const end = captureSyncSource.indexOf(
    "async function closeKeywordSearchFilterPanelInTab(",
    start,
  );
  const block = captureSyncSource.slice(start, end);
  assert.ok(start >= 0);
  assert.match(
    captureSyncSource,
    /DOUYIN_KEYWORD_RESULTS_READY_TIMEOUT_MS = 45000/u,
  );
  assert.match(block, /timeoutMs = null/u);
  assert.match(
    block,
    /String\(platform \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'douyin'[\s\S]*?DOUYIN_KEYWORD_RESULTS_READY_TIMEOUT_MS/u,
  );
  assert.match(
    block,
    /hasExplicitTimeout \? Number\(timeoutMs\) \|\| 0 : defaultTimeout/u,
    "tests and callers may still request an explicit bounded timeout",
  );
  assert.match(
    block,
    /const cardCount = isDouyinReadiness\s*\? douyinWorkIds\.length/u,
    "Douyin readiness must count only parseable work identities",
  );
  assert.match(block, /const resolveDouyinWorkId = \(node\) =>/u);
  assert.match(
    block,
    /const workId = resolveDouyinWorkId\(item\);[\s\S]*if \(!\/\^\\d\{8,\}\$\/u\.test\(workId\)\) return;/u,
  );
  assert.match(block, /filter\(\(workId\) => \/\^\\d\{8,\}\$\/u\.test\(workId\)\)/u);
  assert.match(block, /DOUYIN_SEARCH_SERVICE_ABNORMAL_STABLE_POLLS/u);
  assert.match(
    captureSyncSource,
    /DOUYIN_SEARCH_SERVICE_ABNORMAL_MIN_STABLE_MS = 1500/u,
  );
  assert.match(
    block,
    /document\.querySelectorAll\(selectors\.join\(','\)\)/u,
    "overlapping card selectors must share one DOM traversal",
  );
  assert.match(
    block,
    /const maxDouyinCandidateNodes = 200/u,
    "each readiness poll must bound deep candidate inspection",
  );
  const resolverStart = block.indexOf("const resolveDouyinWorkId = (node) =>");
  const resolverEnd = block.indexOf("const cardNodes = [];", resolverStart);
  assert.ok(resolverStart >= 0 && resolverEnd > resolverStart);
  assert.doesNotMatch(
    block.slice(resolverStart, resolverEnd),
    /querySelectorAll/u,
    "identity resolution must not rescan every descendant of every candidate",
  );
  assert.doesNotMatch(
    block.slice(resolverStart, resolverEnd),
    /data-id|data-item-id|innerText|textContent/u,
    "generic element IDs and card text are not trusted work identity",
  );
  assert.match(
    block,
    /const signature = isDouyinReadiness\s*\? `\$\{douyinWorkIds\.length\}:\$\{douyinWorkIds\.join\('\|'\)\}`/u,
    "outer stability must ignore dynamic copy but retain visible result order",
  );
  assert.doesNotMatch(
    block,
    /const workIds =[\s\S]{0,500}\.sort\(\)/u,
    "the DOM probe must retain leading-vs-tail result order",
  );
  assert.doesNotMatch(
    block,
    /document\.querySelectorAll\('span, div'\)/u,
    "duration fallback cannot trigger an extra whole-DOM scan",
  );
  assert.match(
    block,
    /const maxDouyinSemanticStateCandidates = 64/u,
    "semantic-state layout checks must be bounded",
  );
  assert.equal(
    (
      block.match(
        /document\.querySelectorAll\(\s*'h1, h2, h3, h4, p, span, div'/gu,
      ) || []
    ).length,
    1,
    "service-abnormal and confirmed-empty recognition must share one flat traversal",
  );
  for (const selector of DOUYIN_DOM_PROFILE.searchResults.cards.cardSelectors) {
    assert.equal(
      block.includes(selector),
      true,
      `readiness must cover the canonical extractor selector: ${selector}`,
    );
  }
  const batchBody = readBatchFunctionSource();
  assert.doesNotMatch(
    batchBody,
    /timeoutMs:\s*12000[\s\S]{0,120}stablePolls:\s*1/u,
    "filtered Douyin readiness must retain the 45s/two-poll defaults",
  );
});

test("Douyin does not treat an older longer keyword as an exact target", async () => {
  const harness = createDouyinKeywordLiteralHarness({inputKeyword: "宝马X3"});

  assert.equal(
    await harness.targetReady(101, {platform: "douyin", keyword: "宝马"}),
    false,
  );
  assert.equal(await harness.submit(101, "douyin", "宝马"), false);
  assert.equal(harness.searchClicks(), 0);

  const submitSource = readCaptureSyncFunctionSource(
    "async function submitKeywordSearchInTab(",
    "async function readDouyinSearchWorkIdsInTab(",
  );
  const targetSource = readCaptureSyncFunctionSource(
    "async function isKeywordSearchTargetReadyInTab(",
    "async function waitForKeywordSearchTargetReadyInTab(",
  );
  const domReadySource = readCaptureSyncFunctionSource(
    "async function isKeywordSearchDomReadyInTab(",
    "function isEmptyKeywordCaptureResult(",
  );
  const readinessSource = readKeywordSearchReadinessSource();
  assert.match(submitSource, /normalize\(inputKeyword\) === expected/u);
  assert.match(targetSource, /normalize\(inputKeyword\) === expected/u);
  assert.match(
    domReadySource,
    /platformKey === 'douyin'[\s\S]*?normalizedInputKeyword === expected/u,
  );
  assert.match(
    readinessSource,
    /platformKey === 'douyin'[\s\S]*?normalizedInputKeyword === expected/u,
  );
});

test("Douyin readiness ignores generic numeric IDs and long account-number text", () => {
  const {FakeElement, resolve} = createDouyinReadinessIdentityHarness();
  assert.equal(
    resolve(
      new FakeElement({
        attrs: {"data-id": "123456789"},
        text: "普通按钮",
      }),
    ),
    "",
  );
  assert.equal(
    resolve(
      new FakeElement({
        text: "账号编号 12345678901234567890",
      }),
    ),
    "",
  );
  assert.equal(
    resolve(
      new FakeElement({
        attrs: {"data-aweme-id": "766193585000009991"},
      }),
    ),
    "766193585000009991",
  );
  assert.equal(
    resolve(
      new FakeElement({
        attrs: {href: "https://www.douyin.com/video/766193585000009992"},
        resultLink: true,
      }),
    ),
    "766193585000009992",
  );
});

test("a generic numeric data-id wrapper cannot hide a stable Douyin service error", async () => {
  const blocking = createDouyinSemanticStateProbe({
    text: "服务出现异常，请稍后重试",
    wrapperAttributes: {"data-id": "123456789"},
  });
  assert.equal(blocking.blockingCode, "DOUYIN_SEARCH_SERVICE_ABNORMAL");

  const harness = createKeywordSearchReadinessHarness({snapshots: [blocking]});
  await assert.rejects(
    harness.wait(101, "douyin", null, {
      keyword: "test",
      stablePolls: 2,
      returnState: true,
    }),
    (error) => error?.code === "DOUYIN_SEARCH_SERVICE_ABNORMAL",
  );
  assert.equal(
    harness.stats().executeCalls,
    6,
    "the generic wrapper must settle as terminal after the 1.5s debounce",
  );
});

test("a generic numeric data-item-id wrapper cannot hide a confirmed empty state", () => {
  const empty = createDouyinSemanticStateProbe({
    text: "暂无相关搜索结果",
    wrapperAttributes: {"data-item-id": "123456789"},
  });
  assert.equal(empty.blockingCode, undefined);
  assert.equal(empty.confirmedEmpty, true);
  assert.equal(empty.emptyMessage, "暂无相关搜索结果");
});

test("a transient Douyin service-abnormal frame does not preempt stable real results", async () => {
  const pageUrl = "https://www.douyin.com/search/test?type=general";
  const stableResult = {
    cardCount: 1,
    workIds: ["766193585000009991"],
    keywordMatched: true,
    pageUrl,
    signature: "766193585000009991|/video/766193585000009991",
  };
  const harness = createKeywordSearchReadinessHarness({
    snapshots: [
      {
        blockingCode: "DOUYIN_SEARCH_SERVICE_ABNORMAL",
        blockingMessage: "服务出现异常，请稍后重试",
        pageUrl,
      },
      stableResult,
      stableResult,
    ],
  });

  const result = await harness.wait(101, "douyin", null, {
    keyword: "test",
    stablePolls: 2,
    returnState: true,
  });

  assert.equal(result.ready, true);
  assert.equal(harness.stats().executeCalls, 3);
});

test("Douyin service-abnormal becomes terminal only after 1.5s of stable observations", async () => {
  const pageUrl = "https://www.douyin.com/search/test?type=general";
  const blocking = {
    blockingCode: "DOUYIN_SEARCH_SERVICE_ABNORMAL",
    blockingMessage: "服务出现异常，请稍后重试",
    pageUrl,
  };
  const harness = createKeywordSearchReadinessHarness({
    snapshots: [blocking, blocking],
  });

  await assert.rejects(
    harness.wait(101, "douyin", null, {
      keyword: "test",
      stablePolls: 2,
      returnState: true,
    }),
    (error) => error?.code === "DOUYIN_SEARCH_SERVICE_ABNORMAL",
  );
  assert.equal(harness.stats().executeCalls, 6);
});

test("two quick Douyin service-abnormal frames still yield to stable real results", async () => {
  const pageUrl = "https://www.douyin.com/search/test?type=general";
  const blocking = {
    blockingCode: "DOUYIN_SEARCH_SERVICE_ABNORMAL",
    blockingMessage: "服务出现异常，请稍后重试",
    pageUrl,
  };
  const stableResult = {
    cardCount: 1,
    workIds: ["766193585000009991"],
    keywordMatched: true,
    pageUrl,
    signature: "766193585000009991|/video/766193585000009991",
  };
  const harness = createKeywordSearchReadinessHarness({
    snapshots: [blocking, blocking, stableResult, stableResult],
  });

  const result = await harness.wait(101, "douyin", null, {
    keyword: "test",
    stablePolls: 2,
    returnState: true,
  });

  assert.equal(result.ready, true);
  assert.equal(harness.stats().executeCalls, 4);
});

test("Douyin readiness stabilizes on work IDs while href and card copy keep changing", async () => {
  const pageUrl = "https://www.douyin.com/search/test?type=general";
  const harness = createKeywordSearchReadinessHarness({
    snapshots: [
      {
        cardCount: 2,
        workIds: ["766193585000009991", "766193585000009992"],
        keywordMatched: true,
        pageUrl,
        signature: "old href|old title",
      },
      {
        cardCount: 2,
        workIds: ["766193585000009991", "766193585000009992"],
        keywordMatched: true,
        pageUrl,
        signature: "new href|live count changed|new title",
      },
    ],
  });

  const result = await harness.wait(101, "douyin", null, {
    keyword: "test",
    stablePolls: 2,
    returnState: true,
  });

  assert.equal(result.ready, true);
  assert.equal(harness.stats().executeCalls, 2);
});

test("Douyin cannot accept the previous keyword cards when a new search submit never takes effect", async () => {
  const pageUrl = "https://www.douyin.com/jingxuan/search";
  const staleResult = {
    cardCount: 2,
    workIds: ["766193585000009991", "766193585000009992"],
    keywordMatched: false,
    pageUrl,
  };
  const harness = createKeywordSearchReadinessHarness({snapshots: [staleResult]});
  const result = await harness.wait(101, "douyin", null, {
    keyword: "new-keyword",
    timeoutMs: 7000,
    stablePolls: 2,
    returnState: true,
    requireResultTransition: true,
    previousWorkIds: staleResult.workIds,
    submitAccepted: false,
  });
  assert.equal(result.ready, false);
});

test("Douyin cannot treat default cards as a first-key transition when the baseline was empty", async () => {
  const defaultResults = {
    cardCount: 2,
    workIds: ["766193585000009993", "766193585000009994"],
    keywordMatched: false,
    pageUrl: "https://www.douyin.com/jingxuan/search",
  };
  const harness = createKeywordSearchReadinessHarness({snapshots: [defaultResults]});
  const result = await harness.wait(101, "douyin", null, {
    keyword: "first-keyword",
    timeoutMs: 7000,
    stablePolls: 2,
    returnState: true,
    requireResultTransition: true,
    previousWorkIds: [],
    submitAccepted: true,
    submissionNonce: "submit-empty-baseline",
  });
  assert.equal(result.ready, false);
});

test("Douyin accepts a stable replacement result set even when its rewritten URL omits the keyword", async () => {
  const pageUrl = "https://www.douyin.com/jingxuan/search";
  const replacement = {
    cardCount: 2,
    workIds: ["766193585000009997", "766193585000009998"],
    keywordMatched: false,
    pageUrl,
    postSubmitGenerationChanged: true,
    submissionNonce: "submit-replacement",
  };
  const harness = createKeywordSearchReadinessHarness({snapshots: [replacement]});
  const result = await harness.wait(101, "douyin", null, {
    keyword: "new-keyword",
    timeoutMs: 7000,
    stablePolls: 2,
    returnState: true,
    requireResultTransition: true,
    previousWorkIds: ["766193585000009991", "766193585000009992"],
    submitAccepted: true,
    submissionNonce: "submit-replacement",
  });
  assert.equal(result.ready, true);
});

test("Douyin accepts a stable strict subset after an acknowledged rewritten-route search", async () => {
  const subset = {
    cardCount: 1,
    workIds: ["766193585000009991"],
    keywordMatched: false,
    pageUrl: "https://www.douyin.com/jingxuan/search",
    postSubmitGenerationChanged: true,
    submissionNonce: "submit-subset",
  };
  const harness = createKeywordSearchReadinessHarness({snapshots: [subset]});
  const result = await harness.wait(101, "douyin", null, {
    keyword: "new-keyword",
    stablePolls: 2,
    returnState: true,
    requireResultTransition: true,
    previousWorkIds: ["766193585000009991", "766193585000009992"],
    submitAccepted: true,
    submissionNonce: "submit-subset",
  });
  assert.equal(result.ready, true);
});

test("Douyin accepts a new leading result while stale virtual cards remain mounted", async () => {
  const mixed = {
    cardCount: 3,
    workIds: [
      "766193585000009999",
      "766193585000009991",
      "766193585000009992",
    ],
    keywordMatched: false,
    pageUrl: "https://www.douyin.com/jingxuan/search",
  };
  const harness = createKeywordSearchReadinessHarness({snapshots: [mixed]});
  const result = await harness.wait(101, "douyin", null, {
    keyword: "new-keyword",
    stablePolls: 2,
    returnState: true,
    requireResultTransition: true,
    previousWorkIds: ["766193585000009991", "766193585000009992"],
    submitAccepted: true,
  });
  assert.equal(result.ready, true);
});

test("Douyin rejects a tail-only lazy append as keyword transition evidence", async () => {
  const appended = {
    cardCount: 3,
    workIds: [
      "766193585000009991",
      "766193585000009992",
      "766193585000009999",
    ],
    keywordMatched: false,
    pageUrl: "https://www.douyin.com/jingxuan/search",
  };
  const harness = createKeywordSearchReadinessHarness({snapshots: [appended]});
  const result = await harness.wait(101, "douyin", null, {
    keyword: "new-keyword",
    timeoutMs: 7000,
    stablePolls: 2,
    returnState: true,
    requireResultTransition: true,
    previousWorkIds: ["766193585000009991", "766193585000009992"],
    submitAccepted: true,
  });
  assert.equal(result.ready, false);
});

test("Douyin rejects old-head eviction plus a new lazy-loaded tail", async () => {
  const virtualized = {
    cardCount: 3,
    workIds: [
      "766193585000009992",
      "766193585000009993",
      "766193585000009999",
    ],
    keywordMatched: false,
    pageUrl: "https://www.douyin.com/jingxuan/search",
  };
  const harness = createKeywordSearchReadinessHarness({snapshots: [virtualized]});
  const result = await harness.wait(101, "douyin", null, {
    keyword: "new-keyword",
    timeoutMs: 7000,
    stablePolls: 2,
    returnState: true,
    requireResultTransition: true,
    previousWorkIds: [
      "766193585000009991",
      "766193585000009992",
      "766193585000009993",
    ],
    submitAccepted: true,
  });
  assert.equal(result.ready, false);
});

test("Douyin submission witness requires a complete result lifecycle", () => {
  const submitSource = readCaptureSyncFunctionSource(
    "async function submitKeywordSearchInTab(",
    "async function readDouyinSearchWorkIdsInTab(",
  );
  assert.match(submitSource, /witness\.sawBusyRoundTrip/u);
  assert.match(submitSource, /witness\.sawClearRepopulated/u);
  assert.match(
    submitSource,
    /baselineRoot\s*&&\s*currentRoot\s*&&\s*currentRoot\s*!==\s*baselineRoot/u,
  );
  assert.doesNotMatch(submitSource, /sawReplaceLifecycle/u);
  assert.doesNotMatch(
    submitSource,
    /baselineCount\s*===\s*0\s*&&\s*currentCount\s*>\s*0/u,
  );
  assert.doesNotMatch(
    submitSource,
    /generationChanged\s*\|\|=\s*Boolean\([\s\S]*?witness\.sawBusy\s*\|\|/u,
  );
});

test("Douyin accepts stable real results after an exact tabs.update navigation", async () => {
  const navigated = {
    cardCount: 2,
    workIds: ["766193585000009997", "766193585000009998"],
    keywordMatched: true,
    pageUrl: "https://www.douyin.com/search/new-keyword?type=general",
  };
  const harness = createKeywordSearchReadinessHarness({snapshots: [navigated]});
  const result = await harness.wait(101, "douyin", null, {
    keyword: "new-keyword",
    stablePolls: 2,
    returnState: true,
    requireResultTransition: true,
    previousWorkIds: [],
    submitAccepted: false,
    navigationTransitionAccepted: true,
  });
  assert.equal(result.ready, true);
});

test("Douyin navigation proof requires a fresh completed document generation", () => {
  const generationSource = readCaptureSyncFunctionSource(
    "async function readDouyinSearchDocumentGenerationInTab(",
    "async function switchDouyinKeywordSearchInTab(",
  );
  const switchSource = readCaptureSyncFunctionSource(
    "async function switchDouyinKeywordSearchInTab(",
    "/**\n * 导航到搜索 URL",
  );
  assert.match(generationSource, /performance\?\.timeOrigin/u);
  assert.match(generationSource, /generation\?\.readyState === 'complete'/u);
  assert.match(
    generationSource,
    /Number\(generation\.timeOrigin\) !== previousTimeOrigin/u,
  );
  assert.match(switchSource, /waitForFreshDouyinSearchDocumentInTab/u);
  assert.doesNotMatch(
    switchSource,
    /exactNavigationTargetReady\) \{\s*navigationTransitionAccepted = true/u,
  );
});

test("Douyin accepts identical IDs only with matching post-submit generation proof", async () => {
  const pageUrl = "https://www.douyin.com/jingxuan/search";
  const generationResult = {
    cardCount: 2,
    workIds: ["766193585000009991", "766193585000009992"],
    keywordMatched: false,
    pageUrl,
    postSubmitGenerationChanged: true,
    submissionNonce: "submit-generation",
  };
  const generationHarness = createKeywordSearchReadinessHarness({
    snapshots: [generationResult],
  });
  const generationAccepted = await generationHarness.wait(
    101,
    "douyin",
    null,
    {
      keyword: "new-keyword",
      stablePolls: 2,
      returnState: true,
      requireResultTransition: true,
      previousWorkIds: generationResult.workIds,
      submitAccepted: true,
      submissionNonce: "submit-generation",
    },
  );
  assert.equal(generationAccepted.ready, true);

  const exactKeywordResult = {...generationResult, keywordMatched: true};
  delete exactKeywordResult.postSubmitGenerationChanged;
  delete exactKeywordResult.submissionNonce;
  const exactHarness = createKeywordSearchReadinessHarness({
    snapshots: [exactKeywordResult],
  });
  const exactAccepted = await exactHarness.wait(101, "douyin", null, {
    keyword: "new-keyword",
    timeoutMs: 7000,
    stablePolls: 2,
    returnState: true,
    requireResultTransition: true,
    previousWorkIds: exactKeywordResult.workIds,
    submitAccepted: true,
  });
  assert.equal(
    exactAccepted.ready,
    false,
    "the input updates before the result generation and cannot prove replacement",
  );
});

test("Douyin confirmed-empty requires the matching post-submit generation", async () => {
  const staleEmpty = {
    cardCount: 0,
    workIds: [],
    keywordMatched: true,
    pageUrl: "https://www.douyin.com/search/new-keyword?type=general",
    confirmedEmpty: true,
    emptyMessage: "暂无相关搜索结果",
  };
  const staleHarness = createKeywordSearchReadinessHarness({
    snapshots: [staleEmpty],
  });
  const staleResult = await staleHarness.wait(101, "douyin", null, {
    keyword: "new-keyword",
    timeoutMs: 7000,
    stablePolls: 2,
    returnState: true,
    requireResultTransition: true,
    previousWorkIds: [],
    submitAccepted: true,
    submissionNonce: "submit-empty",
  });
  assert.equal(staleResult.confirmedEmpty, false);

  const refreshedEmpty = {
    ...staleEmpty,
    postSubmitGenerationChanged: true,
    submissionNonce: "submit-empty",
  };
  const refreshedHarness = createKeywordSearchReadinessHarness({
    snapshots: [refreshedEmpty],
  });
  const refreshedResult = await refreshedHarness.wait(101, "douyin", null, {
    keyword: "new-keyword",
    stablePolls: 2,
    returnState: true,
    requireResultTransition: true,
    previousWorkIds: [],
    submitAccepted: true,
    submissionNonce: "submit-empty",
  });
  assert.equal(refreshedResult.confirmedEmpty, true);
});

test("Douyin rejects changed cards when the search dispatch was not acknowledged", async () => {
  const changed = {
    cardCount: 1,
    workIds: ["766193585000009999"],
    keywordMatched: true,
    pageUrl: "https://www.douyin.com/search/new-keyword?type=general",
  };
  const harness = createKeywordSearchReadinessHarness({snapshots: [changed]});
  const result = await harness.wait(101, "douyin", null, {
    keyword: "new-keyword",
    timeoutMs: 7000,
    stablePolls: 2,
    returnState: true,
    requireResultTransition: true,
    previousWorkIds: ["766193585000009991"],
    submitAccepted: false,
  });
  assert.equal(result.ready, false);
});

test("Douyin security challenge still stops before any readiness DOM probe", async () => {
  const challenge = new Error("captcha");
  challenge.code = "DOUYIN_SEARCH_SECURITY_CHALLENGE";
  const harness = createKeywordSearchReadinessHarness({challenge});

  await assert.rejects(
    harness.wait(101, "douyin", null, {
      keyword: "test",
      returnState: true,
    }),
    (error) => error === challenge,
  );
  assert.deepEqual(harness.stats(), {challengeChecks: 1, executeCalls: 0});
});

test("the inline background guard ignores challenge wording inherited from result cards", async () => {
  const readChallenge = createInlineDouyinChallengeHarness();
  const state = await readChallenge(101);
  assert.equal(state.detected, false);
});

test("the inline background guard still detects a sibling challenge dialog", async () => {
  const readChallenge = createInlineDouyinChallengeHarness({includeDialog: true});
  const state = await readChallenge(101);
  assert.equal(state.detected, true);
  assert.equal(state.evidence, "semantic_image_challenge");
});

function createBatchHarness({
  captureKeyword,
  afterKeywordCapture = null,
  switchDouyinKeyword = null,
  waitForResults = null,
  hasActiveFilters = false,
  assertNoSecurityChallenge = null,
} = {}) {
  const captureCalls = [];
  const filterCalls = [];
  const navigationCalls = [];
  const submitCalls = [];
  const settled = [];
  const progress = [];
  const pacingCalls = [];
  const liveTabs = new Map([
    [101, {id: 101, windowId: 7, groupId: 9, url: "https://www.xiaohongshu.com/search_result"}],
  ]);
  const replacementListeners = new Set();

  const chrome = {
    tabs: {
      get: async (tabId) => {
        const tab = liveTabs.get(Number(tabId));
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return {...tab};
      },
      update: async (tabId, update = {}) => {
        const tab = liveTabs.get(Number(tabId));
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        Object.assign(tab, update);
        return {...tab};
      },
      onReplaced: {
        addListener(listener) {
          replacementListeners.add(listener);
        },
        removeListener(listener) {
          replacementListeners.delete(listener);
        },
      },
    },
  };

  const replaceRunnerTab = (addedTabId, removedTabId) => {
    const removed = liveTabs.get(Number(removedTabId));
    liveTabs.delete(Number(removedTabId));
    liveTabs.set(Number(addedTabId), {
      ...(removed || {}),
      id: Number(addedTabId),
    });
    for (const listener of replacementListeners) {
      listener(Number(addedTabId), Number(removedTabId));
    }
  };

  const context = {
    BATCH_INTER_KEYWORD_DELAY_MAX_MS: 0,
    BATCH_INTER_KEYWORD_DELAY_MIN_MS: 0,
    BATCH_KEYWORD_AFTER_NAV_WAIT_MS: 0,
    BATCH_KEYWORD_EMPTY_RETRY_WAIT_MS: 0,
    DOUYIN_SEARCH_SECURITY_CHALLENGE_CODE:
      "DOUYIN_SEARCH_SECURITY_CHALLENGE",
    Math,
    activateTabForReliableTimer: async () => {},
    buildInterKeywordDelayMessage: ({keyword}) => `next:${keyword}`,
    buildKeywordSearchUrl: (keyword, platform) =>
      platform === "douyin"
        ? `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=general`
        : `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`,
    captureAndSaveInTab: async (options) => {
      captureCalls.push({
        keyword: options.captureParams.keyword,
        tabId: options.tabId,
      });
      return await captureKeyword(options, captureCalls.length);
    },
    chrome,
    closeKeywordSearchFilterPanelInTab: async () => {},
    createCaptureRequestId: () => "list-run-test",
    formatEnhanceSkipReason: (reason) => reason || "",
    getCurrentActiveTab: async () => liveTabs.get(101),
    hasActiveBatchSearchFilters: () => hasActiveFilters,
    assertNoDouyinSearchSecurityChallengeInTab: async (tabId) => {
      if (typeof assertNoSecurityChallenge === "function") {
        await assertNoSecurityChallenge({tabId});
      }
    },
    isBatchCaptureCanceledError: (error) =>
      ["BATCH_CAPTURE_CANCELED", "DETAIL_CAPTURE_CANCELED"].includes(
        String(error?.message || ""),
      ),
    isCaptureCanceledResult: (result) =>
      Boolean(
        result?.canceled ||
          ["CAPTURE_CANCELED", "BATCH_CAPTURE_CANCELED"].includes(
            String(result?.error?.code || ""),
          ),
      ),
    isDouyinPlatform: (platform) => platform === "douyin",
    isDouyinSearchSecurityChallengeError: (error) =>
      String(error?.code || "").toUpperCase() ===
      "DOUYIN_SEARCH_SECURITY_CHALLENGE",
    isEmptyKeywordCaptureResult: (result) =>
      Boolean(result?.ok && Array.isArray(result?.data?.items) && result.data.items.length === 0),
    isUnattendedSafetyBlock: (value) =>
      Boolean(
        value?.securityBlocked ||
          value?.platformSafetyBlocked,
      ),
    applySearchFiltersInTab: async (tabId, filters, applyOptions = {}) => {
      filterCalls.push({tabId, filters, applyOptions});
      return {
        applied: true,
        complete: true,
        results: [{field: "sort", applied: true, changed: true}],
      };
    },
    beginDouyinSearchResultTransitionInTab: async () => ({
      baselineCaptured: true,
      previousWorkIds: ["766193585000009991"],
      submissionNonce: "filter-submit",
    }),
    navigateToSearchUrl: async (tabId, url) => {
      navigationCalls.push({tabId, url});
    },
    normalizeUrlWithoutHash: (url) => String(url || "").split("#")[0],
    prepareDetailBatchRunnerContext: async () => ({
      runnerTabId: 101,
      sourceTabId: 101,
      shouldRestoreSourcePage: false,
      sourcePageUrl: "",
    }),
    setCaptureTaskTakeoverStateInTab: async () => {},
    submitKeywordSearchInTab: async (tabId, platform, keyword) => {
      submitCalls.push({tabId, platform, keyword});
      return {
        accepted: true,
        baselineCaptured: true,
        previousWorkIds: ["766193585000009991"],
        submissionNonce: `resubmit-${submitCalls.length}`,
      };
    },
    switchDouyinKeywordSearchInTab: async (tabId, keyword, url) => {
      navigationCalls.push({tabId, keyword, url, platform: "douyin"});
      if (typeof switchDouyinKeyword === "function") {
        return await switchDouyinKeyword({tabId, keyword, url});
      }
      return {
        baselineCaptured: true,
        previousWorkIds: [],
        submitAccepted: true,
        submissionNonce: "batch-submit",
        navigationTransitionAccepted: false,
      };
    },
    waitForKeywordSearchResultsInTab: async (tabId, platform, shouldStop, options) =>
      typeof waitForResults === "function"
        ? await waitForResults({tabId, platform, shouldStop, ...(options || {})})
        : true,
    waitForDouyinSearchPacingWindow: async (tabId, shouldStop, options = {}) => {
      pacingCalls.push({tabId, phase: options.phase || "search"});
    },
    waitMsWithStop: async () => {},
    waitMsWithStopAndTick: async () => {},
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(
    `${readBatchFunctionSource()}\nglobalThis.__runBatch = batchCaptureByKeywords;`,
    sandbox,
  );

  const run = (options = {}) =>
    sandbox.__runBatch({
      keywords: options.keywords || [],
      platform: options.platform || "xiaohongshu",
      sourceTabId: 101,
      baseSearchUrl: "https://www.xiaohongshu.com/search_result",
      afterKeywordCapture: options.afterKeywordCapture ?? afterKeywordCapture,
      onKeywordSettled: async (payload) => settled.push(payload),
      onProgress: (payload) => progress.push(payload),
      searchFilters: options.searchFilters || null,
      disableAutomaticSearchRetry:
        options.disableAutomaticSearchRetry === true,
      requireVerifiedFilters: options.requireVerifiedFilters === true,
      shouldStop: options.shouldStop || (() => false),
    });

  return {
    captureCalls,
    filterCalls,
    navigationCalls,
    pacingCalls,
    progress,
    getReplacementListenerCount: () => replacementListeners.size,
    replaceRunnerTab,
    run,
    settled,
    submitCalls,
  };
}

function successCapture(keyword) {
  return {
    ok: true,
    captureResult: {ok: true, data: {items: [{id: `${keyword}-item`}]}},
    recordIds: [`${keyword}-record`],
    savedRecords: [],
  };
}

test("Douyin restores a paced settle window after search and filtering", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) =>
      successCapture(captureParams.keyword),
    hasActiveFilters: true,
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1"],
    searchFilters: {sort: "latest", publishTime: "day"},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    harness.pacingCalls.map((entry) => entry.phase),
    ["search", "filter"],
  );
});

test("the batch readiness gate receives the exact pre-submit Douyin result identity", async () => {
  const readinessCalls = [];
  const previousWorkIds = ["766193585000009991", "766193585000009992"];
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) =>
      successCapture(captureParams.keyword),
    switchDouyinKeyword: async () => ({
      baselineCaptured: true,
      previousWorkIds,
      submitAccepted: true,
      submissionNonce: "batch-submit",
      navigationTransitionAccepted: false,
    }),
    waitForResults: async (options) => {
      readinessCalls.push(options);
      return true;
    },
  });
  const result = await harness.run({platform: "douyin", keywords: ["词1"]});
  assert.equal(result.ok, true);
  assert.equal(readinessCalls[0].requireResultTransition, true);
  assert.deepEqual(readinessCalls[0].previousWorkIds, previousWorkIds);
  assert.equal(readinessCalls[0].submitAccepted, true);
  assert.equal(readinessCalls[0].submissionNonce, "batch-submit");
});

test("a no-op filter retry cannot fall through to Douyin capture", async () => {
  const readinessCalls = [];
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) =>
      successCapture(captureParams.keyword),
    hasActiveFilters: true,
    waitForResults: async (options) => {
      readinessCalls.push(options);
      if (readinessCalls.length === 1) return true;
      return false;
    },
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1"],
    searchFilters: {sort: "latest"},
  });

  assert.equal(result.ok, false);
  assert.equal(harness.captureCalls.length, 0);
  assert.equal(harness.submitCalls.length, 1);
  const retryReadiness = readinessCalls[2];
  assert.equal(retryReadiness.requireResultTransition, true);
  assert.equal(retryReadiness.submitAccepted, true);
  assert.equal(retryReadiness.submissionNonce, "resubmit-1");
  assert.deepEqual(retryReadiness.previousWorkIds, ["766193585000009991"]);
});

test("an empty-result no-op resubmit cannot launch a second Douyin capture", async () => {
  const readinessCalls = [];
  const harness = createBatchHarness({
    captureKeyword: async () => ({
      ok: true,
      captureResult: {ok: true, data: {items: []}},
      recordIds: [],
      savedRecords: [],
    }),
    waitForResults: async (options) => {
      readinessCalls.push(options);
      return readinessCalls.length === 1;
    },
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1"],
  });

  assert.equal(result.ok, false);
  assert.equal(harness.captureCalls.length, 1);
  assert.equal(harness.submitCalls.length, 1);
  assert.equal(readinessCalls[1].requireResultTransition, true);
  assert.equal(readinessCalls[1].submitAccepted, true);
  assert.equal(readinessCalls[1].submissionNonce, "resubmit-1");
  assert.deepEqual(
    readinessCalls[1].previousWorkIds,
    ["766193585000009991"],
  );
});

test("one empty keyword retry does not truncate the remaining 12 keyword plan", async () => {
  const attempts = new Map();
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => {
      const keyword = captureParams.keyword;
      const attempt = (attempts.get(keyword) || 0) + 1;
      attempts.set(keyword, attempt);
      if (keyword === "词1") {
        return {
          ok: true,
          captureResult: {ok: true, data: {items: []}},
          recordIds: [],
          savedRecords: [],
        };
      }
      return successCapture(keyword);
    },
  });
  const keywords = Array.from({length: 13}, (_, index) => `词${index + 1}`);

  const result = await harness.run({keywords});

  assert.equal(attempts.get("词1"), 2, "the empty first keyword must retry exactly once");
  assert.equal(result.stats.total, 13);
  assert.equal(result.stats.processed, 13);
  assert.equal(result.results.length, 13);
  assert.equal(result.results[0].ok, false);
  assert.equal(
    Array.from(result.results.slice(1), (item) => item.keyword).join("\n"),
    keywords.slice(1).join("\n"),
  );
  assert.equal(harness.settled.length, 13, "every keyword must reach the checkpoint reporter");
  assert.equal(result.canceled, false);
});

test("a strict sequential patrol never repeats an empty search and still settles later keywords", async () => {
  const attempts = new Map();
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => {
      const keyword = captureParams.keyword;
      attempts.set(keyword, (attempts.get(keyword) || 0) + 1);
      if (keyword === "词1") {
        return {
          ok: true,
          captureResult: {ok: true, data: {items: []}},
          recordIds: [],
          savedRecords: [],
        };
      }
      return successCapture(keyword);
    },
    hasActiveFilters: true,
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1", "词2"],
    searchFilters: {contentType: "image"},
    disableAutomaticSearchRetry: true,
    requireVerifiedFilters: true,
  });

  assert.equal(attempts.get("词1"), 1);
  assert.equal(attempts.get("词2"), 1);
  assert.equal(harness.submitCalls.length, 0, "no hidden search submit is allowed");
  assert.equal(harness.filterCalls.length, 2);
  assert.ok(harness.filterCalls.every(call =>
    call.applyOptions.requireVerifiedFilters === true));
  assert.equal(result.stats.processed, 2);
  assert.equal(result.results.length, 2);
  assert.equal(result.canceled, false);
});

test("verified sequential-patrol filters fail closed instead of falling through to capture", () => {
  const filterStart = captureSyncSource.indexOf(
    "function createSearchFilterApplicationError(",
  );
  const filterEnd = captureSyncSource.indexOf(
    "async function waitForKeywordSearchResultsInTab(",
    filterStart,
  );
  const filterSource = captureSyncSource.slice(filterStart, filterEnd);

  assert.match(filterSource, /SEARCH_FILTER_APPLICATION_FAILED/u);
  assert.match(filterSource, /error\.fatal = true/u);
  assert.match(filterSource, /error\.stopBatch = true/u);
  assert.match(filterSource, /error\.requiresManualAction = true/u);
  assert.match(filterSource, /result\?\.complete !== true/u);
  assert.match(captureSyncSource, /verifyDefaults: requireVerifiedFilters/u);
  assert.match(contentSource, /verifyDefaults: request\?\.verifyDefaults === true/u);
  assert.match(contentSource, /verifyDefaults[\s\S]*item\.platforms\.includes\(platform\)/u);
  assert.match(contentSource, /const alreadyActive = isBatchFilterOptionActive/u);
  assert.match(contentSource, /changed: ok && !alreadyActive/u);
});

test("a drifted Douyin search page fails only the current keyword and continues", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    waitForResults: async ({keyword}) => keyword !== "词1",
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1", "词2"],
  });

  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词2"],
    "a stale /jingxuan page must never be captured as the failed keyword",
  );
  assert.equal(result.canceled, false);
  assert.equal(result.stats.processed, 2);
  assert.equal(result.stats.success, 1);
  assert.equal(result.stats.failed, 1);
  assert.equal(harness.settled.length, 2);
  assert.equal(harness.settled[0].keyword, "词1");
  assert.equal(harness.settled[0].result.ok, false);
  assert.equal(harness.settled[1].keyword, "词2");
  assert.equal(harness.settled[1].result.ok, true);
});

test("a confirmed empty Douyin result settles as a successful zero-result keyword", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) =>
      successCapture(captureParams.keyword),
    waitForResults: async ({keyword}) =>
      keyword === "词1"
        ? {
            ready: false,
            confirmedEmpty: true,
            emptyMessage: "暂无相关内容",
            pageUrl: "https://www.douyin.com/search/%E8%AF%8D1?type=general",
          }
        : {ready: true, confirmedEmpty: false},
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1", "词2"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.canceled, false);
  assert.equal(result.stats.success, 2);
  assert.equal(result.stats.failed, 0);
  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词2"],
    "an explicitly empty keyword must not enter list capture",
  );
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].noResults, true);
  assert.equal(result.results[0].resultKind, "no_matching_results");
  assert.equal(harness.settled[0].result.noResults, true);
  assert.equal(
    harness.progress.some(
      (entry) =>
        entry.keyword === "词1" &&
        entry.phase === "no_matching_results",
    ),
    true,
  );
});

test("Douyin service-abnormal state fails the current keyword and continues the next", async () => {
  let readinessChecks = 0;
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) =>
      successCapture(captureParams.keyword),
    hasActiveFilters: true,
    waitForResults: async () => {
      readinessChecks += 1;
      if (readinessChecks === 2) {
        const error = new Error(
          "抖音当前关键词搜索暂时不可用，已结束本词并继续下一个关键词",
        );
        error.code = "DOUYIN_SEARCH_SERVICE_ABNORMAL";
        error.category = "platform_service_abnormal";
        error.retryable = true;
        throw error;
      }
      return true;
    },
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1", "词2"],
    searchFilters: {sort: "latest", publishTime: "day"},
  });

  assert.equal(result.canceled, false);
  assert.equal(result.securityBlocked, false);
  assert.equal(result.requiresManualAction, false);
  assert.equal(result.blockingError, null);
  assert.deepEqual(
    harness.captureCalls.map((entry) => entry.keyword),
    ["词2"],
  );
  assert.equal(harness.filterCalls.length, 2);
  assert.equal(
    harness.submitCalls.length,
    0,
    "the service-abnormal word must fail before the generic filter retry path",
  );
  assert.deepEqual(
    harness.navigationCalls.map((entry) => entry.keyword),
    ["词1", "词2"],
    "the second keyword must start after the first search request fails",
  );
  assert.equal(harness.settled.length, 2);
  assert.equal(harness.settled[0].keyword, "词1");
  assert.equal(harness.settled[0].securityBlocked, false);
  assert.equal(
    harness.settled[0].result.errorCode,
    "DOUYIN_SEARCH_SERVICE_ABNORMAL",
  );
  assert.equal(harness.settled[1].keyword, "词2");
  assert.equal(harness.settled[1].result.ok, true);
  assert.equal(result.stats.success, 1);
  assert.equal(result.stats.failed, 1);
  assert.equal(harness.progress.at(-1)?.phase, "done");
});

test("Douyin security challenge stops the whole keyword batch for human action", async () => {
  let readinessChecks = 0;
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) =>
      successCapture(captureParams.keyword),
    waitForResults: async () => {
      readinessChecks += 1;
      if (readinessChecks === 1) {
        const error = new Error(
          "检测到抖音图片安全验证，已停止后续搜索并保留已发现结果",
        );
        error.code = "DOUYIN_SEARCH_SECURITY_CHALLENGE";
        error.category = "platform_safety_block";
        error.securityBlocked = true;
        error.platformSafetyBlocked = true;
        error.requiresManualAction = true;
        error.stopBatch = true;
        error.fatal = true;
        error.retryable = false;
        throw error;
      }
      return true;
    },
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1", "词2"],
  });

  assert.equal(result.canceled, true);
  assert.equal(result.securityBlocked, true);
  assert.equal(result.platformSafetyBlocked, true);
  assert.equal(result.requiresManualAction, true);
  assert.equal(
    result.blockingError?.code,
    "DOUYIN_SEARCH_SECURITY_CHALLENGE",
  );
  assert.deepEqual(harness.captureCalls, []);
  assert.deepEqual(
    harness.navigationCalls.map((entry) => entry.keyword),
    ["词1"],
  );
  assert.equal(harness.settled.length, 1);
  assert.equal(harness.progress.at(-1)?.phase, "needs_action");
});

test("a challenge appearing during the safety delay preserves the settled keyword and never searches the next", async () => {
  let safetyChecks = 0;
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) =>
      successCapture(captureParams.keyword),
    assertNoSecurityChallenge: async () => {
      safetyChecks += 1;
      if (safetyChecks === 2) {
        const error = new Error(
          "检测到抖音图片安全验证，已停止后续搜索并保留已发现结果",
        );
        error.code = "DOUYIN_SEARCH_SECURITY_CHALLENGE";
        error.category = "platform_safety_block";
        error.securityBlocked = true;
        error.platformSafetyBlocked = true;
        error.requiresManualAction = true;
        error.stopBatch = true;
        error.fatal = true;
        error.retryable = false;
        throw error;
      }
    },
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1", "词2"],
  });

  assert.equal(result.canceled, true);
  assert.equal(result.securityBlocked, true);
  assert.equal(result.stats.success, 1);
  assert.equal(result.stats.failed, 0);
  assert.deepEqual(
    harness.captureCalls.map((entry) => entry.keyword),
    ["词1"],
  );
  assert.deepEqual(
    harness.navigationCalls.map((entry) => entry.keyword),
    ["词1"],
  );
  assert.equal(harness.settled.length, 1);
  assert.equal(harness.settled[0].result.ok, true);
});

test("a blocked list capture persists its partial payload before returning the safety error", () => {
  const start = captureSyncSource.indexOf(
    "async function captureAndSaveInTab({",
  );
  const end = captureSyncSource.indexOf(
    "async function captureBatchByUrls(",
    start,
  );
  const source = captureSyncSource.slice(start, end);
  assert.match(
    source,
    /captureResult\?\.partial === true[\s\S]*saveCaptureResultRecords[\s\S]*recordIds: partialRecordIds/u,
  );
});

test("a challenge race harvests only same-keyword mounted links before returning the partial result", () => {
  assert.match(
    douyinKeywordSearchSource,
    /const preserveMountedResultsAfterSecurityChallenge = \(\) => \{[\s\S]*!mountedKeyword[\s\S]*mountedKeyword !== expectedKeyword[\s\S]*extractDouyinSearchCards\(searchRoot\)[\s\S]*recoveredFromMountedResults: true/u,
  );
  assert.match(
    douyinKeywordSearchSource,
    /if \(securityChallenge\) \{\s*try \{\s*preserveMountedResultsAfterSecurityChallenge\(\);[\s\S]*Preservation is best-effort[\s\S]*\}[\s]*\}[\s\S]*const partialPayload/u,
  );
  assert.match(
    douyinKeywordSearchSource,
    /if \(outcome\?\.error\) \{[\s\S]*Safety must win the race[\s\S]*assertNoSecurityChallenge\(\);[\s\S]*throw outcome\.error;/u,
  );
});

test("Douyin checks the service-abnormal guard before clicking search or filters", () => {
  const submitStart = captureSyncSource.indexOf(
    "async function submitKeywordSearchInTab(",
  );
  const submitEnd = captureSyncSource.indexOf(
    "async function switchDouyinKeywordSearchInTab(",
    submitStart,
  );
  const submitSource = captureSyncSource.slice(submitStart, submitEnd);
  const guardIndex = submitSource.indexOf(
    "action: 'assertNoDouyinSearchServiceAbnormal'",
  );
  const clickScriptIndex = submitSource.indexOf(
    "const result = await chrome.scripting",
  );
  assert.ok(guardIndex > -1);
  assert.ok(clickScriptIndex > guardIndex);

  assert.match(
    contentSource,
    /case "assertNoDouyinSearchServiceAbnormal":[\s\S]*handleAssertNoDouyinSearchServiceAbnormal/u,
  );
  assert.match(
    contentSource,
    /function handleAssertNoDouyinSearchServiceAbnormal[\s\S]*assertNoDouyinSearchSecurityChallengePage\(\);[\s\S]*assertNoDouyinSearchServiceAbnormalPage\(\);/u,
  );
  assert.match(
    submitSource,
    /isDouyinSearchSecurityChallengeError\(guardError\)[\s\S]*createDouyinSearchSecurityChallengeError/u,
  );
  const filterStart = contentSource.indexOf(
    "async function applyBatchSearchFilters({",
  );
  const filterEnd = contentSource.indexOf(
    "async function prepareKeywordStrategyCapture()",
    filterStart,
  );
  const filterSource = contentSource.slice(filterStart, filterEnd);
  const filterGuardIndex = filterSource.indexOf(
    "assertNoDouyinSearchServiceAbnormalPage();",
  );
  const filterRequestsIndex = filterSource.indexOf("const filterRequests =");
  assert.ok(filterGuardIndex > -1);
  assert.ok(filterRequestsIndex > filterGuardIndex);

  assert.match(
    captureSyncSource,
    /async function waitForKeywordSearchTargetReadyInTab[\s\S]*isDouyinPlatform\(navigationContext\?\.platform\)[\s\S]*assertNoDouyinSearchSecurityChallengeInTab\(tabId\)[\s\S]*isKeywordSearchTargetReadyInTab/u,
  );
});

test("Douyin readiness rejects recommendation, detail, modal, and another keyword URLs", () => {
  assert.deepEqual(
    {...inspectKeywordSearchPageUrl(
      "https://www.douyin.com/search/%E5%87%AF%E8%BF%AA%E6%8B%89%E5%85%8B?type=general",
      "douyin",
      "凯迪拉克",
    )},
    {searchPathReady: true, keywordConflict: false},
  );
  assert.deepEqual(
    {...inspectKeywordSearchPageUrl(
      "https://www.douyin.com/jingxuan",
      "douyin",
      "凯迪拉克",
    )},
    {searchPathReady: false, keywordConflict: false},
  );
  assert.equal(
    inspectKeywordSearchPageUrl(
      "https://www.douyin.com/search/%E5%87%AF%E8%BF%AA%E6%8B%89%E5%85%8B?modal_id=123",
      "douyin",
      "凯迪拉克",
    ).searchPathReady,
    false,
  );
  assert.equal(
    inspectKeywordSearchPageUrl(
      "https://www.douyin.com/video/123",
      "douyin",
      "凯迪拉克",
    ).searchPathReady,
    false,
  );
  assert.deepEqual(
    {...inspectKeywordSearchPageUrl(
      "https://www.douyin.com/search/%E5%88%AB%E5%85%8B?type=general",
      "douyin",
      "凯迪拉克",
    )},
    {searchPathReady: true, keywordConflict: true},
  );
});

test("the Douyin fail-closed guard does not make XHS slow readiness fail early", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    waitForResults: async () => false,
  });

  const result = await harness.run({
    platform: "xiaohongshu",
    keywords: ["词1"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词1"],
  );
});

test("Douyin filter reapply must prove results are ready before recapture", () => {
  assert.match(
    readBatchFunctionSource(),
    /const refilteredResultsReady =[\s\S]*?if \(!refilteredResultsReady\) \{[\s\S]*?重挂筛选后搜索结果页仍未就绪/,
  );
});

test("keyword three uses the replacement runner tab id after keyword two", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async ({current}) => {
      if (current === 2) harness.replaceRunnerTab(202, 101);
      return {ok: true};
    },
  });

  const result = await harness.run({keywords: ["词1", "词2", "词3"]});

  assert.equal(result.ok, true);
  assert.deepEqual(
    harness.captureCalls.map((call) => call.tabId),
    [101, 101, 202],
  );
  assert.equal(harness.settled[2].runnerTabId, 202);
});

test("non-user detail cancellation marks the keyword partial and continues", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async ({current}) =>
      current === 1
        ? {
            ok: false,
            canceled: true,
            runnerInterrupted: true,
            error: {code: "RUNNER_TAB_UNAVAILABLE", message: "temporary runner lost"},
          }
        : {ok: true},
  });

  const result = await harness.run({keywords: ["词1", "词2", "词3"]});

  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词1", "词2", "词3"],
  );
  assert.equal(result.canceled, false);
  assert.equal(result.results[0].partial, true);
  assert.equal(result.results[0].canceled, false);
  assert.equal(harness.settled[0].canceled, false);
});

test("nonempty keyword records cannot silently settle an anomalous no-target enhancement skip", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async ({current, recordIds}) =>
      current === 1
        ? {
            skipped: true,
            reason: "no_target_records",
          }
        : {
            ok: true,
            canceled: false,
            successCount: recordIds.length,
            failedCount: 0,
            results: recordIds.map((recordId) => ({recordId, ok: true})),
          },
  });

  const result = await harness.run({keywords: ["词1", "词2"]});

  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词1", "词2"],
    "a defensive partial settlement must not truncate the remaining plan",
  );
  assert.equal(result.results[0].enhanceStatus, "failed");
  assert.equal(result.results[0].partial, true);
  assert.equal(harness.settled[0].result.partial, true);
  assert.equal(result.results[1].enhanceStatus, "done");
  assert.equal(
    harness.progress.some(
      (entry) => entry.keyword === "词1" && entry.phase === "enhance_skipped",
    ),
    false,
    "a nonempty explicit batch must not be reported as an ordinary skip",
  );
});

test("runner interruption without canceled flag is checkpointed and continues to the next keyword", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async ({current}) =>
      current === 1
        ? {
            ok: false,
            canceled: false,
            runnerInterrupted: true,
            results: [
              {
                recordId: "词1-record",
                ok: false,
                reason: "CONTEXT_INTERRUPTED",
                category: "context_interrupted",
                runnerInterrupted: true,
              },
            ],
          }
        : {ok: true},
  });

  const result = await harness.run({keywords: ["词1", "词2", "词3"]});

  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词1", "词2", "词3"],
  );
  assert.equal(result.canceled, false);
  assert.equal(result.recoveryRequired, false);
  assert.equal(result.results[0].partial, true);
  assert.equal(result.results[0].enhanceStatus, "failed");
  assert.equal(result.results[0].enhanceResult.runnerInterrupted, true);
  assert.equal(harness.settled.length, 3);
  assert.equal(harness.settled[0].canceled, false);
  assert.equal(harness.progress.at(-1)?.phase, "done");
});

test("an explicit user stop still terminates the keyword plan", async () => {
  let stopped = false;
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async () => {
      stopped = true;
      return {ok: false, canceled: true, userCanceled: true};
    },
  });

  const result = await harness.run({
    keywords: ["词1", "词2", "词3"],
    shouldStop: () => stopped,
  });

  assert.equal(result.canceled, true);
  assert.deepEqual(harness.captureCalls.map((call) => call.keyword), ["词1"]);
});

test("an explicit fatal detail failure stops after the current keyword", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async () => ({
      ok: false,
      fatal: true,
      error: {code: "FATAL_CAPTURE_STATE", message: "identity contract lost"},
    }),
  });

  const result = await harness.run({keywords: ["词1", "词2", "词3"]});

  assert.equal(result.canceled, false);
  assert.equal(result.fatal, true);
  assert.deepEqual(harness.captureCalls.map((call) => call.keyword), ["词1"]);
  assert.equal(result.results[0].partial, true);
});

test("a thrown non-user detail cancellation is checkpointed and the plan continues", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async ({current}) => {
      if (current === 1) throw new Error("DETAIL_CAPTURE_CANCELED");
      return {ok: true};
    },
  });

  const result = await harness.run({keywords: ["词1", "词2", "词3"]});

  assert.equal(result.canceled, false);
  assert.deepEqual(harness.captureCalls.map((call) => call.keyword), ["词1", "词2", "词3"]);
  assert.equal(result.results[0].partial, true);
  assert.equal(result.results[0].recoverableInterruption, true);
  assert.equal(harness.settled[0].canceled, false);
});

test("an explicit fatal list capture failure stops after its checkpoint", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => ({
      ok: false,
      captureResult: {
        ok: false,
        error: {code: "FATAL_WORK_IDENTITY", message: "work identity contract lost"},
      },
      recordIds: [],
      error: {code: "FATAL_WORK_IDENTITY", message: "work identity contract lost"},
    }),
  });

  const result = await harness.run({keywords: ["词1", "词2", "词3"]});

  assert.equal(result.canceled, false);
  assert.equal(result.fatal, true);
  assert.deepEqual(harness.captureCalls.map((call) => call.keyword), ["词1"]);
  assert.equal(result.results[0].fatal, true);
  assert.equal(harness.settled.length, 1);
});

test("runner loss with an invalidated stop predicate requests checkpoint recovery, not user cancel", async () => {
  let runnerLost = false;
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async () => {
      runnerLost = true;
      return {
        ok: false,
        canceled: true,
        runnerInterrupted: true,
        error: {code: "RUNNER_TAB_UNAVAILABLE", message: "runner replaced mid-detail"},
      };
    },
  });

  const result = await harness.run({
    keywords: ["词1", "词2", "词3"],
    shouldStop: () => runnerLost,
  });

  assert.equal(result.canceled, false);
  assert.equal(result.recoveryRequired, true);
  assert.deepEqual(harness.captureCalls.map((call) => call.keyword), ["词1"]);
  assert.equal(result.results[0].recoveryRequired, true);
  assert.equal(harness.settled[0].canceled, false);
});

test("a mixed 13-keyword unattended plan settles every keyword in order", async () => {
  const attempts = new Map();
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => {
      const keyword = captureParams.keyword;
      attempts.set(keyword, (attempts.get(keyword) || 0) + 1);
      if (keyword === "词1") {
        return {
          ok: true,
          captureResult: {ok: true, data: {items: []}},
          recordIds: [],
          savedRecords: [],
        };
      }
      return successCapture(keyword);
    },
    afterKeywordCapture: async ({current, keyword, recordIds}) => {
      if (current === 5) {
        return {
          ok: false,
          canceled: false,
          successCount: 0,
          failedCount: 1,
          results: [
            {
              recordId: recordIds[0],
              ok: false,
              reason: "DETAIL_OPEN_TIMEOUT",
            },
          ],
        };
      }
      if (current === 8) {
        return {
          ok: false,
          canceled: false,
          runnerInterrupted: true,
          recoveryRequired: true,
          successCount: 0,
          failedCount: 1,
          results: [
            {
              recordId: recordIds[0],
              ok: false,
              reason: "RUNNER_TAB_UNAVAILABLE",
              category: "context_interrupted",
              runnerInterrupted: true,
            },
          ],
        };
      }
      return {
        ok: true,
        canceled: false,
        successCount: 1,
        failedCount: 0,
        results: [{recordId: recordIds[0], ok: true, keyword}],
      };
    },
  });
  const keywords = Array.from({length: 13}, (_, index) => `词${index + 1}`);

  const result = await harness.run({keywords});

  assert.equal(attempts.get("词1"), 2, "an empty keyword retries exactly once");
  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词1", ...keywords],
    "the empty retry must not reorder or truncate the remaining keywords",
  );
  assert.deepEqual(
    harness.settled.map((entry) => entry.keyword),
    keywords,
    "all 13 checkpoints must be persisted in plan order",
  );
  assert.deepEqual(
    Array.from(result.results, (entry) => entry.keyword),
    keywords,
    "the terminal result must include one settlement for every keyword",
  );
  assert.equal(result.stats.total, 13);
  assert.equal(result.stats.processed, 13);
  assert.equal(result.canceled, false);
  assert.equal(result.results[0].ok, false, "the no-result keyword is explicit");
  assert.equal(result.results[4].enhanceStatus, "failed");
  assert.equal(result.results[4].partial, true);
  assert.equal(result.results[7].enhanceStatus, "failed");
  assert.equal(result.results[7].partial, true);
  assert.equal(result.results[7].enhanceResult.runnerInterrupted, true);
  assert.equal(harness.progress.at(-1)?.phase, "done");
  assert.equal(
    harness.getReplacementListenerCount(),
    0,
    "the run must release its tab replacement listener",
  );
});

test("two consecutive unattended rounds do not reuse results or listeners", async () => {
  let activeRound = 1;
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => ({
      ...successCapture(captureParams.keyword),
      recordIds: [`round-${activeRound}-${captureParams.keyword}`],
    }),
    afterKeywordCapture: async ({recordIds}) => ({
      ok: true,
      canceled: false,
      successCount: 1,
      failedCount: 0,
      results: [{recordId: recordIds[0], ok: true}],
    }),
  });
  const keywords = Array.from({length: 13}, (_, index) => `词${index + 1}`);

  const first = await harness.run({keywords});
  assert.equal(harness.getReplacementListenerCount(), 0);
  activeRound = 2;
  const second = await harness.run({keywords});

  assert.equal(first.stats.processed, 13);
  assert.equal(second.stats.processed, 13);
  assert.equal(first.results.length, 13);
  assert.equal(second.results.length, 13);
  assert.ok(
    first.results.every((entry) => entry.recordIds[0].startsWith("round-1-")),
  );
  assert.ok(
    second.results.every((entry) => entry.recordIds[0].startsWith("round-2-")),
  );
  assert.deepEqual(
    harness.settled.map((entry) => entry.keyword),
    [...keywords, ...keywords],
    "both rounds must independently checkpoint all 13 keywords",
  );
  assert.equal(
    harness.getReplacementListenerCount(),
    0,
    "a completed round must leave no listener that can receive stale tab events",
  );
  assert.equal(
    harness.progress.filter((entry) => entry.phase === "done").length,
    2,
    "each round owns exactly one root terminal event",
  );
  const firstDoneAt = harness.progress.findIndex(
    (entry) => entry.phase === "done",
  );
  assert.ok(
    harness.progress
      .slice(firstDoneAt + 1)
      .some(
        (entry) =>
          entry.keyword === "词1" &&
          ["navigating", "submitting_search"].includes(entry.phase),
      ),
    "round two must start from its own first-keyword progress after round one",
  );
  assert.doesNotMatch(
    JSON.stringify({first, second}),
    /(?:still cleaning|cleanup pending|group busy|仍在清理|已绑定.*Tab)/i,
    "a clean second round must not inherit stale cleanup or task-group errors",
  );
});
