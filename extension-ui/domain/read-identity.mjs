/** Exact identity for the proposed read contract, not a legacy ownership mapping. */
export function exactReadIdentity(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) return null;
  if (/[\s\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uD800-\uDFFF]/u.test(value)) return null;
  return value;
}
