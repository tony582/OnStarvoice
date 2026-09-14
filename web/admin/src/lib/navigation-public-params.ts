export function normalizePublicPageParams(search: URLSearchParams): Record<string, string> {
  const entries = [...search.entries()]
    .filter(([key]) => key !== 'page')
    .slice(0, 20)
    .map(([key, value]) => [key.slice(0, 80), value.slice(0, 500)] as const)
  const params = Object.fromEntries(entries)
  // These filters use repeated API parameters and comma-separated navigation
  // values. Preserve every selected category within the existing URL bounds.
  for (const key of ['intent', 'relevance', 'relevanceConfidence']) {
    const values = entries.filter(([name]) => name === key).map(([, value]) => value)
    if (values.length) params[key] = values.join(',').slice(0, 500)
  }
  return params
}
