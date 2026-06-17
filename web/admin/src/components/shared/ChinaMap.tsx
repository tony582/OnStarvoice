import { useMemo } from 'react'
import { geoMercator, geoPath } from 'd3-geo'
import chinaGeo from 'china-geojson/src/geojson/china.json'
import { formatNumber } from '@/lib/utils'

const W = 800, H = 600
const FC: any = chinaGeo
const FEATURES: any[] = FC.features || []

// 归一化省名:去后缀,便于和 IP 属地匹配
function norm(s: string) {
  return (s || '').replace(/省|市|自治区|特别行政区|壮族|回族|维吾尔族|维吾尔/g, '').trim()
}

// 投影只拟合大陆主体(排除南海诸岛,避免主体被压小),路径模块级算一次
const PATHS: Array<{ name: string; d: string }> = (() => {
  const fitFC = { type: 'FeatureCollection', features: FEATURES.filter(f => f.properties?.name !== '南海诸岛') }
  const projection = geoMercator().fitSize([W, H], fitFC as any)
  const pg = geoPath(projection as any)
  return FEATURES.map(f => ({ name: f.properties?.name || '', d: pg(f) || '' })).filter(p => p.d)
})()

/**
 * 中国省级填色地图(地域分布)。rows: [{ region, count }]。d3-geo + china-geojson,无地图服务依赖。
 */
export default function ChinaMap({ rows }: { rows: any[] }) {
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
    if (!v) return 'rgba(47,111,237,0.07)' // 无数据省份:极浅蓝,保证地图轮廓始终可见
    return `rgba(47,111,237,${(0.22 + 0.74 * (v / max)).toFixed(2)})`
  }

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="地域分布地图"
        style={{ width: '100%', aspectRatio: `${W} / ${H}`, height: 'auto', overflow: 'hidden', display: 'block' }}
      >
        {PATHS.map(p => (
          <path key={p.name} d={p.d} fill={fillOf(p.name)} stroke="var(--card)" strokeWidth={0.7}>
            <title>{p.name} · {formatNumber(valOf(p.name))}</title>
          </path>
        ))}
      </svg>
      <div className="mt-1 flex items-center justify-end gap-2 text-[10.5px] text-muted-foreground">
        <span>少</span>
        <span className="h-2 w-24 rounded-full" style={{ background: 'linear-gradient(90deg, rgba(47,111,237,0.12), rgba(47,111,237,0.96))' }} />
        <span>多</span>
      </div>
    </div>
  )
}
