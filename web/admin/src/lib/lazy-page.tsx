import { lazy, Suspense, type ComponentType } from 'react'
import { PageLoading } from '@/lib/page-loading'

/**
 * Route-level code splitting for a page exported by name.
 *
 * Every page module used to be imported statically by both shells, which put
 * all 22 pages (and recharts, via the insights pages) into one ~1.3 MB chunk
 * that every login had to download. Wrapping each page in `lazyPage` makes
 * Vite emit one chunk per page and loads it on first navigation; the
 * `import()` argument must stay a literal string so the bundler can see it.
 *
 * Pass the page's prop type explicitly when it takes props, e.g.
 * `lazyPage<{ surface?: 'desktop' | 'mobile' }>(() => import('@/pages/dispatch/DispatchPage'), 'DispatchPage')`.
 */
export function lazyPage<P extends object = Record<string, never>>(
  loader: () => Promise<object>,
  exportName: string,
): ComponentType<P> {
  const Page = lazy(async () => {
    const module = (await loader()) as Record<string, unknown>
    const component = module[exportName] as ComponentType<P> | undefined
    if (!component) throw new Error(`lazyPage: module has no export named ${exportName}`)
    return { default: component }
  })
  const LazyPage = (props: P) => (
    <Suspense fallback={<PageLoading />}>
      <Page {...props} />
    </Suspense>
  )
  LazyPage.displayName = `LazyPage(${exportName})`
  return LazyPage
}
