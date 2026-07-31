import { useEffect, useState } from 'react'
import { Loader2, ShieldCheck, Plus, Trash2, Save, History, Check, Info } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { WorkbenchSelect } from '@/components/shared/Workbench'
import { cn } from '@/lib/utils'

type Row = {
  id?: string
  platform: string
  account_name: string
  aliasesText: string
  account_id: string
  account_no: string
  platform_user_id: string
  profile_url: string
  skip_content: boolean
}

type OfficialAccountApiRow = {
  id?: string
  platform?: string
  account_name?: string
  aliases?: unknown
  account_id?: string
  account_no?: string
  accountNo?: string
  platform_user_id?: string
  platformUserId?: string
  profile_url?: string
  profileUrl?: string
  skip_content?: boolean
}

type OfficialAccountsResponse = {
  accounts?: OfficialAccountApiRow[]
}

type ReclassifyResponse = {
  excluded?: number
  officialReplies?: number
  repliedRecords?: number
}

const PLATFORMS = [
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'douyin', label: '抖音' },
  { value: 'weibo', label: '微博' },
]

export function OwnedAccountExclusionsPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reclassifying, setReclassifying] = useState(false)
  const [msg, setMsg] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const d = await api.get<OfficialAccountsResponse>('/admin/owned-account-exclusions')
      setRows((d.accounts || []).map(a => ({
        id: a.id || undefined,
        platform: a.platform || 'xiaohongshu',
        account_name: a.account_name || '',
        aliasesText: (Array.isArray(a.aliases) ? a.aliases : []).join(', '),
        account_id: a.account_id || '',
        account_no: a.account_no || a.accountNo || a.account_id || '',
        platform_user_id: a.platform_user_id || a.platformUserId || '',
        profile_url: a.profile_url || a.profileUrl || '',
        skip_content: a.skip_content !== false,
      })))
    } catch (err) { console.error(err) } finally { setLoading(false) }
  }
  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) void load() })
    return () => { active = false }
  }, [])

  const update = (i: number, patch: Partial<Row>) => setRows(rs => rs.map((r, j) => j === i ? { ...r, ...patch } : r))
  const addRow = () => setRows(rs => [...rs, {
    platform: 'xiaohongshu',
    account_name: '',
    aliasesText: '',
    account_id: '',
    account_no: '',
    platform_user_id: '',
    profile_url: '',
    skip_content: true,
  }])
  const removeRow = (i: number) => setRows(rs => rs.filter((_, j) => j !== i))

  const save = async () => {
    setSaving(true); setMsg('')
    try {
      const accounts = rows.filter(r => r.account_name.trim()).map(r => ({
        id: r.id,
        platform: r.platform,
        accountName: r.account_name.trim(),
        aliases: r.aliasesText.split(',').map(s => s.trim()).filter(Boolean),
        accountId: (r.account_no || r.account_id).trim(),
        accountNo: (r.account_no || r.account_id).trim(),
        platformUserId: r.platform_user_id.trim(),
        profileUrl: r.profile_url.trim(),
        skipContent: r.skip_content,
      }))
      await api.put('/admin/owned-account-exclusions', { accounts })
      setMsg('已保存排除规则。')
      void load()
    } catch (err) { setMsg('保存失败:' + (err instanceof Error ? err.message : '')) } finally { setSaving(false) }
  }

  const reclassify = async () => {
    setReclassifying(true); setMsg('')
    try {
      const d = await api.post<ReclassifyResponse>('/admin/owned-account-exclusions/reclassify')
      setMsg(`回溯完成:移出监测 ${d.excluded ?? 0} 条官方发文;识别官方回复 ${d.officialReplies ?? 0} 条,标记「已官方回复」内容 ${d.repliedRecords ?? 0} 条。`)
    } catch (err) { setMsg('回溯失败:' + (err instanceof Error ? err.message : '')) } finally { setReclassifying(false) }
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-5 duration-300">
      <div className="flex items-start gap-2.5 rounded-xl border border-status-blue/30 bg-status-blue/[0.05] p-4">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-status-blue" />
        <div className="text-[12.5px] leading-relaxed text-foreground/80">
          这里只维护内容分诊排除规则，不会新增、删除或暂停 Extension 中的官方社媒账号。
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3 sm:px-5">
          <h2 className="inline-flex items-center gap-1.5 text-[13px] font-semibold"><ShieldCheck className="h-4 w-4 text-status-green" />自营内容排除名单 <span className="text-muted-foreground">({rows.length})</span></h2>
          <Button variant="outline" size="sm" onClick={addRow}><Plus className="h-3.5 w-3.5" />添加排除规则</Button>
        </div>
        <div className="divide-y divide-border">
          <div className="hidden grid-cols-[110px_1fr_1fr_120px_72px_36px] items-center gap-2 bg-muted px-4 py-2 text-[11px] font-medium text-muted-foreground lg:grid">
            <span>平台</span><span>账号名(精确)</span><span>别名(逗号分隔)</span><span>账号ID(选填)</span><span>退出监测</span><span></span>
          </div>
          {rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">暂无自营内容排除规则</div>
          ) : rows.map((r, i) => (
            <div key={i} className="grid grid-cols-1 items-center gap-3 px-3 py-4 lg:grid-cols-[110px_1fr_1fr_120px_72px_36px] lg:gap-2 lg:px-4 lg:py-2.5">
              <label><span className="mb-1 block text-[11px] font-semibold text-muted-foreground lg:hidden">平台</span><WorkbenchSelect value={r.platform} onChange={e => update(i, { platform: e.target.value })} className="w-full">
                {PLATFORMS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </WorkbenchSelect></label>
              <label><span className="mb-1 block text-[11px] font-semibold text-muted-foreground lg:hidden">账号名（精确）</span><Input value={r.account_name} onChange={e => update(i, { account_name: e.target.value })} placeholder="上海安吉星信息服务有限公司" className="h-10 text-[12px] lg:h-8" /></label>
              <label><span className="mb-1 block text-[11px] font-semibold text-muted-foreground lg:hidden">别名（逗号分隔）</span><Input value={r.aliasesText} onChange={e => update(i, { aliasesText: e.target.value })} placeholder="安吉星OnStar, 安吉星客服" className="h-10 text-[12px] lg:h-8" /></label>
              <label><span className="mb-1 block text-[11px] font-semibold text-muted-foreground lg:hidden">账号 ID（选填）</span><Input value={r.account_no || r.account_id} onChange={e => update(i, { account_no: e.target.value, account_id: e.target.value })} placeholder="客户可见账号号" className="h-10 text-[12px] lg:h-8" /></label>
              <button onClick={() => update(i, { skip_content: !r.skip_content })} className="flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-left lg:min-h-0 lg:justify-center lg:border-0 lg:px-0">
                <span className={cn('flex h-[18px] w-[18px] items-center justify-center rounded border transition-colors', r.skip_content ? 'border-status-green bg-status-green text-white' : 'border-input bg-card')}>
                  {r.skip_content && <Check className="h-3 w-3" strokeWidth={3} />}
                </span><span className="text-xs font-semibold lg:hidden">官方发文退出舆情监测</span>
              </button>
              <button onClick={() => removeRow(i)} className="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-status-red/20 text-status-red transition-colors hover:bg-status-red/[0.06] lg:min-h-0 lg:border-0 lg:text-muted-foreground lg:hover:text-status-red"><Trash2 className="h-4 w-4" /><span className="text-xs font-semibold lg:hidden">删除账号</span></button>
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-center">
        <Button className="w-full sm:w-auto" onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存名单</Button>
        <Button className="w-full sm:w-auto" variant="outline" onClick={reclassify} disabled={reclassifying}>{reclassifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}回溯排除历史官方内容</Button>
        {msg && <span className="text-[12.5px] font-medium leading-5 text-status-green">{msg}</span>}
      </div>
    </div>
  )
}
