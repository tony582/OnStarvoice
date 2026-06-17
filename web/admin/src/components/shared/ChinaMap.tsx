import { geoMercator, geoPath } from 'd3-geo'
import chinaGeo from 'china-geojson/src/geojson/china.json'
import { formatNumber } from '@/lib/utils'

// 省界几何静态,模块级只算一次投影与路径
const W = 760, H = 560
const FC: any = chinaGeo
const projection = geoMercator().fitSize([W, H], FC as any)
const pathGen = geoPath(projection as any)
const PATHS: Array<{ name: string; d: string }> = FC.features.map((f: any) => ({
  name: f.properties?.name || '',
  d: pathGen(f) || '',
}))

// 归一化省名:去掉 省/市/自治区 等后缀,便于和 IP 属地匹配
function norm(s: string) {
  return (s || '').replace(/省|市|自治区|特别行政区|壮族|回族|维吾尔族|维吾尔/g, '').trim()
}

/**
 * 中国省级填色地图(地域分布)。rows: [{ region, count }]。无地图库依赖,用 d3-geo + china-geojson。
 */
export default function ChinaMap({ rows }: { rows: any[] }) {
  const lookup = new Map<string, number>()
  for (const r of rows || []) {
    const k = norm(r.region)
    if (!k || k === '未采集') continue
    lookup.set(k, (lookup.get(k) || 0) + (Number(r.count) || 0))
  }
  const max = Math.max(1, ...Array.from(lookup.values()))
  const valOf = (name: string) => lookup.get(norm(name)) || 0
  const fillOf = (name: string) => {
    const v = valOf(name)
    if (!v) return 'var(--muted)'
    return `rgba(47,111,237,${(0.16 + 0.8 * (v / max)).toFixed(2)})`
  }

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="地域分布地图">
        {PATHS.map(p => (
          <path key={p.name} d={p.d} fill={fillOf(p.name)} stroke="var(--card)" strokeWidth={0.6} className="transition-[fill] duration-150">
            <title>{p.name} · {formatNumber(valOf(p.name))}</title>
          </path>
        ))}
      </svg>
      <div className="mt-1 flex items-center justify-end gap-2 text-[10.5px] text-muted-foreground">
        <span>少</span>
        <span className="h-2 w-24 rounded-full" style={{ background: 'linear-gradient(90deg, rgba(47,111,237,0.16), rgba(47,111,237,0.96))' }} />
        <span>多</span>
      </div>
    </div>
  )
}
