import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ChevronDown, Loader2, Settings2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { DAILY_API, dailyError, dailyTime, type DailySettings } from './CustomerDailyReport.types'

const inputClass = 'mt-1.5 h-10 w-full rounded-lg border border-border bg-white px-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:bg-slate-50'

export function CustomerDailyReportSettingsSection() {
  const { tenantId, user } = useAuth()
  const canManage = ['platform_admin', 'internal_operator'].includes(user?.globalRole || '')
  return canManage ? <CustomerDailyReportSettingsLoader key={tenantId} /> : null
}

function CustomerDailyReportSettingsLoader() {
  const [settings, setSettings] = useState<DailySettings | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    void api.get<{ settings: DailySettings }>(`${DAILY_API}/settings`).then(data => {
      if (active) { setSettings(data.settings); setError('') }
    }).catch(error => {
      if (active) setError(dailyError(error, '飞书接入配置暂时无法读取。'))
    })
    return () => { active = false }
  }, [reload])
  if (settings) return <CustomerDailyReportSettings settings={settings} canManage onSaved={setSettings} />
  return <section className="rounded-xl border border-slate-200 bg-white p-5"><h3 className="text-sm font-semibold">飞书接入与自动发送</h3>{error ? <div className="mt-3 flex flex-wrap items-center gap-3"><p role="alert" className="text-xs text-amber-800">{error}</p><Button size="sm" variant="outline" onClick={() => setReload(value => value + 1)}>重新读取</Button></div> : <p role="status" className="mt-3 text-xs text-slate-500">正在读取配置…</p>}</section>
}

