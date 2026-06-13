import { useEffect, useState } from 'react'
import { Loader2, Lightbulb, X, Hash, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDate, platformName } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'

export function KeywordsPage() {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<any>(null)

  useEffect(() => {
    api.get<any>('/content/keywords').then(d => setRows(d.keywords || [])).catch(console.error).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <p className="text-[13px] text-muted-foreground">在扩展里跑「长尾扩词」,拉到的平台联想词 + 需求分组会汇总到这里 —— 用作选题拆分、搜索采集和评论线索观察。</p>

      {rows.length === 0 ? (
        <EmptyState icon={Lightbulb} title="还没有扩词数据"
          description="在扩展搜索页点「长尾扩词」;扩出的长尾词与需求分组会自动存进来。" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map(r => {
            const cats = r.payload?.categories || []
            return (
              <button key={r.id} onClick={() => setOpen(r)}
                className="group flex flex-col rounded-xl border border-border bg-card p-4 text-left shadow-xs transition-all hover:border-input hover:shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Hash className="h-4 w-4 text-status-orange" />
                    {r.platform && <StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge>}
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                </div>
                <h3 className="mt-2.5 truncate text-[15px] font-bold">{r.seed_keyword}</h3>
                <div className="mt-1 text-[11px] text-muted-foreground">{formatNumber(r.keyword_count)} 个长尾词 · {cats.length} 个需求方向</div>
                <div className="mt-2.5 flex flex-wrap gap-1">
                  {cats.slice(0, 4).map((c: any, i: number) => (
                    <span key={i} className="rounded bg-status-orange/12 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">{c.name} {c.keywords?.length || 0}</span>
                  ))}
                </div>
                <div className="mt-2.5 text-[10.5px] text-muted-foreground">{formatDate(r.created_at)}</div>
              </button>
            )
          })}
        </div>
      )}

      {open && <KeywordDrawer row={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function KeywordDrawer({ row, onClose }: { row: any; onClose: () => void }) {
  const data = row.payload || {}
  const cats = data.categories || []
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/35" />
      <div className="relative z-10 flex h-full w-full max-w-xl flex-col border-l border-border bg-card shadow-lg animate-in slide-in-from-right duration-200" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-bold">扩词分析 · {row.seed_keyword}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {data.summary && <div className="mb-5 rounded-lg border border-border bg-muted/30 p-4 text-sm leading-relaxed text-muted-foreground">{data.summary}</div>}
          <div className="space-y-4">
            {cats.map((c: any, i: number) => (
              <section key={i}>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{c.name}</h3>
                  <span className="rounded-full bg-muted px-1.5 text-[10px] font-bold text-muted-foreground">{c.keywords?.length || 0}</span>
                </div>
                {c.insight && <p className="mb-2 text-xs leading-relaxed text-muted-foreground">{c.insight}</p>}
                <div className="flex flex-wrap gap-1.5">
                  {(c.keywords || []).slice(0, 40).map((kw: string, j: number) => (
                    <span key={j} className="rounded-md border border-border bg-card px-2 py-0.5 text-[11px] text-foreground/80">{kw}</span>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
