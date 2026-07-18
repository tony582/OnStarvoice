import { lazy, Suspense, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { AuthProvider, useAuth } from '@/lib/auth'
import { NavProvider } from '@/lib/navigation'
import { BadgesProvider } from '@/lib/badges'
import { resolveUiMode } from '@/lib/ui-mode'
import { LoginPage } from '@/pages/LoginPage'

const DesktopApp = lazy(() => import('@/desktop/DesktopApp'))
const MobileApp = lazy(() => import('@/mobile/MobileApp'))

function FullScreenLoading() {
  return <div className="flex min-h-dvh items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>
}

function AdaptiveApp() {
  const { user, loading } = useAuth()
  // 首次进入时选壳并固定到本次挂载周期，避免横竖屏切换卸载未提交的表单。
  const [uiMode] = useState(resolveUiMode)

  if (loading) return <FullScreenLoading />
  if (!user) return <LoginPage />

  return (
    <Suspense fallback={<FullScreenLoading />}>
      {uiMode === 'mobile' ? <MobileApp /> : <DesktopApp />}
    </Suspense>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <NavProvider>
        <BadgesProvider>
          <AdaptiveApp />
        </BadgesProvider>
      </NavProvider>
    </AuthProvider>
  )
}
