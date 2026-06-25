import { useRef, useState, type ReactNode } from 'react'

/**
 * 通用悬浮提示:包住任意元素,鼠标移入即时弹出样式化说明。
 * 用 fixed 定位(按 bounding rect 计算),不会被表格 overflow / 卡片裁切,
 * 替代又慢又常不显示的原生 title。点击照常冒泡(不拦行点击)。
 */
export function Tooltip({ text, children, className = '' }: { text: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  const show = () => { const r = ref.current?.getBoundingClientRect(); if (r) setPos({ x: r.left + r.width / 2, y: r.top }) }
  const hide = () => setPos(null)

  return (
    <>
      <span ref={ref} onMouseEnter={show} onMouseLeave={hide} className={`inline-flex ${className}`}>{children}</span>
      {pos && (
        <div
          className="pointer-events-none fixed z-[80] w-[240px] -translate-x-1/2 -translate-y-full rounded-lg bg-foreground px-3 py-2 text-[11.5px] font-normal normal-case leading-5 tracking-normal text-background shadow-xl"
          style={{ left: pos.x, top: pos.y - 8 }}
        >
          {text}
        </div>
      )}
    </>
  )
}
