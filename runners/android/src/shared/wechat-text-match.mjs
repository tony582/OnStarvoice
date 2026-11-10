/** Comparable form of recognized text: NFKC, no spaces, no fold marks, common OCR variant characters mapped. */
export function comparable(value) {
  return String(value ?? '').normalize('NFKC').replace(/[別]/gu, '别').replace(/[\s​]+/gu, '')
    .replace(/[.。…·•｜|]+/gu, '').toLowerCase();
}

function bigrams(text) {
  const set = new Map();
  for (let i = 0; i < text.length - 1; i++) { const pair = text.slice(i, i + 2); set.set(pair, (set.get(pair) ?? 0) + 1); }
  return set;
}
/** Dice similarity of two comparable strings (0..1); short strings must match exactly. */
export function similarity(a, b) {
  const left = comparable(a), right = comparable(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 3 || right.length < 3) return 0;
  const one = bigrams(left), two = bigrams(right);
  let shared = 0;
  for (const [pair, count] of one) shared += Math.min(count, two.get(pair) ?? 0);
  return (2 * shared) / (left.length - 1 + right.length - 1);
}
