import assert from "node:assert/strict";
import test from "node:test";

import {extractPublishDateFromCard, extractPublishDateEvidenceFromCard} from "../../utils/capture/keyword-search.js";

class FakeNode {
  constructor(textContent = "", attributes = {}) {
    this.textContent = textContent;
    this.attributes = attributes;
    this.elements = new Map();
  }

  add(selector, element) {
    const elements = this.elements.get(selector) || [];
    elements.push(element);
    this.elements.set(selector, elements);
    return this;
  }

  querySelectorAll(selector) {
    return this.elements.get(selector) || [];
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
}

const TRAVEL_TITLE = "9-10月去喀纳斯、禾木赏秋？听租车老板一句劝";

test("XHS never infers a publish date from numbers in a card title", () => {
  for (const title of [
    TRAVEL_TITLE,
    "2025-06-19款车机和2026-01-05款的区别",
    "昨天更新车机后等了3小时前往门店",
    "车机更新日志 2026-01-05",
  ]) {
    const card = new FakeNode(`${title} 租车老板 20`);
    card.add(".title", new FakeNode(title));
    card.add(".author", new FakeNode("租车老板"));
    assert.equal(extractPublishDateFromCard(card), "", title);
  }
});

test("an explicit relative publish date wins over title and author date-like text", () => {
  const card = new FakeNode(`${TRAVEL_TITLE} 2025-06-19 老李2026-01-05 3小时前`);
  card.add(".publish-date", new FakeNode("3小时前"));
  card.add(".author", new FakeNode("老李2026-01-05"));

  assert.equal(extractPublishDateFromCard(card), "3小时前");
});

test("existing explicit absolute and relative date formats are preserved", () => {
  for (const raw of [
    "2025-06-19", "2026/01/05", "2026.02.11", "09-09", "9/9", "9.9",
    "5分钟前", "3小时前", "2天前", "刚刚", "昨天",
  ]) {
    const card = new FakeNode(`${TRAVEL_TITLE} 租车老板 ${raw}`);
    card.add(".date", new FakeNode(raw));
    assert.equal(extractPublishDateFromCard(card), raw);
  }
});

test("a valid datetime attribute remains the source for its time element", () => {
  const card = new FakeNode(`${TRAVEL_TITLE} 昨天`);
  card.add("time[datetime]", new FakeNode("昨天", {datetime: "2026-09-09"}));

  assert.equal(extractPublishDateFromCard(card), "2026-09-09");
});

test("author-line trailing dates remain usable when there is no date element", () => {
  const examples = [
    ["租车老板 3小时前", "3小时前"],
    ["租车老板09-09", "09-09"],
    ["租车老板2026-01-05", "2026-01-05"],
    ["租车老板 昨天", "昨天"],
    ["老李2025-06-19 3小时前", "3小时前"],
  ];
  for (const [authorText, expected] of examples) {
    const card = new FakeNode(`${TRAVEL_TITLE} ${authorText} 20`);
    card.add(".author", new FakeNode(authorText));
    assert.equal(extractPublishDateFromCard(card), expected, authorText);
  }
});

test("a date-like nickname does not override a relative date at the author-line end", () => {
  const card = new FakeNode(`${TRAVEL_TITLE} 老李2025-06-19 3小时前`);
  card.add(".author", new FakeNode("老李2025-06-19 3小时前"));
  card.add(".nickname", new FakeNode("老李2025-06-19"));

  assert.equal(extractPublishDateFromCard(card), "3小时前");
});

test("non-date author text and invalid explicit dates stay unknown", () => {
  for (const authorText of ["9-10月租车老板", "车价17.99", "发布于", ""]) {
    const card = new FakeNode(`${TRAVEL_TITLE} ${authorText}`);
    card.add(".date", new FakeNode("17.99"));
    card.add(".author", new FakeNode(authorText));
    assert.equal(extractPublishDateFromCard(card), "");
  }
  assert.equal(extractPublishDateFromCard(null), "");
});


test("author-only fallback is marked ambiguous so a date-like nickname cannot exclude a post", () => {
  const card = new FakeNode("老李2025-06-19").add(".author", new FakeNode("老李2025-06-19"));
  assert.deepEqual(extractPublishDateEvidenceFromCard(card), {raw: "2025-06-19", source: "author_line"});
  card.add(".date", new FakeNode("昨天"));
  assert.deepEqual(extractPublishDateEvidenceFromCard(card), {raw: "昨天", source: "date_element"});
});
