import { useEffect, useState } from 'react'
import { Loader2, Database } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, LABELS, platformName, compact, formatNumber } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export function DataPage() {
  const [records, setRecords] = useState<any[]>([])
  const [pagination, setPagination] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const load = async (page = 1) => {
    setLoading(true)
    const data = await api.get<any>('/triage/records?pageSize=50&page=' + page)
    setRecords(data.records || [])
    setPagination(data.pagination || null)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  if (!records.length) return <EmptyState icon={Database} title="暂无数据" />

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border bg-muted/50">
            <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">内容</th>
            <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">平台</th>
            <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">情感</th>
            <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">互动</th>
            <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">时间</th>
          </tr></thead>
          <tbody className="divide-y divide-border">
            {records.map(r => (
              <tr key={r.id} className="transition-colors hover:bg-muted/30">
                <td className="max-w-sm px-4 py-3">
                  <div className="truncate font-medium">{r.title || '(无标题)'}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{compact(r.content || '', 60)}</div>
                </td>
                <td className="px-4 py-3"><StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge></td>
                <td className="px-4 py-3"><StatusBadge tone={r.sentiment || 'muted'}>{LABELS.sentiment[r.sentiment] || '待标注'}</StatusBadge></td>
                <td className="px-4 py-3 tabular-nums">{formatNumber(r.likes)}/{formatNumber(r.comments_count)}/{formatNumber(r.collects)}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">共 {formatNumber(pagination.total)} 条</span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page <= 1} onClick={() => load(pagination.page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="px-3 text-sm tabular-nums text-muted-foreground">{pagination.page} / {pagination.totalPages}</span>
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page >= pagination.totalPages} onClick={() => load(pagination.page + 1)}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
