// Unknown counters contribute zero to ranking/sums; stored counters remain NULL.
export function knownInteractionSumSql(alias = '') {
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new TypeError('Invalid SQL alias');
  const prefix = alias ? `${alias}.` : '';
  return ['likes', 'comments_count', 'collects', 'shares']
    .map(column => `COALESCE(${prefix}${column}, 0)`)
    .join(' + ');
}
