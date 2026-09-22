// Minimal DOM tree for author extraction tests (tag, class, attribute and
// descendant selectors). No publisher/mention rules are built into this tree.
export class AuthorDomNode {
  constructor(tag = 'div', attributes = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.attributes = attributes;
    this.children = children;
    this.parentElement = null;
    for (const child of children) {
      if (child instanceof AuthorDomNode) child.parentElement = this;
    }
  }
  get textContent() {
    return this.children.map(child => typeof child === 'string' ? child : child.textContent).join('');
  }
  get innerText() { return this.textContent; }
  get className() { return this.getAttribute('class') || ''; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  contains(node) {
    return node === this || this.children.some(child => child instanceof AuthorDomNode && child.contains(node));
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const segments = part.trim().split(/\s+/);
      let node = this;
      if (!node.matchesSimple(segments.pop())) return false;
      while (segments.length) {
        const ancestorSelector = segments.pop();
        node = node.parentElement;
        while (node && !node.matchesSimple(ancestorSelector)) node = node.parentElement;
        if (!node) return false;
      }
      return true;
    });
  }
  matchesSimple(selector) {
    const tag = selector.match(/^[a-z]+/i)?.[0];
    if (tag && tag.toUpperCase() !== this.tagName) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) {
      if (!this.className.split(/\s+/).includes(name)) return false;
    }
    for (const [, key, op, value] of selector.matchAll(/\[([\w-]+)(?:([*^]?=)"([^"]*)")?\]/g)) {
      const actual = this.getAttribute(key);
      if (actual === null) return false;
      if (op === '=' && actual !== value) return false;
      if (op === '*=' && !actual.includes(value)) return false;
      if (op === '^=' && !actual.startsWith(value)) return false;
    }
    return true;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => child instanceof AuthorDomNode
      ? [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)] : []);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() {
    return {left: 900, right: 1020, top: 200, bottom: 230, width: 120, height: 30};
  }
}

export const el = (tag, attributes, ...children) => new AuthorDomNode(tag, attributes, children);
