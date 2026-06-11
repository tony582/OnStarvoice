import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/lib/auth'

export function LoginPage() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email.trim(), password)
    } catch (err: any) {
      setError(err.message || '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-6">
      {/* Background orbs */}
      <div className="pointer-events-none absolute -left-32 -top-32 h-[500px] w-[500px] animate-pulse rounded-full bg-primary/20 blur-[100px]" />
      <div className="pointer-events-none absolute -bottom-24 -right-24 h-[400px] w-[400px] animate-pulse rounded-full bg-cyan-500/15 blur-[100px]" style={{ animationDelay: '2s' }} />

      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-md space-y-6 rounded-2xl border border-border/50 bg-card/80 p-10 shadow-2xl backdrop-blur-xl">
        <div className="flex flex-col items-center">
          <img src="/images/logo-starvoice.svg" alt="" className="mb-5 h-14 w-14 drop-shadow-lg" />
          <h1 className="bg-gradient-to-r from-primary to-cyan-500 bg-clip-text text-2xl font-extrabold text-transparent">
            OnStarVoice 星语
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">舆情作战台</p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-muted-foreground">邮箱</label>
            <Input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="admin@example.com"
              autoComplete="username"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-semibold text-muted-foreground">密码</label>
            <Input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
            />
          </div>
        </div>

        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? '登录中…' : '登录'}
        </Button>

        {error && (
          <p className="text-center text-sm font-medium text-destructive">{error}</p>
        )}
      </form>
    </div>
  )
}
