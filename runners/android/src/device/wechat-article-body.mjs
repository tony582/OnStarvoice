import {comparable, similarity} from './wechat-ocr-parse.mjs';

const clean = value => comparable(value).replace(/^[←→。•·・]+/u, '');
function sameLine(a, b) {
  const left = clean(a.text), right = clean(b.text);
  if (left === right && left.length >= 3) return true;
  return left.length >= 10 && right.length >= 10 && similarity(left, right) >= 0.88
    && JSON.stringify(left.match(/\d+/gu)) === JSON.stringify(right.match(/\d+/gu));
}
function align(previous, rows) {
  const candidates = [];
  for (const before of previous) for (const after of rows) {
    if (Math.abs(before.row.x - after.x) < 120 && sameLine(before.row, after)) {
      candidates.push({offset: before.docY - after.y, text: clean(after.text)});
    }
  }
  let cluster = [];
  for (const candidate of candidates) {
    const group = candidates.filter(item => Math.abs(item.offset - candidate.offset) <= 25);
    if (group.length > cluster.length) cluster = group;
  }
  const unique = [...new Set(cluster.map(item => item.text))];
  const values = cluster.map(item => item.offset).sort((a, b) => a - b);
  return {offset: values.length ? values[Math.floor(values.length / 2)] : null,
    verified: unique.length >= 2 && unique.join('').length >= 12};
}
export const articleScreenOverlap = (before, after) => align(before.map(row => ({row, docY: row.y})), after).verified;
const quality = row => Math.min(row.y - 240, 1900 - row.y - row.h, 600) + (row.conf ?? 0.5) * 100;
/** Align consecutive screen readings in document coordinates. Each line keeps the best unobscured reading,
 * rather than concatenating partial suffixes or treating normal repeated phrases as global duplicates. */
export function createArticleBody() {
  const records = []; let previous = [], offset = 0;
  return {
    add(rows) {
      if (!rows.length) return {lines: records.map(item => item.row.text), overlap: previous.length === 0};
      const alignment = align(previous, rows);
      const overlap = previous.length === 0 || alignment.verified;
      if (alignment.offset !== null) offset = alignment.offset;
      else if (previous.length) offset = Math.max(...records.map(item => item.docY + item.row.h)) + 100 - rows[0].y;
      const next = [];
      for (const row of rows) {
        const docY = row.y + offset;
        const old = records.find(item => Math.abs(item.docY - docY) <= Math.min(28, row.h / 2, item.row.h / 2)
          && Math.abs(item.row.x - row.x) < 120);
        if (old) {
          if (quality(row) > old.quality) { old.row = row; old.docY = docY; old.quality = quality(row); }
          next.push(old);
        } else {
          const item = {row, docY, quality: quality(row)}; records.push(item); next.push(item);
        }
      }
      records.sort((a, b) => Math.abs(a.docY - b.docY) < 12 ? a.row.x - b.row.x : a.docY - b.docY); previous = next;
      return {lines: records.map(item => item.row.text), overlap};
    },
  };
}
