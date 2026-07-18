import assert from "node:assert/strict";
import test from "node:test";

import {validateAuthorName} from "../../utils/capture/single-note.js";

test("accepts emoji-only social display names", () => {
  assert.equal(validateAuthorName("🌻"), true);
  assert.equal(validateAuthorName("✨"), true);
  assert.equal(validateAuthorName("🌻小红"), true);
});

test("still rejects non-name placeholders", () => {
  assert.equal(validateAuthorName("12345"), false);
  assert.equal(validateAuthorName("昨天 22:41"), false);
  assert.equal(validateAuthorName("..."), false);
  assert.equal(validateAuthorName("关注"), false);
});
