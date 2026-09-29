// JavaScript strings are UTF-16. String#slice cuts at any code unit, so a limit or
// window edge that lands between the two halves of an emoji leaves a lone
// surrogate. It is legal in a JS string, but it is not text:
//   - JSON.stringify writes it as a \udXXX escape, and PostgreSQL jsonb rejects
//     the whole document ("Unicode low surrogate must follow a high surrogate",
//     SQLSTATE 22P02);
//   - some OpenAI-compatible providers reject it in a request body;
//   - UTF-8 encoding (text columns, logs) silently turns it into U+FFFD.
//
// Every helper here returns a well-formed string. A character that a cut would
// split is dropped whole, so a truncated quote stays an exact substring of its
// source. A lone surrogate that was already in the input is replaced with U+FFFD.
// Limits stay in UTF-16 code units, the same unit String#slice used before.
//
// Node 18 has no String.prototype.toWellFormed / isWellFormed (Node 20+).

// Non-unicode mode on purpose: each code unit is matched on its own, so a valid
// pair is never split by the pattern itself.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const HAS_LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const isHighSurrogate = code => code >= 0xD800 && code <= 0xDBFF;
const isLowSurrogate = code => code >= 0xDC00 && code <= 0xDFFF;

export function isWellFormed(value) {
  return !HAS_LONE_SURROGATE.test(String(value ?? ''));
}

// True when a cut at `index` would separate the two halves of a surrogate pair.
export function splitsSurrogatePair(text, index) {
  return index > 0 && index < text.length
    && isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index));
}

export function toWellFormed(value) {
  return String(value ?? '').replace(LONE_SURROGATE, '\uFFFD');
}

// String#slice(start, end) that never returns half of a character. Indexes are
// UTF-16 code units and follow String#slice (negative counts from the end).
export function sliceWellFormed(value, start = 0, end = undefined) {
  const text = String(value ?? '');
  const length = text.length;
  const resolve = (index, fallback) => {
    if (index === undefined) return fallback;
    const whole = Math.trunc(Number(index)) || 0;
    return whole < 0 ? Math.max(length + whole, 0) : Math.min(whole, length);
  };
  let from = resolve(start, 0);
  let to = resolve(end, length);
  if (splitsSurrogatePair(text, from)) from += 1;
  if (splitsSurrogatePair(text, to)) to -= 1;
  return from < to ? toWellFormed(text.slice(from, to)) : '';
}

// At most maxUnits UTF-16 code units, cut on a character boundary. A missing or
// negative limit gives '' (same as truncatePromptText); Infinity keeps everything.
export function truncateWellFormed(value, maxUnits) {
  const limit = Number(maxUnits);
  return sliceWellFormed(value, 0, Number.isNaN(limit) ? 0 : Math.max(0, Math.trunc(limit)));
}

function wellFormedReplacer(_key, value) {
  if (typeof value === 'string') return toWellFormed(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const names = Object.keys(value);
    if (names.some(name => !isWellFormed(name))) {
      return Object.fromEntries(names.map(name => [toWellFormed(name), value[name]]));
    }
  }
  return value;
}

// A lone surrogate is always written as a lowercase \udXXX escape, valid pairs are
// written as the characters themselves (JSON.stringify has been well-formed since
// Node 12). A literal backslash-u in the text shows up as \\ud..., which also
// matches: that only means the slower path runs, with an identical result.
const LONE_SURROGATE_ESCAPE = /\\ud[89a-f][0-9a-f]{2}/;

// JSON.stringify whose output never contains a lone-surrogate escape, in string
// values or in object keys. Use it for text that is bound for a jsonb column: a
// model reply can carry a lone surrogate that no truncation helper ever saw.
// Clean input takes the native path, so behaviour, speed and the nesting depth
// that can be serialised are those of JSON.stringify itself; the replacer only
// runs on a document that actually contains a lone surrogate.
export function stringifyJsonWellFormed(value, space) {
  const json = JSON.stringify(value, undefined, space);
  if (typeof json !== 'string' || !LONE_SURROGATE_ESCAPE.test(json)) return json;
  return JSON.stringify(value, wellFormedReplacer, space);
}
