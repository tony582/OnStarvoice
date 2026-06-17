import { useMemo, useState } from 'react'
import { geoMercator, geoPath } from 'd3-geo'
import chinaGeo from 'china-geojson/src/geojson/china.json'
import { formatNumber } from '@/lib/utils'

const W = 800, H = 600
const FC: any = chinaGeo
const FEATURES: any[] = FC.features || []

function norm(s: string) {
  return (s || '').replace(/省|市|自治区|特别行政区|壮族|回族|维吾尔族|维吾尔/g, '').trim()
}

// 投影只拟合大陆主体(排除南海诸岛),路径模块级算一次
const PATHS: Array<{ name: string; d: string }> = (() => {
  const fitFC = { type: 'FeatureCollection', features: FEATURES.filter(f => f.properties?.name !== '南海诸岛') }
  const projection = geoMercator().fitSize([W, H], fitFC as any)
  const pg = geoPath(projection as any)
  return FEATURES.map(f => ({ name: f.properties?.name || '', d: pg(f) || '' })).filter(p => p.d)
})()

export default function ChinaMap({ rows }: { rows: any[] }) {
  const [hover, setHover] = useState<{ name: string; count: number; x: number; y: number } | null>(null)
  const { lookup, max } = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows || []) {
      const k = norm(r.region)
      if (!k || k === '未采集') continue
      m.set(k, (m.get(k) || 0) + (Number(r.count) || 0))
    }
    return { lookup: m, max: Math.max(1, ...Array.from(m.values())) }
  }, [rows])

  const valOf = (name: string) => lookup.get(norm(name)) || 0
  const fillOf = (name: string) => {
    const v = valOf(name)
    if (!v) return 'rgba(47,111,237,0.07)'
    return `rgba(47,111,237,${(0.22 + 0.74 * (v / max)).toFixed(2)})`
  }

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="地域分布地图"
        style={{ width: '100%', aspectRatio: `${W} / ${H}`, height: 'auto', overflow: 'hidden', display: 'block' }}
        onMouseLeave={() => setHover(null)}
      >
        {PATHS.map(p => {
          const on = hover?.name === p.name
          return (
            <path
              key={p.name}
              d={p.d}
              fill={fillOf(p.name)}
              stroke={on ? 'var(--primary)' : 'var(--card)'}
              strokeWidth={on ? 1.6 : 0.7}
              style={{ cursor: 'pointer', transition: 'stroke-width .1s' }}
              onMouseMove={e => setHover({ name: p.name, count: valOf(p.name), x: e.clientX, y: e.clientY })}
              onMouseEnter={e => setHover({ name: p.name, count: valOf(p.name), x: e.clientX, y: e.clientY })}
            />
          )
        })}
      </svg>

      {hover && (
        <div
          className="pointer-events-none fixed z-[80] rounded-lg bg-foreground px-2.5 py-1.5 text-[12px] font-medium text-background shadow-lg"
          style={{ left: hover.x + 14, top: hover.y + 14 }}
        >
          {hover.name} · {formatNumber(hover.count)}
        </div>
      )}

      <div className="mt-1 flex items-center justify-end gap-2 text-[10.5px] text-muted-foreground">
        <span>少</span>
        <span className="h-2 w-24 rounded-full" style={{ background: 'linear-gradient(90deg, rgba(47,111,237,0.12), rgba(47,111,237,0.96))' }} />
        <span>多</span>
      </div>
    </div>
  )
}
