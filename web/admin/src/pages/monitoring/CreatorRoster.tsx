import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { platformName } from '@/lib/utils'

type Account = {
  id: string; name: string; platform: string; keyword: string; account_url: string; creator_label?: string
  account_no?: string; match_nicknames?: string[]; status: 'active' | 'paused'
  alert_enabled: boolean; auto_patrol_enabled: boolean; last_run_at?: string; latest_result?: string; last_error?: string
}
const blank = { id: '', creatorLabel: '', name: '', platform: 'douyin', url: '', accountNo: '', finderId: '', aliases: '',
  status: 'active', alertEnabled: true, autoPatrolEnabled: false }
type Preview = { counts: { create: number; update: number; error: number }; rows: Array<{ line: number; action: string; name?: string; message?: string; platform?: string }> }
const results: Record<string,string> = { succeeded: '成功', failed: '失败', pending: '待执行', running: '执行中', cancelled: '已取消' }
const endpoint = '/monitor/followed-creators'

export function CreatorRoster({ onScan, onViewHits }: { onScan: (id: string) => void; onViewHits?: (id: string) => void }) {
  const { tenantId, canWrite } = useAuth()
  const [accounts,setAccounts] = useState<Account[]>([])
  const [canManage,setCanManage] = useState(false)
  const [edit,setEdit] = useState<typeof blank | null>(null)
  const [importText,setImportText] = useState<string | null>(null)
  const [preview,setPreview] = useState<Preview | null>(null)
  const [message,setMessage] = useState('')
  const [busy,setBusy] = useState(false)
  const [loading,setLoading] = useState(true)
  const [revision,setRevision] = useState(0)
  useEffect(()=>{
    let active=true
    void api.get<{accounts:Account[];canManage:boolean}>(endpoint)
      .then(data=>{if(active){setAccounts(data.accounts);setCanManage(data.canManage)}})
      .catch(error=>{if(active)setMessage(error.message)})
      .finally(()=>{if(active)setLoading(false)})
    return ()=>{active=false}
  },[tenantId,revision])

  async function act(run:()=>Promise<void>) {
    setBusy(true)
    setMessage('')
    try { await run() } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败') }
    finally {setBusy(false)}
  }
  function open(account: Account) {
    setEdit({id:account.id,creatorLabel:account.creator_label || account.name,name:account.name,
      platform:account.platform,url:account.account_url,accountNo:account.account_no || '',
      finderId:account.keyword,aliases:account.match_nicknames?.slice(1).join('，') || '',
      status:account.status,alertEnabled:account.alert_enabled,autoPatrolEnabled:account.auto_patrol_enabled})
  }
  const groups = new Map<string, Account[]>()
  for (const account of accounts) {
    const label = account.creator_label || account.name
    const group = groups.get(label) || []
    group.push(account)
    groups.set(label, group)
  }

  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground">暂停会停止提醒和自动巡查，仍可手动扫描。提醒和自动巡查分别设置。</p>
      {canManage && <div className="flex gap-2">
        <Button onClick={()=>{setEdit({...blank});setImportText(null)}}>新增账号</Button>
        <Button variant="outline" onClick={()=>{setEdit(null);setPreview(null);setImportText('')}}>批量导入</Button>
      </div>}
    </div>
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    {edit && <form className="space-y-3 rounded-xl border bg-card p-4" onSubmit={event=>{
      event.preventDefault()
      void act(async()=>{await api.put(endpoint+'/account',edit);setEdit(null);setRevision(v=>v+1)})
    }}>
      <h3 className="font-semibold">{edit.id?'编辑账号':'新增账号'}</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">博主名称<Input required value={edit.creatorLabel} onChange={e=>setEdit({...edit,creatorLabel:e.target.value})}/></label>
        <label className="text-sm">平台<select className="ml-2 rounded border bg-background p-2" value={edit.platform} onChange={e=>setEdit({...edit,platform:e.target.value})}>
          <option value="douyin">抖音</option><option value="wechat_channels">视频号</option>
          <option value="xiaohongshu">小红书</option><option value="weibo">微博</option>
        </select></label>
        <label className="text-sm">平台昵称<Input value={edit.name} onChange={e=>setEdit({...edit,name:e.target.value})}/></label>
        {edit.platform==='wechat_channels' ? <>
          <label className="text-sm">视频号 ID（选填）<Input value={edit.finderId} onChange={e=>setEdit({...edit,finderId:e.target.value})}/></label>
          <label className="text-sm">别名（逗号分隔）<Input value={edit.aliases} onChange={e=>setEdit({...edit,aliases:e.target.value})}/></label>
        </> : <>
          <label className="text-sm">主页链接<Input type="url" required value={edit.url} onChange={e=>setEdit({...edit,url:e.target.value})}/></label>
          {edit.platform==='douyin' && <label className="text-sm">抖音号（选填）<Input value={edit.accountNo} onChange={e=>setEdit({...edit,accountNo:e.target.value})}/></label>}
        </>}
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label><input type="checkbox" checked={edit.status==='active'} onChange={e=>setEdit({...edit,status:e.target.checked?'active':'paused'})}/> 在名单中</label>
        <label><input type="checkbox" checked={edit.alertEnabled} onChange={e=>setEdit({...edit,alertEnabled:e.target.checked})}/> 飞书提醒</label>
        <label className={edit.platform==='wechat_channels'?'text-muted-foreground':''}><input type="checkbox" disabled={edit.platform==='wechat_channels'} checked={edit.platform!=='wechat_channels' && edit.autoPatrolEnabled} onChange={e=>setEdit({...edit,autoPatrolEnabled:e.target.checked})}/> {edit.platform==='wechat_channels'?'暂不支持巡查':'自动巡查'}</label>
      </div>
      <div className="flex gap-2"><Button type="submit" disabled={busy}>保存</Button><Button type="button" variant="outline" onClick={()=>setEdit(null)}>取消</Button></div>
    </form>}
    {importText!==null && <div className="space-y-3 rounded-xl border bg-card p-4">
      <label className="block text-sm font-semibold" htmlFor="creator-roster-import">粘贴带表头的 Excel 名单</label>
      <textarea id="creator-roster-import" className="w-full rounded border bg-background p-2 text-sm" rows={5} value={importText} onChange={e=>{setImportText(e.target.value);setPreview(null)}} />
      {preview && <div className="space-y-1 text-sm">
        <p>新增 {preview.counts.create} 个 · 更新 {preview.counts.update} 个 · 解析失败 {preview.counts.error} 个</p>
        <ul className="max-h-48 overflow-auto">{preview.rows.map((r,i)=><li key={i}>第 {r.line} 行 · {r.message || `${r.action==='create'?'新增':'更新'} ${r.name}（${platformName(r.platform || '')}）`}</li>)}</ul>
      </div>}
      <div className="flex gap-2">
        <Button variant="outline" disabled={busy || !importText.trim()} onClick={()=>void act(async()=>setPreview(await api.post<Preview>(endpoint+'/import',{text:importText})))}>预览</Button>
        <Button disabled={busy || !preview || preview.counts.create+preview.counts.update===0} onClick={()=>void act(async()=>{
          const data=await api.post<Preview>(endpoint+'/import',{text:importText,commit:true})
          setMessage(`新增 ${data.counts.create} 个，更新 ${data.counts.update} 个，跳过 ${data.counts.error} 个。`)
          setImportText(null);setPreview(null);setRevision(v=>v+1)
        })}>确认导入</Button>
        <Button variant="outline" onClick={()=>setImportText(null)}>关闭</Button>
      </div>
    </div>}
    {loading && <p className="text-sm text-muted-foreground">正在读取关注博主…</p>}
    {!loading && !accounts.length && <p className="rounded-xl border p-6 text-sm text-muted-foreground">暂无关注博主</p>}
    {Array.from(groups).map(([label,members])=><article key={label} className="rounded-xl border bg-card">
      <h3 className="border-b px-4 py-2 text-sm font-semibold">{label}</h3>
      {members?.map(a=><div key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
        <div className="min-w-52"><b>{platformName(a.platform)} · {a.name}</b><p className="text-xs text-muted-foreground">
          {a.status==='active'?'已启用':'已暂停'} · 提醒{a.alert_enabled?'开':'关'} · {a.platform==='wechat_channels'?'暂不支持巡查':`自动巡查${a.auto_patrol_enabled?'开':'关'}`}
        </p></div>
        <div className="text-xs text-muted-foreground">{a.last_run_at ? new Date(a.last_run_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '暂无巡查时间'} · {results[a.latest_result || ''] || '暂无结果'}{a.last_error && <p>{a.last_error}</p>}</div>
        <div className="flex flex-wrap gap-1">
          {onViewHits && <Button size="sm" variant="ghost" onClick={()=>onViewHits(a.id)}>命中</Button>}
          {a.platform!=='wechat_channels' && <Button size="sm" variant="outline" disabled={!canWrite()} onClick={()=>onScan(a.id)}>分配扫描</Button>}
          {canManage && <><Button variant="ghost" size="sm" onClick={()=>open(a)}>编辑</Button><Button variant="ghost" size="sm" disabled={busy} onClick={()=>{
            if(window.confirm(`删除「${a.name}」的${platformName(a.platform)}账号？`)) void act(async()=>{await api.delete(endpoint+'/'+a.id);setRevision(v=>v+1)})
          }}>删除</Button></>}
        </div>
      </div>)}
    </article>)}
  </section>
}
