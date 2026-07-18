import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const sidebarSource = await readFile(
  new URL("../../sidebar/sidebar-logic.js", import.meta.url),
  "utf8",
);

test("publish-date CSV export uses the defined non-empty text helper", () => {
  const start = sidebarSource.indexOf("function resolveNotePublishCsvValue(");
  const end = sidebarSource.indexOf(
    "function isLikelyCaptureDateFallback(",
    start,
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const section = sidebarSource.slice(start, end);

  assert.match(section, /pickFirstLeadString\(\[/);
  assert.doesNotMatch(section, /firstNonEmptyText/);
});
