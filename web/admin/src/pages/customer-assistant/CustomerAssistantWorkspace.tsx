import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Bot, Check, ChevronDown, CircleHelp, FlaskConical, History, Loader2, Mail, MessageSquare, Plus, RefreshCw, Save, Send, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  EMPTY_ASSISTANT_SETTINGS,
  type AssistantActivity, type AssistantGroup, type AssistantMember, type AssistantSecrets,
  type AssistantService, type AssistantSettings, type AssistantSettingsInput,
} from '@/lib/customer-assistant'

const inputClass = 'mt-1.5 h-10 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/25 disabled:bg-muted disabled:text-muted-foreground'
const emptySecrets: AssistantSecrets = { appSecret: '', verificationToken: '', encryptKey: '' }
const suggestions = ['今天有多少负面？', '今天的日报给我一份', '把今天的日报发我邮箱']
type Tab = 'chat' | 'settings' | 'activity'
type Notice = { error: boolean; message: string }
type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; toolResults?: unknown[]; error?: boolean; emailPreview?: boolean }

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function normalized(settings: AssistantSettings): AssistantSettings {
  return {
    ...EMPTY_ASSISTANT_SETTINGS, ...settings,
    groups: (settings.groups || []).map(group => ({ chatId: group.chatId || '', name: group.name || '' })),
    members: (settings.members || []).map(member => ({ chatId: member.chatId || '', openId: member.openId || '', name: member.name || '', email: member.email || '', canEmail: member.canEmail === true })),
  }
}

