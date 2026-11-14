import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const endpoint = '/monitor/followed-creator-alert-settings'
type Config = {enabled:boolean; channel:string; chatId:string; configured:boolean; alerts:Array<{id:string;title:string;status:string;last_error:string;created_at:string}>}
const statuses:Record<string,string>={pending:'待发送',sending:'发送中',sent:'已发送',ambiguous:'结果待核实',failed:'发送失败',cancelled:'已取消'}

export function CreatorAlertSettings() {
  const { tenantId }=useAuth()
  return <Settings key={tenantId} />
}
function Settings() {
  const [config,setConfig]=useState<Config|null>(null)
  const [url,setUrl]=useState('')
  const [secret,setSecret]=useState('')
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  useEffect(()=>{
    let active=true
    void api.get<Config>(endpoint).then(data=>{if (active) setConfig(data)})
      .catch(error=>{if (active) setMessage(error.message)})
    return ()=>{active=false}
  },[])
  async function act(run:()=>Promise<void>, notice:string) {
    setBusy(true);setMessage('')
    try {await run();setConfig(await api.get<Config>(endpoint));setMessage(notice)}
    catch(error){setMessage(error instanceof Error?error.message:'操作失败')}
    finally{setBusy(false)}
  }
  return <section className="space-y-3 rounded-xl border bg-card p-4">
    <h3 className="text-base font-semibold">关注博主提醒</h3>
    {config && <>
      <label className="block text-sm"><input type="checkbox" checked={config.enabled} onChange={e=>setConfig({...config,enabled:e.target.checked})}/> 启用飞书提醒</label>
      <label className="block text-sm">发送目标 <select className="rounded border bg-background p-2" value={config.channel} onChange={e=>setConfig({...config,channel:e.target.value})}>
        <option value="daily">和客户日报同一个飞书群</option><option value="app">另一个群 · 应用消息</option><option value="webhook">另一个群 · Webhook</option>
      </select></label>
      {config.channel==='app' && <Input aria-label="飞书群 chat_id" placeholder="飞书群 chat_id" value={config.chatId} onChange={e=>setConfig({...config,chatId:e.target.value})}/>}
      {config.channel==='webhook' && <>
        <Input type="password" aria-label="Webhook 地址" placeholder="Webhook 地址（留空沿用已保存值）" value={url} onChange={e=>setUrl(e.target.value)}/>
        <Input type="password" aria-label="Webhook 签名密钥" placeholder="签名密钥（留空沿用已保存值）" value={secret} onChange={e=>setSecret(e.target.value)}/>
      </>}
      {!config.configured && <p className="text-sm text-muted-foreground">请先配置日报飞书，或另填一个群。</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={()=>void act(async()=>{
          await api.put(endpoint,{enabled:config.enabled,channel:config.channel,chatId:config.chatId,webhookUrl:url,webhookSecret:secret})
          setUrl('');setSecret('')
        },'已保存')}>保存设置</Button>
        <Button variant="outline" disabled={busy || !config.configured} onClick={()=>void act(async()=>{await api.post(endpoint+'/test')},'测试消息已排队，可刷新查看发送状态')}>发送测试消息</Button>
        <Button variant="ghost" disabled={busy} onClick={()=>void act(async()=>{},'已刷新')}>刷新状态</Button>
      </div>
      <div className="space-y-1 text-xs">
        <h4 className="font-semibold">最近 20 条提醒</h4>
        {!config.alerts.length && <p className="text-muted-foreground">暂无发送记录</p>}
        {config.alerts.map(a=><p key={a.id} className="border-t py-1">{new Date(a.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · {statuses[a.status] || a.status} · {a.title}{a.last_error && ` · ${a.last_error}`}</p>)}
      </div>
    </>}
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
  </section>
}
