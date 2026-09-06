/** A lookup identity is never shortened or normalized like display text. */
export function exactRecordId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return '';
  if (/[\s\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u.test(value)) return '';
  // In Unicode mode, valid surrogate pairs are a single code point and do not match.
  if (/[\uD800-\uDFFF]/u.test(value)) return '';
  return value;
}
