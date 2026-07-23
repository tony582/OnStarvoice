import { useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, Save } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { CloudAgent } from './lib'
import { PLATFORM_LABELS } from './lib'

export function AgentEditor({ agent, onSaved }: { agent: CloudAgent; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [displayName, setDisplayName] = useState(agent.display_name)
  const [hostLabel, setHostLabel] = useState(agent.host_label)
  const [platforms, setPlatforms] = useState<string[]>(agent.allowed_platforms || [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const togglePlatform = (platform: string) => {
    setPlatforms(current => current.includes(platform)
      ? current.filter(item => item !== platform)
      : [...current, platform])
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await api.patch('/capture-cloud/agents/' + agent.id, {
        displayName, hostLabel, allowedPlatforms: platforms, status: agent.status,
      })
      await onSaved()
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-t border-border/60 pt-3">
      <button type="button" onClick={() => setOpen(value => !value)}
        className="flex w-full items-center justify-between text-xs font-semibold text-muted-foreground">
        Agent 配置 {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-medium text-muted-foreground">
            Agent 名称
            <input value={displayName} onChange={event => setDisplayName(event.target.value)}
              className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary" />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            所属设备
            <input value={hostLabel} onChange={event => setHostLabel(event.target.value)}
              className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary" />
          </label>
          <fieldset>
            <legend className="text-xs font-medium text-muted-foreground">负责平台</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {['xiaohongshu', 'douyin', 'weibo'].map(platform => (
                <label key={platform} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs">
                  <input type="checkbox" checked={platforms.includes(platform)} onChange={() => togglePlatform(platform)} />
                  {PLATFORM_LABELS[platform]}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">勾选后，后台只会向该 Agent 恢复对应平台任务；不勾选表示不限制。</p>
          </fieldset>
          {error && <p role="alert" className="text-xs text-status-red">{error}</p>}
          <Button size="sm" className="w-full" onClick={save} disabled={saving || !displayName.trim() || !hostLabel.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} 保存配置
          </Button>
        </div>
      )}
    </div>
  )
}
