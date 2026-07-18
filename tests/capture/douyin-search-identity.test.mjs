import assert from "node:assert/strict";
import test from "node:test";

class FakeElement {
  constructor({attributes = {}, children = [], text = ""} = {}) {
    this.attributes = {...attributes};
    this.children = children;
    this.innerText = text;
    this.id = attributes.id || "";
    this.href = attributes.href || "";
  }

  getAttribute(name) {
    return this.attributes[name] || "";
  }

  querySelectorAll(selector) {
    if (
      selector.includes("a[href]") ||
      selector.includes("[data-href]") ||
      selector.includes("[data-url]")
    ) {
      return this.children;
    }
    return [];
  }

  querySelector(selector) {
    if (selector.includes("FnM1bbIQ")) {
      return this.children.find((child) =>
        String(child.attributes.class || "").includes("FnM1bbIQ"),
      ) || null;
    }
    return this.children[0] || null;
  }

  closest() {
    return null;
  }

  matches() {
    return false;
  }
}

globalThis.Element = FakeElement;
globalThis.document = {
  querySelector() {
    return null;
  },
};

const {
  extractDouyinSearchPublishDateCandidate,
  normalizeSearchDate,
  resolveSearchCardId,
  resolveSearchCardPublishDate,
  resolveSearchCardUrl,
} = await import(
  `../../utils/capture/douyin-keyword-search.js?identity-test=${Date.now()}`
);

test("virtual Douyin cards derive their stable id from the detail link", () => {
  const noteId = "766193585000000001";
  const link = new FakeElement({
    attributes: {href: `https://www.douyin.com/video/${noteId}`},
  });
  const card = new FakeElement({
    attributes: {id: "waterfall_item_0"},
    children: [link],
  });

  assert.equal(resolveSearchCardId(card, 0), noteId);
  assert.equal(
    resolveSearchCardUrl(card, noteId, "general"),
    `https://www.douyin.com/video/${noteId}`,
  );
});

test("a card id and a different detail-link id fail closed", () => {
  const cardId = "766193585000000011";
  const otherId = "766193585000000099";
  const link = new FakeElement({
    attributes: {href: `https://www.douyin.com/video/${otherId}`},
  });
  const card = new FakeElement({
    attributes: {"data-aweme-id": cardId},
    children: [link],
  });

  assert.equal(resolveSearchCardId(card, 0), cardId);
  assert.equal(resolveSearchCardUrl(card, cardId, "general"), "");
});

test("modal detail links keep the search context", () => {
  const noteId = "766193585000000021";
  const modalUrl =
    `https://www.douyin.com/jingxuan/search/test?modal_id=${noteId}&type=general`;
  const link = new FakeElement({attributes: {href: modalUrl}});
  const card = new FakeElement({
    attributes: {"data-aweme-id": noteId},
    children: [link],
  });

  assert.equal(resolveSearchCardUrl(card, noteId, "general"), modalUrl);
});

test("cards without a detail href use the current search modal context", () => {
  const noteId = "766193585000000025";
  const sourceSearchUrl =
    "https://www.douyin.com/jingxuan/search/test?type=general&aid=test";
  const card = new FakeElement({
    attributes: {id: `waterfall_item_${noteId}`},
    text: "测试作品",
  });

  assert.equal(resolveSearchCardId(card, 0), noteId);
  assert.equal(
    resolveSearchCardUrl(card, noteId, "general", sourceSearchUrl),
    `${sourceSearchUrl}&modal_id=${noteId}`,
  );
});

test("a video-duration signal corrects an erroneous note route", () => {
  const noteId = "766193585000000031";
  const link = new FakeElement({
    attributes: {href: `https://www.douyin.com/note/${noteId}`},
  });
  const duration = new FakeElement({
    attributes: {class: "FnM1bbIQ"},
    text: "00:29",
  });
  const card = new FakeElement({
    attributes: {"data-aweme-id": noteId},
    children: [link, duration],
    text: "测试视频\n00:29",
  });

  assert.equal(
    resolveSearchCardUrl(card, noteId, "general"),
    `https://www.douyin.com/video/${noteId}`,
  );
});

test("video duration never becomes a Douyin publish date", () => {
  const referenceDate = new Date(2026, 6, 16, 12, 0, 0);

  assert.equal(extractDouyinSearchPublishDateCandidate("00:15"), "");
  assert.equal(extractDouyinSearchPublishDateCandidate("00-15"), "");
  assert.equal(normalizeSearchDate("00:15", referenceDate), "");
  assert.equal(normalizeSearchDate("00-15", referenceDate), "");
});

test("search-card metadata date wins over duration and dates in the title", () => {
  const card = new FakeElement({
    text: [
      "活动时间：11月8日 14:00",
      "口口椰郁见你 · 01-05",
      "00:15",
    ].join("\n"),
  });

  assert.equal(resolveSearchCardPublishDate(card), "01-05");
  assert.equal(
    normalizeSearchDate(
      resolveSearchCardPublishDate(card),
      new Date(2026, 6, 16, 12, 0, 0),
    ),
    "2026-01-05",
  );
});
