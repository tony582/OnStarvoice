import { Loader2 } from 'lucide-react'

/** Suspense fallback shown while a lazily loaded page chunk is fetched. */
export function PageLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground" role="status" aria-live="polite">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
      <span className="ml-2 text-sm">页面加载中…</span>
    </div>
  )
}
