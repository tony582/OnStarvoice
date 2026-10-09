import { DeviceError } from './bounded.mjs';

// `diagnostic` names the rejected rule with sizes and code points, and since 0.3.2 the bounded text around the
// failure (failureContext). It stays in the local diagnose notes (private state directory, never uploaded) and is
// not an uploaded completion detail key: faultDetails in discovery-runner.mjs only copies whitelisted keys.
const fail = (rule, facts = {}) => {
  throw new DeviceError('invalid_ui_source', 'UI source is not a bounded Android hierarchy',
    { diagnostic: { parser: rule, ...facts } });
};
const CONTEXT_RADIUS = 80;
const high = code => code >= 0xd800 && code <= 0xdbff;
const low = code => code >= 0xdc00 && code <= 0xdfff;
// Code points XML 1.0 forbids, or that a serializer may have written raw: C0 controls except tab, LF and CR; DEL and
// the C1 controls; lone surrogates (Array.from yields each as its own code unit); the two noncharacters.
const odd = code => (code < 0x20 && ![9, 10, 13].includes(code)) || (code >= 0x7f && code <= 0x9f) || high(code) || low(code)
  || code === 0xfffe || code === 0xffff;
/**
 * The text around a failure position, at most `radius` code points on each side. The window is cut on character
 * boundaries, so an emoji at its edge is kept whole and a lone surrogate reported in oddCodePoints is a real one
 * from the source. The text may contain a caption: it is recorded only in the local diagnose notes, on purpose,
 * because identical failures (2026-09-26, 2026-10-08) could not be explained without seeing the characters.
 */
export function failureContext(text, index, radius = CONTEXT_RADIUS) {
  const at = Math.max(0, Math.min(index ?? 0, text.length));
  let start = Math.max(0, at - 4 * radius);
  if (start > 0 && low(text.charCodeAt(start)) && high(text.charCodeAt(start - 1))) start++;
  let end = Math.min(text.length, at + 4 * radius);
  if (end < text.length && high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end--;
  const before = Array.from(text.slice(start, at)).slice(-radius);
  const after = Array.from(text.slice(at, end)).slice(0, radius);
  const oddCodePoints = [...before, ...after].map(char => char.codePointAt(0)).filter(odd).slice(0, 8);
  return { offset: at, before: before.join(''), after: after.join(''), oddCodePoints };
}
function decode(value, attribute = '') {
  return value.replace(/&([^;]*);/gu, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    if (!/^#(?:[0-9]+|x[0-9a-f]+)$/iu.test(entity)) return fail('unknown_entity', { attribute, entity: Array.from(entity).slice(0, 40).join('') });
    const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (code < 32 && ![9, 10, 13].includes(code) || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) {
      return fail('invalid_code_point', { codePoint: code, attribute });
    }
    return String.fromCodePoint(code);
  });
}

/** Parse only the UiAutomator hierarchy grammar. Never evaluate XML or resolve entities. */
export function parseUiTree(xml) {
  if (typeof xml !== 'string') return fail('not_text');
  const bytes = Buffer.byteLength(xml);
  if (bytes > 2 * 1024 * 1024) return fail('too_large', { bytes });
  if (/<!/u.test(xml)) return fail('markup_declaration', { bytes });
  const source = xml.replace(/^<\?xml\s[^?]*\?>\s*/u, '');
  const document = { tag: 'document', attributes: {}, children: [], parent: null };
  const stack = [document]; const nodes = []; let offset = 0;
  const at = (rule, facts = {}) => fail(rule, { bytes, nodes: nodes.length, depth: stack.length - 1, ...facts });
  // XML allows a raw `>` inside a quoted attribute value (a caption such as "A>B"), so a tag ends at
  // the first `>` outside quotes, not at the first `>`.
  for (const match of source.matchAll(/<(?:[^>"]|"[^"]*")*>/gu)) {
    if (source.slice(offset, match.index).trim()) return at('stray_text', { context: failureContext(source, offset) });
    offset = match.index + match[0].length;
    const close = match[0].match(/^<\/([\p{L}_][\p{L}\p{N}_.:-]*)>$/u);
    if (close) {
      if (stack.length < 2 || stack.at(-1).tag !== close[1]) return at('unbalanced_tag', { closeTag: close[1], openTag: stack.at(-1).tag });
      stack.pop();
      continue;
    }
    const open = match[0].match(/^<([\p{L}_][\p{L}\p{N}_.:-]*)(\s(?:[^<>"]|"[^"<]*")*?)?\s*(\/?)>$/u);
    // The usual cause is a raw `<` inside a quoted value; show that value, else the start of the tag.
    if (!open) return at('invalid_tag', { context: failureContext(match[0], Math.max(0, match[0].search(/"[^"<]*</u))) });
    if (stack.length > 128) return at('too_deep');
    if (nodes.length >= 12000) return at('too_many_nodes');
    const attrs = open[2] ?? ''; const attributes = {}; let cursor = 0;
    const regex = /\s+([\p{L}_][\p{L}\p{N}_.:-]*)="([^"<]*)"/guy;
    while (cursor < attrs.length) {
      if (!attrs.slice(cursor).trim()) break;
      regex.lastIndex = cursor; const attribute = regex.exec(attrs);
      if (!attribute) {
        return at('invalid_attribute', { tag: open[1], parsedAttributes: Object.keys(attributes).length,
          lastAttribute: Object.keys(attributes).at(-1) ?? '',
          nextCodePoints: [...attrs.slice(cursor).trimStart()].slice(0, 4).map(char => char.codePointAt(0)),
          context: failureContext(attrs, cursor) });
      }
      if (Object.hasOwn(attributes, attribute[1])) return at('duplicate_attribute', { attribute: attribute[1] });
      const bare = attribute[2].search(/&(?![^&;]+;)/u);
      if (bare >= 0) return at('bare_ampersand', { attribute: attribute[1], context: failureContext(attribute[2], bare) });
      attributes[attribute[1]] = decode(attribute[2], attribute[1]); cursor = regex.lastIndex;
    }
    const parent = stack.at(-1);
    if (open[1] === 'hierarchy' && parent !== document || open[1] !== 'hierarchy' && parent === document) return at('misplaced_root');
    const node = { tag: open[1], attributes, parent, children: [] };
    parent.children.push(node); nodes.push(node);
    if (!open[3]) stack.push(node);
  }
  if (stack.length !== 1 || source.slice(offset).trim() || document.children.length !== 1
    || document.children[0].tag !== 'hierarchy') return at('incomplete_document');
  return { root: document.children[0], nodes };
}

export function descendants(node) {
  const result = [];
  for (const child of node.children) { result.push(child); result.push(...descendants(child)); }
  return result;
}

export function visible(node) {
  const a = node.attributes;
  const box = a.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u);
  return a.displayed === 'true' && a.enabled !== 'false' && !!box && Number(box[3]) > Number(box[1]) && Number(box[4]) > Number(box[2]);
}

export function xpathLiteral(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new DeviceError('invalid_selector', 'Selector text is invalid');
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value.split("'").map(part => `'${part}'`).join(',"\'",')})`;
}
