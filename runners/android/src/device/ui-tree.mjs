import { DeviceError } from './bounded.mjs';

const fail = () => { throw new DeviceError('invalid_ui_source', 'UI source is not a bounded Android hierarchy'); };
function decode(value) {
  return value.replace(/&([^;]*);/gu, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    if (!/^#(?:[0-9]+|x[0-9a-f]+)$/iu.test(entity)) return fail();
    const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (code < 32 && ![9, 10, 13].includes(code) || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) return fail();
    return String.fromCodePoint(code);
  });
}

/** Parse only the UiAutomator hierarchy grammar. Never evaluate XML or resolve entities. */
export function parseUiTree(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 2 * 1024 * 1024 || /<!/u.test(xml)) return fail();
  const source = xml.replace(/^<\?xml\s[^?]*\?>\s*/u, '');
  const document = { tag: 'document', attributes: {}, children: [], parent: null };
  const stack = [document]; const nodes = []; let offset = 0;
  for (const match of source.matchAll(/<[^>]*>/gu)) {
    if (source.slice(offset, match.index).trim()) return fail();
    offset = match.index + match[0].length;
    const close = match[0].match(/^<\/([\p{L}_][\p{L}\p{N}_.:-]*)>$/u);
    if (close) {
      if (stack.length < 2 || stack.pop().tag !== close[1]) return fail();
      continue;
    }
    const open = match[0].match(/^<([\p{L}_][\p{L}\p{N}_.:-]*)(\s[^<>]*?)?\s*(\/?)>$/u);
    if (!open || stack.length > 128 || nodes.length >= 12000) return fail();
    const attrs = open[2] ?? ''; const attributes = {}; let cursor = 0;
    const regex = /\s+([\p{L}_][\p{L}\p{N}_.:-]*)="([^"<]*)"/guy;
    while (cursor < attrs.length) {
      if (!attrs.slice(cursor).trim()) break;
      regex.lastIndex = cursor; const attribute = regex.exec(attrs);
      if (!attribute || Object.hasOwn(attributes, attribute[1])) return fail();
      if (/&(?![^&;]+;)/u.test(attribute[2])) return fail();
      attributes[attribute[1]] = decode(attribute[2]); cursor = regex.lastIndex;
    }
    const parent = stack.at(-1);
    if (open[1] === 'hierarchy' && parent !== document || open[1] !== 'hierarchy' && parent === document) return fail();
    const node = { tag: open[1], attributes, parent, children: [] };
    parent.children.push(node); nodes.push(node);
    if (!open[3]) stack.push(node);
  }
  if (stack.length !== 1 || source.slice(offset).trim() || document.children.length !== 1
    || document.children[0].tag !== 'hierarchy') return fail();
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
