import {CircleCheck, CircleAlert, Clock3} from 'lucide-react'
import {durationLabel} from './presentation'
import type {RunRecovery} from './types'

const messages: Record<RunRecovery['state'], {title: string; description: string}> = {
  working: {title: '手机正在执行', description: '设备占用属于正常执行，当前不需要恢复。'},
  closure_required: {title: '先确认旧操作已停止', description: 'USB 接回只表示连接恢复。系统收到停稳确认后，才允许继续原任务。'},
  stopping: {title: '等待执行端确认停止', description: '停止请求已发出，设备确认停止前仍保留占用。'},
  stopped: {title: '本批次已停止', description: '停止请求不会通过恢复按钮撤销；继续发现请新建任务。'},
  deadline_expired: {title: '原批次时限已用完', description: '已找到的内容保留；继续搜索请新建任务。'},
  ready: {title: '可以恢复原任务', description: '恢复会重新领取执行许可，沿用原批次时限和已消耗的采集额度。'},
  waiting_device: {title: '可先排队，等待手机就绪', description: '旧操作已确认停止。恢复后仍需执行器上线、手机连接并解锁，且原时限不会重置。'},
  node_unavailable: {title: '执行节点不可用', description: '原手机节点已停用或移除，无法恢复。请先在电脑端连接有效节点，再创建任务。'},
  not_needed: {title: '当前无需恢复', description: '请查看任务进度及各关键词的结束原因。'},
}
function Check({ok, title, children}: {ok: boolean; title: string; children: React.ReactNode}) {
  const Icon = ok ? CircleCheck : CircleAlert
  return <li className="flex items-start gap-2.5">
    <Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${ok ? 'text-emerald-600' : 'text-amber-700'}`}/>
    <div><p className="font-medium">{title}</p><p className="mt-0.5 text-muted-foreground">{children}</p></div>
  </li>
}
export function RecoveryPanel({recovery}: {recovery: RunRecovery}) {
  if (['not_needed', 'working'].includes(recovery.state)) return null
  const message = messages[recovery.state]
  return <section aria-label="任务恢复检查" className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 text-xs leading-5 dark:border-amber-900 dark:bg-amber-950/10">
    <h4 className="text-sm font-semibold">{message.title}</h4>
    <p className="mt-1 text-muted-foreground">{message.description}</p>
    <ul className="mt-4 grid gap-3 sm:grid-cols-3">
      <Check ok={!recovery.deviceHeld} title="旧手机操作">
        {recovery.deviceHeld ? '尚未确认停止' : '已停止，无本批次占用'}
      </Check>
      <Check ok={recovery.deviceReady} title="执行设备">
        {recovery.resumeError === 'MOBILE_AGENT_NOT_FOUND' ? '节点已停用或移除' : recovery.deviceReady ? '已连接，可执行搜索' : recovery.deviceOnline ? '执行器在线，手机尚未就绪' : '执行器离线，需在电脑端启动'}
      </Check>
      <Check ok={recovery.remainingMs !== null && recovery.remainingMs > 0} title="原批次时限">
        {recovery.remainingMs === null ? '尚未开始计时' : recovery.remainingMs > 0 ? `本次检查剩余 ${durationLabel(recovery.remainingMs)}` : '已经用完'}
      </Check>
    </ul>
    {recovery.closureRequired && <div className="mt-4 border-t border-amber-200/70 pt-3">
      <p className="font-medium">在连接手机的电脑上处理</p>
      <ol className="mt-1 list-decimal space-y-1 pl-5">
        <li>接稳 USB 并解锁手机。</li>
        <li>停止旧执行器，核对其手机控制会话已经结束，再完成本机停稳确认。</li>
        <li>重新启动执行器，刷新本页；检查通过后点击恢复。</li>
      </ol>
      <p className="mt-2 text-muted-foreground">本机停稳确认目前由运维操作，网页不能代替检查或强制解除设备占用。</p>
    </div>}
    <p className="mt-3 flex items-center gap-1 text-muted-foreground"><Clock3 className="h-3 w-3" aria-hidden="true"/>最近检查 {new Date(recovery.checkedAt).toLocaleTimeString('zh-CN')}</p>
  </section>
}
