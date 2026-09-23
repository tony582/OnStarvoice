// Douyin can render Unicode emoji as inline images. Preserve those characters
// in DOM order, while excluding avatar/badge descriptions and control labels.
export function readDouyinInlineText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent || '';
  if (node.tagName === 'IMG') {
    const alt = node.getAttribute('alt') || '';
    return alt.length <= 32 && /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(alt)
      && !/\p{L}/u.test(alt) ? alt : '';
  }
  if (node.getAttribute?.('aria-hidden') === 'true'
      || ['SVG', 'BUTTON', 'SCRIPT', 'STYLE'].includes(node.tagName)) return '';
  return node.childNodes ? Array.from(node.childNodes).map(readDouyinInlineText).join('') : node.textContent || '';
}
