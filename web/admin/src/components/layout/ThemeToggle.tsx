import { useEffect } from 'react'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function ThemeToggle() {
  useEffect(() => {
    const saved = localStorage.getItem('osv_theme')
    if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark')
    }
  }, [])

  const toggle = () => {
    const isDark = document.documentElement.classList.toggle('dark')
    localStorage.setItem('osv_theme', isDark ? 'dark' : 'light')
  }

  return (
    <Button variant="outline" size="icon" onClick={toggle} title="切换主题" aria-label="切换浅色/深色主题">
      <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
    </Button>
  )
}
