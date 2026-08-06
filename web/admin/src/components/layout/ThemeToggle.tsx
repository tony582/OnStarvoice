import { Moon, Sun } from 'lucide-react'
import { useState } from 'react'

interface ThemeToggleProps {
  variant?: 'icon' | 'menu'
}

export function ThemeToggle({ variant = 'icon' }: ThemeToggleProps) {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  )

  const toggle = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('osv_theme', next ? 'dark' : 'light')
  }

  if (variant === 'menu') {
    return (
      <button type="button" role="menuitem" onClick={toggle}
        className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12.5px] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground">
        {dark ? <Sun className="h-4 w-4 shrink-0" strokeWidth={1.8} /> : <Moon className="h-4 w-4 shrink-0" strokeWidth={1.8} />}
        <span>{dark ? '切换为浅色' : '切换为深色'}</span>
      </button>
    )
  }

  return (
    <button type="button" onClick={toggle} title="切换主题" aria-label="切换主题"
      className="relative flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors duration-150 hover:border-input hover:bg-muted hover:text-foreground">
      <Sun className="h-4 w-4 rotate-0 scale-100 transition-transform duration-300 dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-transform duration-300 dark:rotate-0 dark:scale-100" />
    </button>
  )
}
