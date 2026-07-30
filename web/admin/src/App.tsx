import { lazy, Suspense, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { AuthProvider, useAuth } from '@/lib/auth'
import { NavProvider, useNav } from '@/lib/navigation'
import { BadgesProvider } from '@/lib/badges'
import { resolveUiMode } from '@/lib/ui-mode'
import { LoginPage } from '@/pages/LoginPage'

const DesktopApp = lazy(() => import('@/desktop/DesktopApp'))
const MobileApp = lazy(() => import('@/mobile/MobileApp'))
function FullScreenLoading() {
  return <div className="flex min-h-dvh items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>
}

function OfficialCommentPatrolPreviewShell() {
  const { navigate } = useNav()

  useEffect(() => {
    navigate('official-comments')
  }, [navigate])

  return <DesktopApp />
}

function AdaptiveApp() {
  const { user, loading } = useAuth()
  // 首次进入时选壳并固定到本次挂载周期，避免横竖屏切换卸载未提交的表单。
  const [uiMode] = useState(resolveUiMode)
  const officialCommentPreview = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get('preview') === 'official-comment-ops'

  if (officialCommentPreview) {
    return (
      <Suspense fallback={<FullScreenLoading />}>
        <OfficialCommentPatrolPreviewShell />
      </Suspense>
    )
  }

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
