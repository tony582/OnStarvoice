import {api} from '@/lib/api'
import type {AndroidNode, CreateDiscoveryRun, DiscoveryRun, DiscoveryRunDetail} from './types'

const base = '/capture-cloud/android'
export const androidApi = {
  capabilities: () => api.get<{ok: boolean; enabled: boolean}>(`${base}/capabilities`),
  nodes: () => api.get<{ok: boolean; nodes: AndroidNode[]}>(`${base}/nodes`),
  runs: () => api.get<{ok: boolean; runs: DiscoveryRun[]}>(`${base}/runs`),
  detail: (id: string) => api.get<DiscoveryRunDetail>(`${base}/runs/${encodeURIComponent(id)}`),
  create: (body: CreateDiscoveryRun) => api.post<{ok: boolean; run: DiscoveryRun}>(`${base}/runs`, body),
  stop: (id: string, scope: 'discovery' | 'batch') => api.post(`${base}/runs/${encodeURIComponent(id)}/stop`, {scope}),
  resume: (id: string) => api.post(`${base}/runs/${encodeURIComponent(id)}/resume`),
  reprocess: (id: string, eventIds: string[], requestId: string) => api.post(
    `/capture-cloud/tasks/${encodeURIComponent(id)}/discoveries/reprocess`, {eventIds, requestId}),
}

export type AndroidApi = typeof androidApi

export function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  const translations: Record<string, string> = {
    STOP_OR_DEVICE_CLOSURE_REQUIRED: '任务已请求停止，或旧操作尚未确认结束。请刷新查看恢复检查。',
    RUN_DEADLINE_EXPIRED: '本批次已超过执行时限，请创建新任务。',
    CREATE_REQUEST_CONFLICT: '本次请求已提交过，请刷新核对任务。',
    DEVICE_HELD: '手机仍有未确认停止的操作，请先在电脑端核对设备。',
    DEVICE_CLOSURE_REQUIRED: '请先在电脑端确认上一项手机操作已经停止。',
    MOBILE_AGENT_NOT_FOUND: '原手机节点已停用或移除，请刷新核对执行节点。',
    MOBILE_AGENT_NOT_AUTHORIZED: '手机节点授权已失效，请重新连接。',
    RUN_NOT_RESUMABLE: '该任务当前不能恢复，请刷新查看最新状态。',
    REQUEST_PAYLOAD_CONFLICT: '本次请求已提交过，参数发生变化，请刷新核对任务。',
    server_busy: '服务暂时繁忙，请稍后刷新核对。',
  }
  return translations[message] || (/[\u3400-\u9fff]/u.test(message) ? message : '操作暂未完成，请刷新核对后重试。')
}
