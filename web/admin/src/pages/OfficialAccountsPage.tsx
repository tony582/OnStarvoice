import { useEffect, useState } from 'react'
import { Loader2, ShieldCheck, Plus, Trash2, Save, History, Check, Info } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { WorkbenchSelect } from '@/components/shared/Workbench'
import { cn } from '@/lib/utils'

type Row = { platform: string; account_name: string; aliasesText: string; account_id: string; skip_content: boolean }

const PLATFORMS = [
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'douyin', label: '抖音' },
  { value: 'weibo', label: '微博' },
]

export function OfficialAccountsPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reclassifying, setReclassifying] = useState(false)
  const [msg, setMsg] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const d = await api.get<any>('/admin/official-accounts')
      setRows((d.accounts || []).map((a: any) => ({
        platform: a.platform || 'xiaohongshu',
        account_name: a.account_name || '',
        aliasesText: (Array.isArray(a.aliases) ? a.aliases : []).join(', '),
        account_id: a.account_id || '',
        skip_content: a.skip_content !== false,
      })))
    } catch (err) { console.error(err) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const update = (i: number, patch: Partial<Row>) => setRows(rs => rs.map((r, j) => j === i ? { ...r, ...patch } : r))
  const addRow = () => setRows(rs => [...rs, { platform: 'xiaohongshu', account_name: '', aliasesText: '', account_id: '', skip_content: true }])
  const removeRow = (i: number) => setRows(rs => rs.filter((_, j) => j !== i))

  const save = async () => {
    setSaving(true); setMsg('')
    try {
      const accounts = rows.filter(r => r.account_name.trim()).map(r => ({
        platform: r.platform,
        accountName: r.account_name.trim(),
        aliases: r.aliasesText.split(',').map(s => s.trim()).filter(Boolean),
        accountId: r.account_id.trim(),
        skipContent: r.skip_content,
      }))
      await api.put('/admin/official-accounts', { accounts })
      setMsg('已保存。新采集的内容会按此名单自动识别。历史内容请点下方「回溯排除」。')
      load()
    } catch (err) { setMsg('保存失败:' + (err instanceof Error ? err.message : '')) } finally { setSaving(false) }
  }

  const reclassify = async () => {
    setReclassifying(true); setMsg('')
    try {
      const d = await api.post<any>('/admin/official-accounts/reclassify')
      setMsg(`回溯完成:已把 ${d.updated} 条历史官方账号内容移出舆情监测。`)
    } catch (err) { setMsg('回溯失败:' + (err instanceof Error ? err.message : '')) } finally { setReclassifying(false) }
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-5 duration-300">
      <div className="flex items-start gap-2.5 rounded-xl border border-status-blue/30 bg-status-blue/[0.05] p-4">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-status-blue" />
        <div className="text-[12.5px] leading-relaxed text-foreground/80">
          在这里登记<strong>官方/自营账号</strong>(如「上海安吉星信息服务有限公司」「安吉星OnStar」及各客服账号)。它们<strong>发的内容</strong>会被标为官方内容、退出舆情监测;它们<strong>回复评论</strong>会被记为「官方已回复」。
          匹配是<strong>精确</strong>的(完整账号名 / 别名 / 账号ID),不会误伤名字里带「安吉星」的路人。
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="inline-flex items-center gap-1.5 text-[13px] font-semibold"><ShieldCheck className="h-4 w-4 text-status-green" />官方账号名单 <span className="text-muted-foreground">({rows.length})</span></h2>
          <Button variant="outline" size="sm" onClick={addRow}><Plus className="h-3.5 w-3.5" />添加账号</Button>
        </div>
        <div className="divide-y divide-border">
          <div className="grid grid-cols-[110px_1fr_1fr_120px_72px_36px] items-center gap-2 bg-muted px-4 py-2 text-[11px] font-medium text-muted-foreground">
            <span>平台</span><span>账号名(精确)</span><span>别名(逗号分隔)</span><span>账号ID(选填)</span><span>退出监测</span><span></span>
          </div>
          {rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">还没有官方账号,点「添加账号」登记第一个(例:上海安吉星信息服务有限公司)</div>
          ) : rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[110px_1fr_1fr_120px_72px_36px] items-center gap-2 px-4 py-2.5">
              <WorkbenchSelect value={r.platform} onChange={e => update(i, { platform: e.target.value })}>
                {PLATFORMS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </WorkbenchSelect>
              <Input value={r.account_name} onChange={e => update(i, { account_name: e.target.value })} placeholder="上海安吉星信息服务有限公司" className="h-8 text-[12px]" />
              <Input value={r.aliasesText} onChange={e => update(i, { aliasesText: e.target.value })} placeholder="安吉星OnStar, 安吉星客服" className="h-8 text-[12px]" />
              <Input value={r.account_id} onChange={e => update(i, { account_id: e.target.value })} placeholder="平台ID" className="h-8 text-[12px]" />
              <button onClick={() => update(i, { skip_content: !r.skip_content })} className="flex justify-center">
                <span className={cn('flex h-[18px] w-[18px] items-center justify-center rounded border transition-colors', r.skip_content ? 'border-status-green bg-status-green text-white' : 'border-input bg-card')}>
                  {r.skip_content && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
              </button>
              <button onClick={() => removeRow(i)} className="flex justify-center text-muted-foreground transition-colors hover:text-status-red"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存名单</Button>
        <Button variant="outline" onClick={reclassify} disabled={reclassifying}>{reclassifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}回溯排除历史官方内容</Button>
        {msg && <span className="text-[12.5px] font-medium text-status-green">{msg}</span>}
      </div>
    </div>
  )
}
