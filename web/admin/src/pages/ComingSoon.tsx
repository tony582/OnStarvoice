import type { LucideIcon } from 'lucide-react'
import { Sparkles, TrendingUp, Flame, Users2, Lightbulb, LineChart, Route, Hammer } from 'lucide-react'

type Spec = { icon: LucideIcon; title: string; desc: string; bullets: string[]; accent: string }

const SPECS: Record<string, Spec> = {
  'content-home': { icon: Sparkles, title: '内容总览', accent: 'text-status-purple', desc: '内容创意面的今日行动台:关注赛道动态、每日选题灵感、对标账号新爆款。', bullets: ['我关注的赛道动态速览', '今日选题灵感(每日热词)', '对标账号新爆款卡片'] },
  tracks: { icon: TrendingUp, title: '赛道大盘', accent: 'text-status-blue', desc: '自定义关键词/垂类 → 内容·达人·品牌·受众四维报告;赛道热度与断层预警。', bullets: ['赛道热度仪表盘 + 趋势', '断层预警 / 蓝海词机会评分', '⚠ 通用化需把单品牌引擎重写为数据驱动聚类'] },
  hits: { icon: Flame, title: '爆款拆解', accent: 'text-status-red', desc: '单条内容反编译:黄金3秒钩子 / 标题公式 / 正文结构 / 标签效能 → 可复刻仿写模板。', bullets: ['钩子 · 标题公式 · 情绪结构拆解', 'AI 生成可复刻模板', '⚠ 需从零新建 hit-analyzer AI 服务'] },
  benchmarks: { icon: Users2, title: '对标账号库', accent: 'text-status-teal', desc: '行业/涨粉/成长榜 + 账号深度画像 + 多账号对比;账号可打标签、指派、状态流转。', bullets: ['垂类榜单 + 生长势能排序', '账号沉淀为可协作卡片', '↔ 与舆情监控源共享账号实体,可跨面跳转'] },
  keywords: { icon: Lightbulb, title: '选题与扩词', accent: 'text-status-orange', desc: '长尾扩词 + 关键词热度 + 飙升词 + 选题日历;灵感可收藏成卡片、指派、进看板。', bullets: ['长尾扩词词库(需扩展回传)', '每日热词推选题 + 节日热点日历', 'SEO 布词建议'] },
  review: { icon: LineChart, title: '内容复盘', accent: 'text-status-green', desc: '发布后数据回收 + 自己 vs 对标 vs 历史对比 + 选题类型占比 + 周月报。', bullets: ['内容效果回收对比', '选题结构复盘', '周/月报自动生成'] },
  events: { icon: Route, title: '事件中心', accent: 'text-status-indigo', desc: '负面聚类成事件:时间脉络叙事 + 影响力指数 + (验证可行后)传播路径网络图。', bullets: ['事件脉络时间线(数据已具备)', '影响力指数 / 扩散热度', '⚠ 传播网络图依赖转发关系链,需先验采集可行性'] },
}

export function ComingSoon({ pageId }: { pageId: string }) {
  const spec = SPECS[pageId] || { icon: Hammer, title: '建设中', accent: 'text-muted-foreground', desc: '此模块正在规划中。', bullets: [] }
  const Icon = spec.icon
  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="mx-auto mt-6 max-w-xl rounded-2xl border border-border bg-card p-8 text-center shadow-xs">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
          <Icon className={`h-7 w-7 ${spec.accent}`} strokeWidth={1.7} />
        </div>
        <h2 className="mt-4 text-lg font-semibold">{spec.title}</h2>
        <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-status-green/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
          规划中 · 敬请期待
        </span>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">{spec.desc}</p>
        {spec.bullets.length > 0 && (
          <ul className="mx-auto mt-5 max-w-sm space-y-2 text-left">
            {spec.bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2.5 text-[13px] text-foreground">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
                <span className="leading-relaxed">{b}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
