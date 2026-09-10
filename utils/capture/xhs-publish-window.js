const DAY_MS = 24 * 60 * 60 * 1000;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const WINDOW_DAYS = {day: 1, week: 7, month: 30};

export function isXhsPublishTimeWindow(value) {
  return value === "day" || value === "week" || value === "month" || value === "halfyear";
}

// This guard is only for XHS keyword-list dates from a date element/author row.
// A false result means "not proven old", including missing or inconsistent data.
export function isOutsideXhsPublishWindow(item, window, referenceTimestamp) {
  if (!isXhsPublishTimeWindow(window)) return false;
  // A nickname ending in a date is indistinguishable from a concatenated author
  // timestamp. Preserve those legacy display dates, but never exclude on them.
  if (item?.publishDateSource === "author_line" || item?.publishDateSource === "unknown") return false;
  const timestamp = item?.publishTimestamp;
  if (!validTimestamp(timestamp) || !validTimestamp(referenceTimestamp)) return false;
  if (timestamp > referenceTimestamp + DAY_MS) return false;
  const raw = typeof item?.publishDateRaw === "string" ? item.publishDateRaw.trim() : "";
  if (!raw) return false;

  const cutoff = windowStart(window, referenceTimestamp);
  const relative = raw.match(/^(\d{1,6})\s*(分钟|小时)前$/);
  if (relative) {
    const duration = Number(relative[1]) * (relative[2] === "小时" ? 3600000 : 60000);
    // Parsing happens after the keyword starts. Reject stale/mismatched numeric
    // values, but allow a long collection and a midnight crossing.
    const observedAt = timestamp + duration;
    if (observedAt < referenceTimestamp - 60000 || observedAt > referenceTimestamp + DAY_MS) {
      return false;
    }
    return timestamp < cutoff;
  }

  const dates = timestampDates(timestamp);
  const absolute = raw.match(/^(\d{4})([./-])(\d{1,2})\2(\d{1,2})$/);
  if (absolute) {
    const date = [Number(absolute[1]), Number(absolute[3]), Number(absolute[4])];
    if (!validDate(date) || !dates.some((candidate) => sameDate(candidate, date))) return false;
    return dateEnd(date) <= cutoff;
  }

  const monthDay = raw.match(/^(\d{1,2})([./-])(\d{1,2})$/);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[3]);
    const referenceYear = chinaDate(referenceTimestamp)[0];
    const candidates = dates.filter((date) => {
      if (date[1] !== month || date[2] !== day || !validDate(date)) return false;
      if (date[0] !== referenceYear && date[0] !== referenceYear - 1) return false;
      // Do not trust a guessed previous year when this year's date is already
      // plausible. This also rejects stale timestamps for a current MM-DD label.
      if (date[0] === referenceYear - 1) {
        const thisYear = [referenceYear, month, day];
        if (validDate(thisYear) && dateStart(thisYear) <= referenceTimestamp + DAY_MS) return false;
      }
      return true;
    });
    return candidates.length > 0 && candidates.every((date) => dateEnd(date) <= cutoff);
  }

  const daysAgo = raw === "昨天" ? 1 : raw === "今天" ? 0 : raw.match(/^(\d{1,6})\s*天前$/)?.[1];
  if (daysAgo !== undefined) {
    const days = Number(daysAgo);
    const referenceDates = timestampDates(referenceTimestamp);
    const candidates = dates.filter((date) => {
      const observedDay = dateStart(date) + days * DAY_MS;
      return referenceDates.some((referenceDate) => {
        const delta = observedDay - dateStart(referenceDate);
        return delta === 0 || delta === DAY_MS;
      });
    });
    return candidates.length > 0 && candidates.every((date) => dateEnd(date) <= cutoff);
  }

  // Includes "刚刚", edited-at labels, time-only strings, title fragments,
  // unsupported formats and dates that the existing parser merely guessed.
  return false;
}

function validTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 &&
    Number.isFinite(new Date(value).getTime());
}

function chinaDate(timestamp) {
  const date = new Date(timestamp + CHINA_OFFSET_MS);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

function timestampDates(timestamp) {
  const local = new Date(timestamp);
  // Existing list parsing uses browser-local time. Accept its calendar date or
  // the China date, and retain the content whenever either is still in range.
  return [chinaDate(timestamp), [local.getFullYear(), local.getMonth() + 1, local.getDate()]];
}

function validDate([year, month, day]) {
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function sameDate(left, right) {
  return left.every((value, index) => value === right[index]);
}

function dateStart([year, month, day]) {
  return Date.UTC(year, month - 1, day) - CHINA_OFFSET_MS;
}

function dateEnd(date) {
  return dateStart(date) + DAY_MS;
}

function windowStart(window, referenceTimestamp) {
  if (window !== "halfyear") return referenceTimestamp - WINDOW_DAYS[window] * DAY_MS;
  const reference = new Date(referenceTimestamp + CHINA_OFFSET_MS);
  const day = reference.getUTCDate();
  reference.setUTCDate(1);
  reference.setUTCMonth(reference.getUTCMonth() - 6);
  const lastDay = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 0)).getUTCDate();
  reference.setUTCDate(Math.min(day, lastDay));
  return reference.getTime() - CHINA_OFFSET_MS;
}
