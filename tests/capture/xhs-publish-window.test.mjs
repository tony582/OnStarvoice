import assert from "node:assert/strict";
import test from "node:test";
import {isOutsideXhsPublishWindow, isXhsPublishTimeWindow} from "../../utils/capture/xhs-publish-window.js";

const reference = Date.parse("2026-09-10T12:00:00+08:00");
const dayMs = 86400000;
const item = (raw, value = `${raw}T00:00:00+08:00`) => ({
  publishDateRaw: raw,
  publishTimestamp: typeof value === "number" ? value : Date.parse(value),
});
const outside = (record, window = "day", now = reference) => isOutsideXhsPublishWindow(record, window, now);

test("only the explicit XHS UI time-window values enable filtering", () => {
  for (const value of ["day", "week", "month", "halfyear"]) assert.equal(isXhsPublishTimeWindow(value), true);
  for (const value of [undefined, null, "", "all", "halfYear", "DAY", " day", "24h", {}]) {
    assert.equal(isXhsPublishTimeWindow(value), false);
    assert.equal(isOutsideXhsPublishWindow(item("2025-06-12"), value, reference), false);
  }
});

test("day excludes confirmed old posts while retaining the whole boundary date", () => {
  for (const raw of ["2025-06-12", "2026-01-05", "2026-09-08"]) assert.equal(outside(item(raw)), true);
  for (const raw of ["2026-09-09", "2026-09-10"]) assert.equal(outside(item(raw)), false);
  assert.equal(outside(item("2026-09-08"), "day", Date.parse("2026-09-10T00:00:00+08:00")), true);
  assert.equal(outside(item("2026-09-09"), "day", Date.parse("2026-09-10T23:59:59+08:00")), false);
});

test("week and month keep their day-precision boundary dates", () => {
  assert.equal(outside(item("2026-09-02"), "week"), true);
  assert.equal(outside(item("2026-09-03"), "week"), false);
  assert.equal(outside(item("2026-08-10"), "month"), true);
  assert.equal(outside(item("2026-08-11"), "month"), false);
});

test("halfyear uses six calendar months and clamps month-end across leap years", () => {
  for (const [now, old, boundary] of [
    ["2026-09-10T12:00:00+08:00", "2026-03-09", "2026-03-10"],
    ["2026-08-31T12:00:00+08:00", "2026-02-27", "2026-02-28"],
    ["2024-08-31T12:00:00+08:00", "2024-02-28", "2024-02-29"],
  ]) {
    assert.equal(outside(item(old), "halfyear", Date.parse(now)), true);
    assert.equal(outside(item(boundary), "halfyear", Date.parse(now)), false);
  }
});

test("trusted hours and minutes use the exact fixed cutoff", () => {
  assert.equal(outside(item("25小时前", reference - 25 * 3600000)), true);
  assert.equal(outside(item("24小时前", reference - dayMs)), false);
  assert.equal(outside(item("1441分钟前", reference - dayMs - 60000)), true);
  assert.equal(outside(item("1439分钟前", reference - dayMs + 60000)), false);
  // A card parsed an hour into collection still uses the original keyword start.
  assert.equal(outside(item("25小时前", reference - dayMs)), false);
  assert.equal(outside(item("1小时前", reference - 200 * dayMs)), false);
});

test("relative days preserve imprecise dates and midnight crossings", () => {
  assert.equal(outside(item("昨天", "2026-09-09T00:00:00+08:00")), false);
  assert.equal(outside(item("2天前", "2026-09-08T00:00:00+08:00")), true);
  assert.equal(outside(item("7天前", "2026-09-03T00:00:00+08:00"), "week"), false);
  assert.equal(outside(item("8天前", "2026-09-02T00:00:00+08:00"), "week"), true);
  const beforeMidnight = Date.parse("2026-09-10T23:59:00+08:00");
  assert.equal(outside(item("2天前", "2026-09-09T00:00:00+08:00"), "day", beforeMidnight), false);
  assert.equal(outside(item("2天前", "2025-09-08T00:00:00+08:00")), false);
});

test("yearless dates require a consistent year and retain New Year boundaries", () => {
  assert.equal(outside(item("06-19", "2026-06-19T00:00:00+08:00")), true);
  assert.equal(outside(item("09-09", "2026-09-09T00:00:00+08:00")), false);
  assert.equal(outside(item("9-10", "2025-09-10T00:00:00+08:00")), false);
  assert.equal(outside(item("12-31", "2025-12-31T00:00:00+08:00"), "day", Date.parse("2026-01-01T12:00:00+08:00")), false);
  assert.equal(outside(item("12-30", "2025-12-30T00:00:00+08:00"), "day", Date.parse("2026-01-01T12:00:00+08:00")), true);
});

test("missing, edited, malformed, mismatched and future evidence is never excluded", () => {
  for (const raw of ["", "刚刚", "编辑于 2025-06-12", "发布于2025-06-12", "9-10月旅游", "2025-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "00-15", "17.99", "2026-1/2", "2026-01-01 extra", "12:05"]) {
    assert.equal(outside(item(raw, "2025-06-12T00:00:00+08:00")), false, raw);
  }
  assert.equal(outside(item("2025-02-29", "2025-03-01T00:00:00+08:00")), false);
  assert.equal(outside(item("2026-02-30", "2026-03-02T00:00:00+08:00")), false);
  assert.equal(outside(item("2026-09-09", "2025-09-09T00:00:00+08:00")), false);
  assert.equal(outside(item("2027-09-10")), false);
  for (const timestamp of [undefined, null, 0, -1, NaN, Infinity, "2025-06-12", 9e99]) {
    assert.equal(outside({publishDateRaw: "2025-06-12", publishTimestamp: timestamp}), false);
    assert.equal(isOutsideXhsPublishWindow(item("2025-06-12"), "day", timestamp), false);
  }
});

test("date-only decisions tolerate existing local parsing without changing China day boundaries", () => {
  const original = process.env.TZ;
  try {
    for (const timezone of ["Asia/Shanghai", "UTC", "America/Los_Angeles", "Pacific/Auckland"]) {
      process.env.TZ = timezone;
      for (const [raw, month, day, expected] of [["2026-09-08", 8, 8, true], ["2026-09-09", 8, 9, false]]) {
        assert.equal(outside(item(raw, new Date(2026, month, day).getTime())), expected, `${timezone} local ${raw}`);
        assert.equal(outside(item(raw)), expected, `${timezone} China ${raw}`);
      }
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