export function CustomerDailyReportSettings({ settings, canManage, onSaved }: {
  settings: DailySettings
  canManage: boolean
  onSaved: (settings: DailySettings) => void
}) {
  const [form, setForm] = useState(settings)
  const [secrets, setSecrets] = useState({ appSecret: '', webhookUrl: '', webhookSecret: '' })
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null)

  function update<K extends keyof DailySettings>(key: K, value: DailySettings[K]) {
    const affectsAccess = ['appId', 'folderToken', 'documentBaseUrl', 'editorType', 'editorId'].includes(key)
    setForm(current => ({ ...current, [key]: value, ...(affectsAccess ? { customerEditVerified: false } : {}) }))
    setNotice(null)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!canManage || saving) return
    setSaving(true)
    setNotice(null)
    const publicSettings = {
      appId: form.appId, folderToken: form.folderToken, documentBaseUrl: form.documentBaseUrl,
      channel: form.channel, chatId: form.chatId, chatName: form.chatName,
      editorType: form.editorType, editorId: form.editorId, customerEditVerified: form.customerEditVerified,
      autoEnabled: form.autoEnabled, sendTime: form.sendTime,
      collectionBoundaryTime: form.collectionBoundaryTime || '18:00',
    }
    try {
      const data = await api.put<{ settings: DailySettings }>(`${DAILY_API}/settings`, {
        ...publicSettings,
        ...Object.fromEntries(Object.entries(secrets).filter(([, value]) => value.trim())),
      })
      let saved = data.settings
      let executionStateUnavailable = false
      try {
        const fresh = await api.get<{ settings: DailySettings }>(`${DAILY_API}/settings`)
        saved = fresh.settings
      } catch {
        executionStateUnavailable = true
      }
      setSecrets({ appSecret: '', webhookUrl: '', webhookSecret: '' })
      setForm(saved)
      onSaved(saved)
      setNotice({ error: false, message: executionStateUnavailable ? '配置已保存，自动执行状态暂时无法刷新。' : '配置已保存。' })
    } catch (error) {
      setNotice({ error: true, message: dailyError(error, '配置保存失败，请重试。') })
    } finally {
      setSaving(false)
    }
  }

  if (!canManage) return <div className="space-y-3"><p className="text-xs leading-6 text-slate-500">飞书接入与自动发送由管理员配置。当前{settings.autoEnabled ? `每个工作日 ${settings.sendTime} 自动发送当天日报` : '未开启自动发送'}。</p><AutomaticRunStatus settings={settings} /></div>

  return <details className="group rounded-xl border border-slate-200 bg-white">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-sm font-medium text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <Settings2 className="h-4 w-4 text-slate-500" /> 飞书接入与自动发送
      <span className={`ml-auto text-xs font-normal ${settings.lastAutomaticRun?.status === 'needs_attention' ? 'text-rose-700' : 'text-slate-500'}`}>{settings.lastAutomaticRun?.status === 'needs_attention' ? '自动发送需处理' : settings.autoEnabled ? `工作日 ${settings.sendTime}` : '未开启自动发送'}</span>
      <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
    </summary>
    <form onSubmit={save} className="space-y-6 border-t border-slate-200 p-5">
      <AutomaticRunStatus settings={settings} />
      <p className="text-xs leading-6 text-slate-500">可复用已有「文档写入助手」和客户群。配置仅供管理员使用；已保存的密钥不会显示，留空会保留原值。</p>
      <fieldset disabled={saving} className="space-y-3">
        <legend className="mb-3 text-sm font-semibold text-slate-900">日报采集归属</legend>
        <Field label="夜间采集归属切分时间"><input aria-label="夜间采集归属切分时间" className={`${inputClass} !w-32 block`} type="time" value={form.collectionBoundaryTime || '18:00'} required onChange={e => update('collectionBoundaryTime', e.target.value)} /></Field>
        <p className="text-xs leading-6 text-slate-500">此时间之后的新采集计入下一工作日日报；周末和法定节假日合并，调休上班日正常出报。</p>
      </fieldset>
      <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold text-slate-900">文档存放与客户编辑</legend>
        <Field label="应用 ID"><input className={inputClass} value={form.appId} onChange={e => update('appId', e.target.value)} placeholder="已有文档写入助手的应用 ID" autoComplete="off" /></Field>
        <Field label="应用密钥"><input className={inputClass} type="password" value={secrets.appSecret} onChange={e => { setSecrets({ ...secrets, appSecret: e.target.value }); update('customerEditVerified', false) }} placeholder={form.hasAppSecret ? '已配置；留空保留' : '输入应用密钥'} autoComplete="new-password" /></Field>
        <Field label="日报目录标识"><input className={inputClass} value={form.folderToken} onChange={e => update('folderToken', e.target.value)} placeholder="双方约定的专用日报目录" autoComplete="off" /></Field>
        <Field label="飞书文档域名"><input className={inputClass} type="url" value={form.documentBaseUrl} onChange={e => update('documentBaseUrl', e.target.value)} placeholder="https://你的组织.feishu.cn" /></Field>
        <Field label="客户编辑者类型"><select className={inputClass} value={form.editorType} onChange={e => update('editorType', e.target.value as DailySettings['editorType'])}>
          <option value="email">客户邮箱</option><option value="openid">客户成员标识</option><option value="openchat">协作群标识</option>
        </select></Field>
        <Field label={form.editorType === 'email' ? '客户编辑者邮箱' : form.editorType === 'openchat' ? '编辑协作群标识' : '客户编辑者标识'}><input className={inputClass} type={form.editorType === 'email' ? 'email' : 'text'} value={form.editorId} onChange={e => update('editorId', e.target.value)} placeholder="明确授权的客户经办人或协作群" autoComplete="off" /></Field>
      </fieldset>
      <div className="rounded-lg bg-blue-50/70 p-4">
        <label className="flex items-start gap-2.5 text-sm text-slate-800"><input type="checkbox" className="mt-1 accent-blue-600" checked={form.customerEditVerified} disabled={saving} onChange={e => update('customerEditVerified', e.target.checked)} />
          <span>开启自动发送前已用客户账号验证：能修改正文和表格、保存，并按约定下载或留存副本。<small className="mt-1 block text-xs leading-6 text-slate-500">此项用于开启自动发送，手动生成文档或发送无需勾选；系统仍会检查文档编辑权限。首次接入或权限变化时验证一次。</small></span>
        </label>
      </div>
      <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold text-slate-900">发送到现有客户群</legend>
        <Field label="通知方式"><select className={inputClass} value={form.channel} onChange={e => update('channel', e.target.value as DailySettings['channel'])}><option value="app">应用机器人</option><option value="webhook">群自定义机器人（Webhook）</option></select></Field>
        <Field label="目标群名称"><input className={inputClass} value={form.chatName} onChange={e => update('chatName', e.target.value)} placeholder="用于发送前辨认目标群" /></Field>
        {form.channel === 'app' ? <Field label="目标群标识"><input className={inputClass} value={form.chatId} onChange={e => update('chatId', e.target.value)} placeholder="机器人已加入的目标群" autoComplete="off" /></Field> : <>
          <Field label="群机器人地址"><input className={inputClass} type="password" value={secrets.webhookUrl} onChange={e => setSecrets({ ...secrets, webhookUrl: e.target.value })} placeholder={form.hasWebhook ? '已配置；留空保留' : '输入目标群的机器人地址'} autoComplete="new-password" /></Field>
          <Field label="机器人签名密钥"><input className={inputClass} type="password" value={secrets.webhookSecret} onChange={e => setSecrets({ ...secrets, webhookSecret: e.target.value })} placeholder={form.hasWebhookSecret ? '已配置；留空保留' : '按目标群安全设置填写'} autoComplete="new-password" /></Field>
        </>}
      </fieldset>
      <fieldset disabled={saving} className="space-y-3 border-t border-slate-200 pt-5">
        <legend className="sr-only">工作日自动发送</legend>
        <label className="flex items-center gap-2.5 text-sm font-medium text-slate-900"><input type="checkbox" className="accent-blue-600" checked={form.autoEnabled} onChange={e => update('autoEnabled', e.target.checked)} />每个工作日自动发送当天日报</label>
        <label className="flex items-center gap-3 text-sm text-slate-600">北京时间<input aria-label="工作日发送时间（北京时间）" className={`${inputClass} !mt-0 !w-32`} type="time" value={form.sendTime || '09:00'} disabled={!form.autoEnabled} onChange={e => update('sendTime', e.target.value)} /></label>
        {settings.calendarError && <p role="status" className="text-xs leading-6 text-amber-800">{settings.calendarError}</p>}
        <p className="text-xs leading-6 text-slate-500">保存启用后，从下一次发送时间开始，不补发历史日期。关闭页面不影响发送；同日已手动发送的正式日报不会重复发送。关闭自动发送后，尚未开始的自动群发送会停止，手动任务继续执行。</p>
      </fieldset>
      {notice && <p role={notice.error ? 'alert' : 'status'} className={`text-sm ${notice.error ? 'text-rose-700' : 'text-emerald-700'}`}>{notice.message}</p>}
      <Button type="submit" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />}保存配置</Button>
    </form>
  </details>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-xs font-medium text-slate-600">{label}{children}</label>
}

function AutomaticRunStatus({ settings }: { settings: DailySettings }) {
  const run = settings.lastAutomaticRun
  if (!run && !settings.nextRunAt) return null
  const labels = { pending: '等待数据补齐', enqueued: '已入发送队列', needs_attention: '需要处理', canceled: '已取消' }
  return <div className={`rounded-lg border p-3 text-xs leading-6 ${run?.status === 'needs_attention' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-slate-200 bg-slate-50 text-slate-600'}`} aria-label="自动发送执行情况">
    {run && <p>最近自动执行：{run.date} · <span className="font-medium">{labels[run.status]}</span></p>}
    {run?.error && <p role={run.status === 'needs_attention' ? 'alert' : 'status'} className="break-words">{run.error}</p>}
    {settings.autoEnabled && settings.nextRunAt && <p>下次执行：{dailyTime(settings.nextRunAt)}（北京时间）</p>}
  </div>
}
