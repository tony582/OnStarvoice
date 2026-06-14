import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/lib/auth'
import { Loader2 } from 'lucide-react'

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
    try { await login(email.trim(), password) }
    catch (err: any) { setError(err.message || '登录失败') }
    finally { setLoading(false) }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <form onSubmit={handleSubmit}
        className="animate-fade-up w-full max-w-[400px] space-y-7 rounded-lg border border-border bg-card p-8 shadow-sm">

        <div className="flex flex-col items-center">
          <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-muted/40">
            <img src="/images/logo-starvoice.svg" alt="" className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">StarVoice</h1>
          <p className="mt-1.5 text-[13px] font-medium tracking-widest uppercase text-muted-foreground">舆情作战台</p>
        </div>

        <div className="space-y-5">
          <div className="space-y-2">
            <label className="text-[13px] font-semibold text-muted-foreground">邮箱地址</label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="admin@example.com" autoComplete="username" autoFocus
              className="h-11 text-[15px]" />
          </div>
          <div className="space-y-2">
            <label className="text-[13px] font-semibold text-muted-foreground">密码</label>
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="请输入密码" autoComplete="current-password"
              className="h-11 text-[15px]" />
          </div>
        </div>

        <Button type="submit" disabled={loading} className="h-11 w-full text-[15px]">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {loading ? '登录中…' : '登录'}
        </Button>

        {error && (
          <p className="text-center text-[13px] font-semibold text-destructive">{error}</p>
        )}
      </form>
    </div>
  )
}
