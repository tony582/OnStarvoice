import {useRef, useState} from 'react'
import {Plus} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import type {AndroidNode, CreateDiscoveryRun} from './types'

export function CreateMobileRun({nodes, busy, onCreate}: {
  nodes: AndroidNode[]; busy: boolean; onCreate: (body: CreateDiscoveryRun) => Promise<boolean>
}) {
  const [agentId, setAgentId] = useState('')
  const [title, setTitle] = useState('抖音手机发现')
  const [keywords, setKeywords] = useState('别克壁纸\n君越壁纸')
  const [error, setError] = useState('')
  const request = useRef<{key: string; id: string} | null>(null)
  const selected = nodes.find(node => node.id === agentId)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const words = [...new Set(keywords.split(/\n/u).map(value => value.trim()).filter(Boolean))]
    if (!selected || selected.status !== 'active' || words.length < 1 || words.length > 2 || words.some(word => word.length > 80)) {
      setError('请选择可用手机，并填写 1–2 个关键词，每个不超过 80 字。'); return
    }
    const body = {agentId, title: title.trim() || '抖音手机发现', keywords: words,
      filters: {sort: 'comprehensive' as const, range: 'day' as const}}
    const key = JSON.stringify(body)
    if (request.current?.key !== key) request.current = {key, id: crypto.randomUUID()}
    setError('')
    if (await onCreate({...body, requestId: request.current.id})) request.current = null
  }
  return <form onSubmit={event => { void submit(event) }} className="space-y-3 rounded-xl border border-border bg-muted/20 p-4" aria-label="创建手机发现任务">
    <h3 className="text-sm font-semibold">新建手机发现</h3>
    <label className="block space-y-1 text-xs"><span>执行手机</span>
      <select value={agentId} onChange={event => setAgentId(event.target.value)} disabled={busy}
        className="h-10 w-full rounded-lg border border-input bg-card px-3 text-sm">
        <option value="">选择已注册的手机</option>
        {nodes.map(node => <option key={node.id} value={node.id} disabled={node.status !== 'active'}>{node.displayName || node.deviceId}{node.status !== 'active' ? ' · 已停用' : node.readyForSearch ? '' : ' · 等待就绪'}</option>)}
      </select>
    </label>
    <label className="block space-y-1 text-xs"><span>任务名称</span>
      <Input value={title} onChange={event => setTitle(event.target.value)} disabled={busy} maxLength={120}/>
    </label>
    <label className="block space-y-1 text-xs"><span>关键词，每行一个</span>
      <textarea value={keywords} onChange={event => setKeywords(event.target.value)} disabled={busy} rows={2}
        className="w-full resize-y rounded-lg border border-input bg-card p-3 text-sm"/>
    </label>
    <p className="text-xs leading-5 text-muted-foreground">首轮按综合排序、一天内搜索，每词最多 20 个作品。手机尚未就绪时，任务会等待设备。</p>
    {selected?.deviceHeld && <p className="text-xs text-amber-700">手机仍被已有任务占用，新任务会保留在队列中。</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <Button type="submit" size="sm" disabled={busy || !nodes.some(node => node.status === 'active')}><Plus className="h-4 w-4"/>创建任务</Button>
  </form>
}
