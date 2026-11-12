import { createRoot } from 'react-dom/client'
import { AuthProvider, useAuth } from '../../src/lib/auth'
import { BadgesProvider } from '../../src/lib/badges'
import { NavProvider } from '../../src/lib/navigation'
import { TriageQueue } from '../../src/pages/workbench/TriageQueue'
import '../../src/index.css'

export function Fixture() {
  const { loading } = useAuth()
  return loading ? <p>载入离线测试</p> : <BadgesProvider><NavProvider><TriageQueue /></NavProvider></BadgesProvider>
}
createRoot(document.getElementById('root')!).render(<AuthProvider><Fixture /></AuthProvider>)
