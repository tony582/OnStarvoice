import { useRef, useState } from 'react'
import { HelpCircle } from 'lucide-react'

/**
 * 指标口径提示:一个 (?) 小图标,悬停/聚焦弹出说明。
 * 用 fixed 定位(按图标 bounding rect 计算),不会被卡片 overflow-hidden 裁切。
 * 面向"只看报告"的客户,说明每个指标怎么统计/计算。
 */
export function InfoHint({ text, className = '' }: { text: string; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ x: r.left + r.width / 2, y: r.top })
  }
  const hide = () => setPos(null)

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label="指标说明"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => { e.stopPropagation(); pos ? hide() : show() }}
        className={`inline-grid h-3.5 w-3.5 shrink-0 place-items-center align-middle text-muted-foreground/50 transition-colors hover:text-primary ${className}`}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      {pos && (
        <div
          className="pointer-events-none fixed z-[80] w-[260px] -translate-x-1/2 -translate-y-full rounded-lg bg-foreground px-3 py-2 text-[11.5px] font-normal leading-5 text-background shadow-xl"
          style={{ left: pos.x, top: pos.y - 8 }}
        >
          {text}
        </div>
      )}
    </>
  )
}
