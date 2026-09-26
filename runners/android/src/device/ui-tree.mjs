import { DeviceError } from './bounded.mjs';

// `diagnostic` names the rejected rule with sizes and code points only (never text); it stays in the
// local diagnose notes and is not an uploaded completion detail key.
const fail = (rule, facts = {}) => {
  throw new DeviceError('invalid_ui_source', 'UI source is not a bounded Android hierarchy',
    { diagnostic: { parser: rule, ...facts } });
};
function decode(value) {
  return value.replace(/&([^;]*);/gu, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    if (!/^#(?:[0-9]+|x[0-9a-f]+)$/iu.test(entity)) return fail('unknown_entity');
    const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (code < 32 && ![9, 10, 13].includes(code) || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) {
      return fail('invalid_code_point', { codePoint: code });
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
    if (source.slice(offset, match.index).trim()) return at('stray_text');
    offset = match.index + match[0].length;
    const close = match[0].match(/^<\/([\p{L}_][\p{L}\p{N}_.:-]*)>$/u);
    if (close) {
      if (stack.length < 2 || stack.pop().tag !== close[1]) return at('unbalanced_tag');
      continue;
    }
    const open = match[0].match(/^<([\p{L}_][\p{L}\p{N}_.:-]*)(\s(?:[^<>"]|"[^"<]*")*?)?\s*(\/?)>$/u);
    if (!open) return at('invalid_tag');
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
          nextCodePoints: [...attrs.slice(cursor).trimStart()].slice(0, 4).map(char => char.codePointAt(0)) });
      }
      if (Object.hasOwn(attributes, attribute[1])) return at('duplicate_attribute');
      if (/&(?![^&;]+;)/u.test(attribute[2])) return at('bare_ampersand');
      attributes[attribute[1]] = decode(attribute[2]); cursor = regex.lastIndex;
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
