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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-6"
      style={{ background: 'linear-gradient(135deg, #0c0e1a 0%, #1a1040 40%, #0c0e1a 100%)' }}>

      {/* Animated gradient orbs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-[20%] -top-[20%] h-[600px] w-[600px] rounded-full opacity-30"
          style={{ background: 'radial-gradient(circle, #6366f1 0%, transparent 70%)', animation: 'pulse 6s ease-in-out infinite' }} />
        <div className="absolute -bottom-[10%] -right-[10%] h-[500px] w-[500px] rounded-full opacity-20"
          style={{ background: 'radial-gradient(circle, #a855f7 0%, transparent 70%)', animation: 'pulse 8s ease-in-out infinite 2s' }} />
        <div className="absolute left-[40%] top-[20%] h-[300px] w-[300px] rounded-full opacity-15"
          style={{ background: 'radial-gradient(circle, #06b6d4 0%, transparent 70%)', animation: 'pulse 7s ease-in-out infinite 1s' }} />
      </div>

      {/* Grid pattern */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)', backgroundSize: '60px 60px' }} />

      {/* Card */}
      <form onSubmit={handleSubmit}
        className="animate-fade-up relative z-10 w-full max-w-[420px] space-y-8 rounded-2xl border border-white/[0.08] bg-white/[0.04] p-10 shadow-2xl shadow-black/20 backdrop-blur-2xl">

        {/* Brand */}
        <div className="flex flex-col items-center">
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-indigo-500/20 to-purple-500/20 shadow-lg shadow-indigo-500/10">
            <img src="/images/logo-starvoice.svg" alt="" className="h-9 w-9 drop-shadow-lg" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-white">OnStarVoice</h1>
          <p className="mt-1.5 text-[13px] font-medium tracking-widest uppercase text-white/40">舆情作战台</p>
        </div>

        {/* Fields */}
        <div className="space-y-5">
          <div className="space-y-2">
            <label className="text-[13px] font-semibold text-white/50">邮箱地址</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="admin@example.com" autoComplete="username" autoFocus
              className="flex h-11 w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 text-[15px] text-white placeholder:text-white/20 focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all" />
          </div>
          <div className="space-y-2">
            <label className="text-[13px] font-semibold text-white/50">密码</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="请输入密码" autoComplete="current-password"
              className="flex h-11 w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 text-[15px] text-white placeholder:text-white/20 focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all" />
          </div>
        </div>

        {/* Submit */}
        <button type="submit" disabled={loading}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-500 text-[15px] font-bold text-white shadow-lg shadow-indigo-500/25 transition-all hover:shadow-xl hover:shadow-indigo-500/30 hover:brightness-110 disabled:opacity-50 active:scale-[0.98]">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {loading ? '登录中…' : '登录'}
        </button>

        {error && (
          <p className="text-center text-[13px] font-semibold text-rose-400">{error}</p>
        )}
      </form>
    </div>
  )
}
