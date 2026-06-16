import { LeadsQueue } from '@/pages/workbench/LeadsQueue'

// 销售客资:从舆情工作台独立出来的模块(购买意向/询价/留联系方式的评论)。
export function SalesLeadsPage() {
  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
      <LeadsQueue category="sales" />
    </div>
  )
}
