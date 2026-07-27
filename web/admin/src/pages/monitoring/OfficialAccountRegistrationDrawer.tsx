import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Check, Loader2, RadioTower, ShieldCheck, X } from 'lucide-react'
import { api } from '@/lib/api'
import { platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Drawer } from '@/components/shared/Drawer'
import { StatusBadge, StatusDot } from '@/components/ui/badge'

type CreatorSubscription = {
  id: string
  name?: string
  platform: string
  keyword?: string
  account_url?: string
  accountUrl?: string
  status?: string
  subject_type?: string
  subjectType?: string
  has_official_role?: boolean
  hasOfficialRole?: boolean
}

type SubscriptionResponse = {
  subscriptions?: CreatorSubscription[]
}

export function OfficialAccountRegistrationDrawer({
  onClose,
  onRegistered,
}: {
  onClose: () => void
  onRegistered: () => Promise<void> | void
}) {
  const [subscriptions, setSubscriptions] = useState<CreatorSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [registeringId, setRegisteringId] = useState('')
  const [error, setError] = useState('')
  const [successName, setSuccessName] = useState('')

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      void (async () => {
        setLoading(true)
        setError('')
        try {
          const result = await api.get<SubscriptionResponse>('/monitor/subscriptions?subjectType=creator')
          if (active) setSubscriptions((result.subscriptions || []).filter(item => item?.id))
        } catch (requestError) {
          if (!active) return
          setError(requestError instanceof Error ? requestError.message : '读取关注账号失败')
          setSubscriptions([])
        } finally {
          if (active) setLoading(false)
        }
      })()
    })
    return () => {
      active = false
    }
  }, [])

  const activeSubscriptions = useMemo(
    () => subscriptions.filter(item => (
      item.status !== 'deleted'
      && item.hasOfficialRole !== true
      && item.has_official_role !== true
    )),
    [subscriptions],
  )

  const register = async (subscription: CreatorSubscription) => {
    if (!window.confirm(
      `将“${subscription.name || '当前账号'}”转为官方账号？确认后将进入独立的官方账号作品发现与评论巡查流程；原关注博主计划会暂停，历史扫描记录继续保留。`,
    )) return
    setRegisteringId(subscription.id)
    setError('')
    setSuccessName('')
    try {
      await api.post(`/monitor/subscriptions/${subscription.id}/mark-official`, {})
      setSuccessName(subscription.name || '官方账号')
      setSubscriptions(items => items.map(item => item.id === subscription.id
        ? { ...item, has_official_role: true, hasOfficialRole: true }
        : item))
      await onRegistered()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '登记官方账号失败')
    } finally {
      setRegisteringId('')
    }
  }

  return (
    <Drawer onClose={onClose} width="lg" labelledBy="official-account-registration-title">
      <header className="shrink-0 border-b border-border/70 px-5 py-5 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-primary">
              <ShieldCheck className="h-4 w-4" />
              <span className="text-[11px] font-bold uppercase tracking-[0.16em]">Official account</span>
            </div>
            <h2 id="official-account-registration-title" className="mt-1 text-lg font-bold text-foreground">从已关注账号登记官方账号</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              账号主页和历史作品会保留；登记后将进入独立的作品发现与评论巡查链路。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-dialog-initial-focus
            aria-label="关闭登记官方账号"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
        <div className="rounded-xl border border-primary/20 bg-primary/[0.045] px-4 py-3 text-xs leading-5 text-muted-foreground">
          新账号也可以在对应平台主页打开 Extension，识别后直接选择“登记为官方账号”，无需手工填写账号 ID。
        </div>

        {successName && (
          <div role="status" className="mt-4 flex items-center gap-2 rounded-xl border border-status-green/25 bg-status-green/8 px-4 py-3 text-sm text-status-green">
            <Check className="h-4 w-4" /> 已将“{successName}”转入官方账号巡查；原关注博主计划已暂停，历史记录已保留
          </div>
        )}
        {error && (
          <div role="alert" className="mt-4 rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-sm text-status-red">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : activeSubscriptions.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-dashed border-border px-5 py-12 text-center">
            <RadioTower className="mx-auto h-7 w-7 text-muted-foreground" />
            <div className="mt-3 text-sm font-semibold">没有可转换的关注账号</div>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
              请在官方账号主页打开 Extension，选择“登记为官方账号”。
            </p>
          </div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-2xl border border-border/70">
            {activeSubscriptions.map(subscription => {
              const accountUrl = subscription.account_url || subscription.accountUrl || ''
              const registering = registeringId === subscription.id
              const registered = subscription.hasOfficialRole === true || subscription.has_official_role === true
              return (
                <article key={subscription.id} className="flex flex-col gap-3 border-b border-border/60 px-4 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone="neutral">{platformName(subscription.platform)}</StatusBadge>
                      <StatusDot tone={subscription.status === 'active' ? 'active' : 'muted'}>
                        {subscription.status === 'active' ? '已启用' : '当前已暂停'}
                      </StatusDot>
                    </div>
                    <div className="mt-2 truncate text-sm font-bold text-foreground">{subscription.name || '未命名账号'}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{subscription.keyword || '未记录账号标识'}</span>
                      {accountUrl && (
                        <a href={accountUrl} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-primary hover:underline">
                          查看主页 <ArrowUpRight className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={registered ? 'outline' : 'default'}
                    className="shrink-0"
                    onClick={() => void register(subscription)}
                    disabled={registering || registered}
                  >
                    {registering ? <Loader2 className="h-4 w-4 animate-spin" /> : registered ? <Check className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                    {registering ? '正在登记' : registered ? '已登记官方账号' : '登记为官方账号'}
                  </Button>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </Drawer>
  )
}