export function CustomerAssistantWorkspace({ service, tenantName, demo = false }: {
  service: AssistantService; tenantName?: string; demo?: boolean
}) {
  const [settings, setSettings] = useState<AssistantSettings | null>(null)
  const [callbackPath, setCallbackPath] = useState('')
  const [tab, setTab] = useState<Tab>('chat')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    void service.settings().then(data => {
      if (!active) return
      if (!data.settings) throw new Error('客户助手配置未返回，请重新读取。')
      setSettings(normalized(data.settings))
      setCallbackPath(data.callbackPath || '')
      setError('')
    }).catch(error => { if (active) setError(errorMessage(error, '客户助手配置暂时无法读取。')) })
    return () => { active = false }
  }, [service, reload])

  return <div className="mx-auto max-w-[1280px] space-y-5 pb-4">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2.5"><Bot className="h-5 w-5 text-primary" /><h1 className="text-xl font-semibold tracking-tight">客户助手</h1></div>
        <p className="mt-2 text-sm text-muted-foreground">让客户在飞书群里查日报、问舆情、获取邮件。{tenantName && <span className="ml-2">当前租户：{tenantName}</span>}</p>
      </div>
      {settings && <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium', settings.enabled && settings.mode === 'live' ? 'border-success/25 bg-success/5 text-success' : 'border-border bg-muted/60 text-muted-foreground')}><span className={cn('h-1.5 w-1.5 rounded-full', settings.enabled && settings.mode === 'live' ? 'bg-success' : 'bg-muted-foreground')} />{settings.enabled ? settings.mode === 'live' ? '已启用 · 正式回复' : '已启用 · 仅预览' : '未启用'}</span>}
    </header>
    {demo && <div role="status" className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning"><FlaskConical className="mt-0.5 h-4 w-4 shrink-0" /><p><strong className="font-semibold">演示数据</strong> · 此页面使用模拟群、成员和回复，未连接后台；保存只在当前页面有效，不会发送消息或邮件。</p></div>}
    {!settings ? <section className="rounded-xl border border-border bg-card p-6">{error ? <><p role="alert" className="text-sm text-destructive">{error}</p><Button variant="outline" size="sm" className="mt-4" onClick={() => { setError(''); setReload(value => value + 1) }}>重新读取</Button></> : <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取客户助手配置…</p>}</section> : <>
      <div role="tablist" aria-label="客户助手功能" className="flex gap-0 border-b border-border sm:gap-1">
        {([{ id: 'chat', label: '聊天试用', icon: MessageSquare }, { id: 'settings', label: '接入设置', icon: Settings2 }, { id: 'activity', label: '最近消息', icon: History }] as const).map(item => <button key={item.id} type="button" role="tab" id={`assistant-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`assistant-panel-${item.id}`} onClick={() => setTab(item.id)} className={cn('flex items-center gap-1.5 border-b-2 px-2.5 pb-3 pt-2 text-xs outline-none sm:gap-2 sm:px-4 sm:text-sm transition-colors focus-visible:ring-2 focus-visible:ring-primary', tab === item.id ? 'border-primary font-semibold text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}><item.icon className="h-4 w-4" />{item.label}</button>)}
      </div>
      <div role="tabpanel" id="assistant-panel-chat" aria-labelledby="assistant-tab-chat" hidden={tab !== 'chat'}><AssistantChat key={JSON.stringify([settings.groups, settings.members])} settings={settings} service={service} demo={demo} onConfigure={() => setTab('settings')} /></div>
      <div role="tabpanel" id="assistant-panel-settings" aria-labelledby="assistant-tab-settings" hidden={tab !== 'settings'}><AssistantConfiguration settings={settings} callbackPath={callbackPath} service={service} demo={demo} onSaved={(value, path) => { setSettings(normalized(value)); if (path) setCallbackPath(path) }} /></div>
      <div role="tabpanel" id="assistant-panel-activity" aria-labelledby="assistant-tab-activity" hidden={tab !== 'activity'}>{tab === 'activity' && <AssistantActivityList service={service} demo={demo} />}</div>
    </>}
  </div>
}

function AssistantChat({ settings, service, demo, onConfigure }: { settings: AssistantSettings; service: AssistantService; demo: boolean; onConfigure: () => void }) {
  const eligibleMembers = settings.members.filter(member => settings.groups.some(group => group.chatId === member.chatId))
  const [memberKey, setMemberKey] = useState(eligibleMembers[0] ? JSON.stringify([eligibleMembers[0].chatId, eligibleMembers[0].openId]) : '')
  const member = eligibleMembers.find(item => JSON.stringify([item.chatId, item.openId]) === memberKey)
  const group = settings.groups.find(item => item.chatId === member?.chatId)
  const [text, setText] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string>()
  const [sending, setSending] = useState(false)
  const messageEnd = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { if (messages.length) messageEnd.current?.scrollIntoView({ block: 'nearest' }) }, [messages, sending])

  function resetConversation() {
    setMessages([]); setSessionId(undefined); setText('')
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    if (sending || !member || !text.trim()) return
    const question = text.trim()
    const id = `${Date.now()}-${messages.length}`
    setMessages(current => [...current, { id, role: 'user', text: question }])
    setText(''); setSending(true)
    try {
      const result = await service.preview({ text: question, chatId: member.chatId, senderId: member.openId, ...(sessionId ? { sessionId } : {}) })
      setSessionId(result.sessionId)
      const toolResults = Array.isArray(result.toolResults) ? result.toolResults : []
      const emailPreview = /邮件|邮箱|email|mail/i.test(question) || toolResults.some(item => /email|mail/i.test(String(item && typeof item === 'object' ? (item as Record<string, unknown>).name || (item as Record<string, unknown>).tool || '' : '')))
      setMessages(current => [...current, { id: `${id}-reply`, role: 'assistant', text: result.reply || '本次预览未返回回复内容。', toolResults, emailPreview }])
    } catch (error) {
      setMessages(current => [...current, { id: `${id}-error`, role: 'assistant', text: errorMessage(error, '本次试用失败，请稍后重试。'), error: true }])
      setText(question)
    } finally {
      setSending(false)
      input.current?.focus()
    }
  }

  return <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
    <section aria-label="客户助手聊天试用" className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-end gap-3 border-b border-border bg-muted/25 px-5 py-4">
        <label className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">模拟客户身份<select aria-label="模拟客户身份" className={`${inputClass} !mt-2`} disabled={!eligibleMembers.length || sending} value={memberKey} onChange={event => { setMemberKey(event.target.value); resetConversation() }}><option value="" disabled>请先在接入设置中绑定群和成员</option>{eligibleMembers.map(item => <option key={JSON.stringify([item.chatId, item.openId])} value={JSON.stringify([item.chatId, item.openId])}>{item.name || item.openId} · {settings.groups.find(group => group.chatId === item.chatId)?.name || item.chatId}</option>)}</select></label>
        <Button variant="ghost" size="sm" disabled={sending || !messages.length} onClick={resetConversation}><RefreshCw className="h-3.5 w-3.5" />新会话</Button>
      </div>
      <div className="flex items-center gap-2 border-b border-border px-5 py-2.5 text-xs text-muted-foreground"><FlaskConical className="h-3.5 w-3.5 text-primary" /><span>仅预览 · 不向群聊或邮箱发送{demo ? ' · 模拟回复' : ''}</span></div>
      <div role="log" aria-live="polite" aria-label="试用对话" aria-busy={sending} className="h-[clamp(240px,36dvh,380px)] space-y-5 overflow-y-auto overscroll-contain px-4 py-6 sm:px-5">
        {!messages.length && <div className="flex h-full flex-col items-center justify-center px-2 pb-5 text-center"><div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-primary"><Bot className="h-6 w-6" /></div><h2 className="text-base font-semibold">从客户的一句话开始</h2><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{member ? '选择一个问题，查看助手如何查询数据和准备回复。你可以接着追问。' : '先添加客户群和授权成员，再以该成员的身份试用。'}</p>{!member && <Button variant="outline" size="sm" className="mt-5" onClick={onConfigure}><Plus className="h-3.5 w-3.5" />配置群与成员</Button>}</div>}
        {messages.map(message => <div key={message.id} className={cn('flex gap-2.5', message.role === 'user' && 'justify-end')}>
          {message.role === 'assistant' && <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-primary"><Bot className="h-4 w-4" /></div>}
          <div className={cn('min-w-0 max-w-[90%] rounded-xl px-4 py-3 text-sm leading-7 sm:max-w-[85%]', message.role === 'user' ? 'rounded-tr-sm bg-primary text-primary-foreground' : message.error ? 'rounded-tl-sm border border-destructive/20 bg-destructive/5 text-destructive' : 'rounded-tl-sm border border-border bg-muted/35')}>
            {message.emailPreview && <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-primary"><Mail className="h-3.5 w-3.5" />邮件预览，未发送</div>}
            <div className="whitespace-pre-wrap break-words"><ReplyText text={message.text} /></div>
            {!!message.toolResults?.length && <ToolResults results={message.toolResults} />}
          </div>
        </div>)}
        {sending && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在查询并生成预览…</div>}
        {(!!messages.length || sending) && <div ref={messageEnd} />}
      </div>
      <form onSubmit={send} className="space-y-3 border-t border-border p-4 sm:p-5">
        <div className="flex flex-wrap gap-2">{suggestions.map(question => <button key={question} type="button" disabled={!member || sending} onClick={() => { setText(question); input.current?.focus() }} className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground outline-none transition-colors hover:border-primary/30 hover:text-primary focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">{question}</button>)}</div>
        <textarea ref={input} aria-label="试用消息" placeholder={member ? '输入客户的问题，支持继续追问…' : '请先配置群与授权成员'} value={text} onChange={event => setText(event.target.value)} disabled={!member || sending} rows={3} maxLength={4000} className={`${inputClass} !mt-0 !h-auto resize-y py-2.5 leading-6`} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">使用已保存的群与成员权限 · ⌘ / Ctrl + Enter 试用</span><Button type="submit" className="ml-auto" disabled={!member || !text.trim() || sending}>{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}生成预览</Button></div>
      </form>
    </section>
    <aside className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-5"><h2 className="flex items-center gap-2 text-sm font-semibold"><CircleHelp className="h-4 w-4 text-muted-foreground" />这次试用会做什么</h2><ul className="mt-4 space-y-4 text-sm leading-6 text-muted-foreground"><li><strong className="block font-medium text-foreground">查询负面数量</strong>{demo ? '展示模拟数量、统计范围和截止时间。' : '从当前租户的数据查询，回复统计范围和截止时间。'}</li><li><strong className="block font-medium text-foreground">获取客户日报</strong>查看对应日期的日报与访问入口。</li><li><strong className="block font-medium text-foreground">准备日报邮件</strong>检查成员的邮箱授权，生成邮件预览。</li></ul></section>
      <section className="rounded-xl border border-border bg-muted/30 p-5"><h2 className="text-xs font-semibold text-muted-foreground">当前模拟身份</h2>{member ? <dl className="mt-3 space-y-3 text-sm"><div><dt className="text-xs text-muted-foreground">客户群</dt><dd className="mt-1 break-words">{group?.name || group?.chatId}</dd></div><div><dt className="text-xs text-muted-foreground">成员</dt><dd className="mt-1 break-words">{member.name || member.openId}</dd></div><div><dt className="text-xs text-muted-foreground">邮件权限</dt><dd className="mt-1">{member.canEmail ? '允许发送到绑定邮箱' : '未授予邮件发送权限'}</dd></div></dl> : <p className="mt-3 text-sm leading-6 text-muted-foreground">尚未绑定可试用的成员。</p>}<p className="mt-4 border-t border-border pt-3 text-xs leading-6 text-muted-foreground">更换成员或新建会话会清空当前对话。正式回复模式也不会改变此处的预览行为。</p></section>
    </aside>
  </div>
}

function AssistantConfiguration({ settings, callbackPath, service, demo, onSaved }: {
  settings: AssistantSettings; callbackPath: string; service: AssistantService; demo: boolean
  onSaved: (settings: AssistantSettings, callbackPath?: string) => void
}) {
  const [form, setForm] = useState(settings)
  const [secrets, setSecrets] = useState<AssistantSecrets>(emptySecrets)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dirty, setDirty] = useState(false)
  const callbackUrl = callbackPath ? new URL(callbackPath, window.location.origin).toString() : ''

  function update<K extends keyof AssistantSettings>(key: K, value: AssistantSettings[K]) {
    setForm(current => ({ ...current, [key]: value })); setDirty(true); setNotice(null)
  }
  function updateSecret(key: keyof AssistantSecrets, value: string) {
    setSecrets(current => ({ ...current, [key]: value })); setDirty(true); setNotice(null)
  }
  function updateGroup(index: number, patch: Partial<AssistantGroup>) {
    update('groups', form.groups.map((group, i) => i === index ? { ...group, ...patch } : group))
  }
  function updateMember(index: number, patch: Partial<AssistantMember>) {
    update('members', form.members.map((member, i) => i === index ? { ...member, ...patch } : member))
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    const groups = form.groups.map(group => ({ chatId: group.chatId.trim(), name: group.name.trim() }))
    const members = form.members.map(member => ({ ...member, chatId: member.chatId.trim(), openId: member.openId.trim(), name: member.name.trim(), email: member.email.trim() }))
    let validation = ''
    if (groups.some(group => !group.chatId)) validation = '请填写每个客户群的群标识。'
    else if (new Set(groups.map(group => group.chatId)).size !== groups.length) validation = '客户群标识不能重复。'
    else if (members.some(member => !member.openId || !groups.some(group => group.chatId === member.chatId))) validation = '请为每位成员选择已绑定的群，并填写成员标识。'
    else if (new Set(members.map(member => JSON.stringify([member.chatId, member.openId]))).size !== members.length) validation = '同一个群内不能重复绑定同一位成员。'
    else if (members.some(member => (member.canEmail && !member.email) || (member.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email)))) validation = '请填写有效的成员邮箱；允许邮件发送的成员必须绑定邮箱。'
    else if (form.enabled && (!groups.length || !members.length)) validation = '启用前请至少绑定一个客户群和一位授权成员。'
    else if (form.enabled && (!form.botOpenId.trim() || (!form.hasVerificationToken && !secrets.verificationToken.trim()) || (!form.hasEncryptKey && !secrets.encryptKey.trim()))) validation = '启用前请填写机器人身份、事件校验令牌和事件加密密钥。'
    else if (form.enabled && !form.useDailyApp && (!form.appId.trim() || (!form.hasAppSecret && !secrets.appSecret.trim()))) validation = '启用前请填写飞书应用 ID 和应用密钥，或选择复用日报交付应用。'
    if (validation) { setNotice({ error: true, message: validation }); return }
    setSaving(true); setNotice(null)
    const payload: AssistantSettingsInput = {
      enabled: form.enabled, mode: form.mode, useDailyApp: form.useDailyApp,
      appId: form.appId.trim(), botOpenId: form.botOpenId.trim(), groups, members,
      ...Object.fromEntries(Object.entries(secrets).filter(([key, value]) => value.trim() && (key !== 'appSecret' || !form.useDailyApp))),
    }
    try {
      const result = await service.save(payload)
      if (!result.settings) throw new Error('保存结果未返回配置，请重新读取后核对。')
      let saved = result
      let refreshed = true
      try { saved = await service.settings() } catch { refreshed = false }
      setSecrets(emptySecrets); setForm(normalized(saved.settings)); setDirty(false)
      setNotice({ error: false, message: demo ? '演示配置已保存到当前页面，刷新后恢复；未发送消息或邮件。' : refreshed ? '配置已保存。保存操作不会发送消息或邮件。' : '配置已保存，重新读取暂时失败，请稍后核对。' })
      onSaved(saved.settings, saved.callbackPath)
    } catch (error) { setNotice({ error: true, message: errorMessage(error, '配置保存失败，请重试。') }) }
    finally { setSaving(false) }
  }

  return <form onSubmit={save} className="space-y-5">
    <fieldset disabled={saving} className="space-y-5">
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">运行方式</h2><p className="mt-1.5 text-xs leading-6 text-muted-foreground">默认关闭。只响应已绑定群内的授权成员，修改后点击保存生效。</p></div><label className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm font-medium"><input type="checkbox" checked={form.enabled} onChange={event => update('enabled', event.target.checked)} className="h-4 w-4 accent-primary" />启用客户助手</label></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">{([{ mode: 'preview', title: '仅预览', description: '接收请求并生成预览，不向群聊或邮箱发送。' }, { mode: 'live', title: '正式回复', description: '按已保存的群、成员和邮件权限处理客户请求。' }] as const).map(item => <label key={item.mode} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-4', form.mode === item.mode ? 'border-primary/40 bg-accent/50' : 'border-border')}><input type="radio" name="assistant-mode" value={item.mode} checked={form.mode === item.mode} onChange={() => update('mode', item.mode)} className="mt-0.5 h-4 w-4 accent-primary" /><span><strong className="block text-sm font-medium">{item.title}</strong><span className="mt-1 block text-xs leading-6 text-muted-foreground">{item.description}</span></span></label>)}</div>
        {!form.enabled && <p className="mt-3 text-xs leading-6 text-muted-foreground">未启用时不处理飞书群请求，仍可在“聊天试用”中预览。</p>}
      </section>
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">飞书应用接入</h2>
        <label className="mt-4 flex items-center gap-2.5 text-sm"><input type="checkbox" checked={form.useDailyApp} onChange={event => update('useDailyApp', event.target.checked)} className="h-4 w-4 accent-primary" />复用日报交付应用</label>
        <p className="mt-2 text-xs leading-6 text-muted-foreground">复用日报设置中的应用 ID 和密钥；机器人身份及事件接收配置仍需填写。</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="应用 ID（App ID）"><input className={inputClass} value={form.appId} disabled={form.useDailyApp} onChange={event => update('appId', event.target.value)} placeholder={form.useDailyApp ? '使用日报交付应用' : 'cli_…'} autoComplete="off" /></Field>
          <Field label="应用密钥（App Secret）"><input type="password" className={inputClass} value={secrets.appSecret} disabled={form.useDailyApp} onChange={event => updateSecret('appSecret', event.target.value)} placeholder={form.useDailyApp ? '使用日报应用的已保存密钥' : form.hasAppSecret ? '已配置；留空保留' : '填写应用密钥'} autoComplete="new-password" /></Field>
          <Field label="机器人身份（Bot Open ID）"><input className={inputClass} value={form.botOpenId} onChange={event => update('botOpenId', event.target.value)} placeholder="ou_…" autoComplete="off" /></Field>
          <Field label="事件校验令牌（Verification Token）"><input type="password" className={inputClass} value={secrets.verificationToken} onChange={event => updateSecret('verificationToken', event.target.value)} placeholder={form.hasVerificationToken ? '已配置；留空保留' : '填写飞书事件校验令牌'} autoComplete="new-password" /></Field>
          <Field label="事件加密密钥（Encrypt Key）"><input type="password" className={inputClass} value={secrets.encryptKey} onChange={event => updateSecret('encryptKey', event.target.value)} placeholder={form.hasEncryptKey ? '已配置；留空保留' : '启用客户助手前填写'} autoComplete="new-password" /></Field>
          <Field label="事件接收地址"><input className={`${inputClass} font-mono !text-xs`} value={callbackUrl} readOnly placeholder="保存接入配置后由后台返回" onFocus={event => event.target.select()} /><span className="mt-1.5 block text-xs font-normal leading-5 text-muted-foreground">在部署后的地址配置飞书事件订阅；本地地址用于联调。</span></Field>
        </div>
        <p className="mt-4 text-xs leading-6 text-muted-foreground">已保存的密钥不会回显，留空保留原值。启用前需配置事件校验令牌和加密密钥；应用需开启机器人能力、加入客户群并订阅 @机器人消息。</p>
      </section>
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">授权客户群</h2><p className="mt-1.5 text-xs leading-6 text-muted-foreground">填写飞书群标识，将群关联到当前租户。</p></div><Button type="button" variant="outline" size="sm" onClick={() => update('groups', [...form.groups, { chatId: '', name: '' }])}><Plus className="h-3.5 w-3.5" />添加群</Button></div>
        {!form.groups.length && <p className="mt-4 rounded-lg bg-muted/35 px-4 py-4 text-sm text-muted-foreground">尚未绑定客户群。添加群后，再配置可使用助手的成员。</p>}
        <div className="mt-4 space-y-3">{form.groups.map((group, index) => <div key={index} className="grid items-end gap-3 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto]"><Field label={`群名称 ${index + 1}`}><input className={inputClass} value={group.name} onChange={event => updateGroup(index, { name: event.target.value })} placeholder="例如：客户舆情服务群" /></Field><Field label={`群标识 ${index + 1}`}><input className={inputClass} value={group.chatId} onChange={event => updateGroup(index, { chatId: event.target.value })} placeholder="oc_…" autoComplete="off" /></Field><Button type="button" variant="ghost" size="icon" aria-label={`移除客户群 ${index + 1}`} title={form.members.some(member => member.chatId === group.chatId) ? '请先移除此群的成员绑定' : '移除客户群'} disabled={form.members.some(member => member.chatId === group.chatId)} onClick={() => update('groups', form.groups.filter((_, i) => i !== index))}><Trash2 className="h-4 w-4" /></Button></div>)}</div>
      </section>
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">授权成员与邮箱</h2><p className="mt-1.5 text-xs leading-6 text-muted-foreground">每位成员按所在群单独绑定。邮件只发送到该成员已绑定的邮箱。</p></div><Button type="button" variant="outline" size="sm" disabled={!form.groups.some(group => group.chatId.trim())} onClick={() => update('members', [...form.members, { chatId: form.groups.find(group => group.chatId.trim())?.chatId || '', openId: '', name: '', email: '', canEmail: false }])}><Plus className="h-3.5 w-3.5" />添加成员</Button></div>
        {!form.members.length && <p className="mt-4 rounded-lg bg-muted/35 px-4 py-4 text-sm text-muted-foreground">尚未授权成员。新成员默认不允许发送邮件。</p>}
        <div className="mt-4 space-y-4">{form.members.map((member, index) => <div key={index} className="rounded-lg border border-border p-4"><div className="mb-3 flex items-center justify-between gap-3"><span className="text-xs font-semibold text-muted-foreground">成员 {index + 1}</span><Button type="button" variant="ghost" size="icon" aria-label={`移除成员 ${index + 1}`} onClick={() => update('members', form.members.filter((_, i) => i !== index))}><Trash2 className="h-4 w-4" /></Button></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Field label={`所在群 ${index + 1}`}><select className={inputClass} value={member.chatId} onChange={event => updateMember(index, { chatId: event.target.value })}><option value="">选择已授权的群</option>{!form.groups.some(group => group.chatId === member.chatId) && member.chatId && <option value={member.chatId}>群标识已变更，请重新选择</option>}{form.groups.filter(group => group.chatId.trim()).map((group, i) => <option key={i} value={group.chatId}>{group.name || group.chatId}</option>)}</select></Field><Field label={`成员名称 ${index + 1}`}><input className={inputClass} value={member.name} onChange={event => updateMember(index, { name: event.target.value })} placeholder="便于识别的名称" /></Field><Field label={`成员标识 ${index + 1}`}><input className={inputClass} value={member.openId} onChange={event => updateMember(index, { openId: event.target.value })} placeholder="ou_…" autoComplete="off" /></Field><Field label={`绑定邮箱 ${index + 1}`}><input type="email" className={inputClass} value={member.email} onChange={event => updateMember(index, { email: event.target.value })} placeholder="name@example.com" autoComplete="off" /></Field></div><label className="mt-4 flex items-center gap-2.5 text-sm"><input type="checkbox" checked={member.canEmail} onChange={event => updateMember(index, { canEmail: event.target.checked })} className="h-4 w-4 accent-primary" />允许该成员请求发送日报邮件</label></div>)}</div>
      </section>
    </fieldset>
    <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/95 px-4 py-3 shadow-sm backdrop-blur-sm"><div aria-live="polite" className="min-w-0 text-sm">{notice ? <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'text-destructive' : 'text-success'}>{notice.message}</p> : <p className="text-muted-foreground">{dirty ? '有未保存的修改。' : '保存设置不会发送消息或邮件。'}</p>}</div><Button type="submit" className="ml-auto" disabled={saving || !dirty}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{demo ? '保存演示配置' : '保存配置'}</Button></div>
  </form>
}

function AssistantActivityList({ service, demo }: { service: AssistantService; demo: boolean }) {
  const [events, setEvents] = useState<AssistantActivity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    void service.activity().then(data => { if (active) { setEvents(data.events || []); setError('') } }).catch(error => { if (active) setError(errorMessage(error, '最近消息暂时无法读取。')) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [service, reload])
  const labels: Record<string, string> = { completed: '已处理', replied: '已回复', preview: '已预览', previewed: '已预览', failed: '失败', error: '失败', ignored: '已忽略', rejected: '已拒绝', pending: '等待处理', queued: '等待处理', working: '处理中', processing: '处理中', received: '已接收', success: '已处理', reply_unknown: '回复结果待确认' }
  return <section className="rounded-xl border border-border bg-card p-5"><div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">最近消息</h2><p className="mt-1.5 text-xs text-muted-foreground">{demo ? '仅显示当前演示页面的试用记录。' : '查看助手最近的处理结果与错误；预览记录不代表已向客户发送。'}</p></div><Button variant="outline" size="sm" disabled={loading} onClick={() => { setLoading(true); setReload(value => value + 1) }}><RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />刷新</Button></div>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {loading ? <p role="status" className="py-10 text-center text-sm text-muted-foreground">正在读取最近消息…</p> : !events.length && !error ? <div className="py-14 text-center"><History className="mx-auto h-7 w-7 text-muted-foreground/50" /><p className="mt-3 text-sm text-muted-foreground">暂无消息记录，可先在聊天试用中生成一条预览。</p></div> : <div className="mt-5 divide-y divide-border">{events.map(event => <article key={event.id} className="py-4 first:pt-0"><div className="flex flex-wrap items-center gap-2 text-xs"><span className={cn('inline-flex items-center gap-1 rounded-md px-2 py-1', event.error ? 'bg-destructive/5 text-destructive' : 'bg-muted text-muted-foreground')}>{!event.error && ['completed', 'replied', 'preview', 'previewed', 'success'].includes(event.status) && <Check className="h-3 w-3" />}{labels[event.status] || '状态待确认'}</span><span className="text-muted-foreground">{event.dryRun ? '仅预览 · 未外发' : '正式请求'}</span><time className="ml-auto text-muted-foreground">{formatTime(event.createdAt)}</time></div>{event.reply && <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-7"><ReplyText text={event.reply} /></div>}{event.error && <p className="mt-2 break-words text-sm text-destructive">{event.error}</p>}</article>)}</div>}
  </section>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0 text-xs font-medium text-muted-foreground">{label}{children}</label>
}

function ReplyText({ text }: { text: string }) {
  return <>{text.split(/(\[[^\]]{1,200}\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<]+)/g).map((part, index) => {
    const markdown = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part)
    if (markdown) return <a key={index} href={markdown[2]} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{markdown[1]}</a>
    if (/^https?:\/\//.test(part)) return <a key={index} href={part} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-4">{part}</a>
    return part
  })}</>
}

function ToolResults({ results }: { results: unknown[] }) {
  const rendered = JSON.stringify(results, (key, value: unknown) => /^(appSecret|verificationToken|encryptKey|password|authorization|access_token|refresh_token)$/i.test(key) ? '[已隐藏]' : value, 2)
  return <details className="group mt-3 border-t border-border pt-2"><summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">查看查询结果 <span>({results.length})</span><ChevronDown className="ml-auto h-3.5 w-3.5 transition-transform group-open:rotate-180" /></summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background p-3 text-xs leading-6 text-muted-foreground">{rendered}</pre></details>
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}
