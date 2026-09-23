import {Loader2, RefreshCw, Smartphone} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {androidApi} from './api'
import type {AndroidApi} from './api'
import {useAndroidDiscovery} from './useAndroidDiscovery'
import {CreateMobileRun} from './CreateMobileRun'
import {MobileRunDetail} from './MobileRunDetail'
import {nodeStateLabel, reasonLabel, statusLabel} from './presentation'

export function AndroidDiscoveryPanel({writable, client = androidApi}: {writable: boolean; client?: AndroidApi}) {
  const state = useAndroidDiscovery(client)
  return <div className="space-y-4">
    <div className="flex items-start justify-between gap-4">
      <p className="text-sm leading-6 text-muted-foreground">手机搜索发现作品，浏览器补充详情；每条结果都可追踪。</p>
      <Button size="sm" variant="outline" disabled={state.busy} onClick={() => { void state.refresh() }} aria-label="刷新手机发现"><RefreshCw className="h-4 w-4"/>刷新</Button>
    </div>
    {state.error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{state.error}</p>}
    {state.feedback && <p role="status" className="rounded-lg bg-primary/10 p-3 text-sm text-primary">{state.feedback}</p>}
    {state.loading ? <div className="flex justify-center p-12"><Loader2 className="h-6 w-6 animate-spin" aria-label="加载手机任务"/></div> : <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="space-y-4">
        <section aria-label="手机节点" className="space-y-2">
          <h3 className="text-sm font-semibold">执行手机</h3>
          {!state.nodes.length && <p className="rounded-xl border border-dashed p-4 text-xs leading-5 text-muted-foreground">尚未注册手机。先在电脑运行连接配置，再查看设备状态。</p>}
          {state.nodes.map(node => <div key={node.id} className="rounded-xl border border-border p-3">
            <p className="flex items-center gap-2 text-sm font-medium"><Smartphone className="h-4 w-4 text-primary"/>{node.displayName || '安卓手机'}</p>
            <p className="mt-1 text-xs text-muted-foreground">{nodeStateLabel(node)}</p>
            {node.holdReason && <p className="mt-1 text-xs text-amber-700">{reasonLabel(node.holdReason)}</p>}
          </div>)}
        </section>
        {writable && <CreateMobileRun nodes={state.nodes} busy={state.busy} onCreate={body => state.act(async () => {
          const result = await client.create(body)
          state.setSelectedId(result.run.id)
        }, '任务已创建；设备满足执行条件后会领取。')}/>}
        <nav className="space-y-1" aria-label="手机发现批次">
          <h3 className="mb-2 text-sm font-semibold">最近批次</h3>
          {!state.runs.length && <p className="text-xs text-muted-foreground">暂无手机发现任务</p>}
          {state.runs.map(run => <button key={run.id} onClick={() => state.setSelectedId(run.id)} aria-current={state.selectedId === run.id ? 'true' : undefined}
            className={`w-full rounded-lg border p-3 text-left ${state.selectedId === run.id ? 'border-primary/40 bg-primary/5' : 'border-transparent hover:bg-muted'}`}>
            <span className="block text-sm font-medium">{run.title}</span><span className="mt-1 block text-xs text-muted-foreground">{statusLabel(run.status)} · {run.keywords.join('、')}</span>
          </button>)}
        </nav>
      </aside>
      <section className="min-w-0 rounded-xl border border-border p-4 sm:p-5" aria-label="手机任务详情">
        {state.detail ? <MobileRunDetail detail={state.detail} writable={writable} busy={state.busy}
          onStop={scope => { void state.act(() => client.stop(state.detail!.run.id, scope), '停止请求已提交，请查看执行端确认状态。') }}
          onResume={() => { void state.act(() => client.resume(state.detail!.run.id), '恢复请求已提交，将重新核对设备状态。') }}
          onReprocess={(ids, requestId) => state.act(() => client.reprocess(state.detail!.run.id, ids, requestId), '所选内容已提交重新处理，原任务结果已保留。')}/>
          : <p className="py-20 text-center text-sm text-muted-foreground">{state.selectedId ? '正在加载任务详情…' : '创建或选择一个批次，查看发现内容与入库进度。'}</p>}
      </section>
    </div>}
  </div>
}
