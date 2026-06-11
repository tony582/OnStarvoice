import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { formatNumber } from '@/lib/utils'
import { EmptyState } from './EmptyState'
import { BarChart3 } from 'lucide-react'

interface TrendRow {
  day: string
  total: number
  negative: number
}

export function TrendChart({ data }: { data: TrendRow[] }) {
  if (!data.length) return <EmptyState icon={BarChart3} title="暂无趋势数据" description="采集数据后将显示风险趋势" />

  const chartData = data.map(r => ({
    day: String(r.day || '').slice(5),
    total: Number(r.total) || 0,
    negative: Number(r.negative) || 0,
  }))

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} barCategoryGap="20%">
          <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: 'var(--muted-fg)' }} />
          <YAxis hide />
          <Tooltip
            cursor={{ fill: 'var(--muted)', opacity: 0.3 }}
            contentStyle={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              fontSize: '12px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
            }}
            formatter={(value: number, name: string) => [formatNumber(value), name === 'negative' ? '负面' : '总计']}
          />
          <Bar dataKey="total" radius={[4, 4, 0, 0]} maxBarSize={32}>
            {chartData.map((_, i) => (
              <Cell key={i} fill="var(--primary)" opacity={0.65} />
            ))}
          </Bar>
          <Bar dataKey="negative" radius={[4, 4, 0, 0]} maxBarSize={32}>
            {chartData.map((_, i) => (
              <Cell key={i} fill="var(--destructive)" opacity={0.8} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-primary opacity-65" />总计</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-destructive opacity-80" />负面</span>
      </div>
    </div>
  )
}
