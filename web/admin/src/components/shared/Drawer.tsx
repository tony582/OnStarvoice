import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

// 右侧滑入抽屉公共骨架：遮罩 + 面板 + Esc 关闭 + 焦点陷阱 + body 滚动锁定。
// 调度中心三处抽屉（Agent 详情 / 新建任务向导 / 多 Agent 编排）统一复用，
// 各抽屉只负责自己的 header / 内容 / footer。
const WIDTH_CLASSES = {
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
} as const

export function Drawer({
  onClose,
  width = 'md',
  labelledBy,
  children,
  closeOnOverlay = true,
  panelClassName,
}: {
  onClose: () => void
  width?: keyof typeof WIDTH_CLASSES
  labelledBy: string
  children: ReactNode
  /** 多步表单等怕误触丢内容的场景传 false，只用 X / Esc 关闭。 */
  closeOnOverlay?: boolean
  /** 追加到面板上的自定义类（可覆盖默认宽度等）。 */
  panelClassName?: string
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  // onClose 经 ref 调用，避免父组件内联函数导致焦点管理 effect 反复重建。
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current
      if (!panel) return
      const initialFocus = panel.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      if (initialFocus) initialFocus.focus()
      else panel.focus()
    }, 0)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )).filter(element => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true')
      if (focusable.length === 0) {
        event.preventDefault()
        panelRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [])

  const drawer = (
    <div className="fixed inset-0 z-[80] flex justify-end">
      <div
        className="absolute inset-0 bg-black/35"
        aria-hidden="true"
        onMouseDown={closeOnOverlay ? () => onCloseRef.current() : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn(
          'relative z-10 flex h-full w-full flex-col bg-card shadow-2xl outline-none motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200 lg:border-l lg:border-border',
          WIDTH_CLASSES[width],
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>
  )

  // 页面内容区带滚动和入场动画，直接嵌套会让 fixed 抽屉落入它的
  // stacking context，顶部随后被全局导航栏盖住。挂到 body 后，抽屉
  // 始终以整个视口为参照，并统一高于导航、侧栏和移动端悬浮按钮。
  return createPortal(drawer, document.body)
}
