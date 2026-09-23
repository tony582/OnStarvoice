import type {AndroidNode, DiscoveryRunDetail} from './types'

const labels: Record<string, string> = {
  pending: '等待领取', waiting_device: '等待设备', claimed: '已领取', running: '执行中',
  recovering: '恢复中', interrupted: '已中断', resume_requested: '等待恢复',
  needs_action: '需要处理', completed: '发现结束', completed_with_warnings: '发现结束 · 有待核对',
  completed_with_failures: '部分失败', failed: '失败', canceled: '已停止', skipped: '已跳过',
  awaiting_detail_adapter: '等待详情接入', queued: '等待补详情', capturing: '正在补详情',
  stored: '已入库', already_exists: '已存在', needs_review: '需要核对',
  resolved: '链接已确认', unresolvable: '链接无法解析', fulfilled: '详情已完成',
}
const reasons: Record<string, string> = {
  profile_required: '尚未配置这台手机的采集适配',
  profile_version_mismatch: '手机或抖音版本已变化，需要重新适配',
  device_locked: '请先解锁手机',
  ui_target_ambiguous: '页面控件发生变化，已暂停操作',
  search_filters_changed: '搜索条件发生变化，已暂停采集',
  filter_unverified: '无法确认搜索筛选条件',
  filter_ambiguous: '无法唯一识别搜索筛选选项',
  existing_record_identity_mismatch: '已有内容与手机作品的正文或作者不一致',
  DISCOVERY_DETAIL_IDENTITY_MISMATCH: '浏览器详情与手机作品不一致，未写入正式内容',
  device_closure_required: '上次设备操作是否停止仍需确认',
  lease_expired: '执行许可已过期，等待恢复确认',
  usb_disconnected: '手机连接已断开',
  login_required: '需要在手机上登录抖音',
  link_unverified: '当前作品与分享链接尚未核对一致',
  work_identity_mismatch: '链接中的作品与当前页面不一致',
  short_link_resolver_unavailable: '短链接尚未解析',
  short_link_resolution_failed: '短链接解析失败',
  short_link_dns_address_blocked: '链接域名解析到了受限地址，请检查服务端网络',
  short_link_dns_failed: '链接域名暂时无法解析',
  late_audit: '任务结束后收到的发现证据，需重新处理',
  manual_review_required: '需要人工核对',
  clipboard_restore_unconfirmed: '复制链接时中断，尚未确认剪贴板恢复；本次未完成的复制不会作为发现结果提交',
  appium_http_error: '手机控制连接异常，需确认旧操作已停止',
  session_creation_unconfirmed: '手机控制会话创建中断，是否仍在操作尚未确认',
  process_restarted: '执行器重新启动，原任务等待恢复确认',
  keyword_time_limit: '已到单关键词时限，本次发现结束；不代表已搜完所有结果',
  batch_time_limit: '已到本批次时限，保留已经发现的作品',
  task_deadline: '已到原批次截止时间，保留已经发现的作品',
  deadline_expired: '本批次已过期，需要新建任务继续发现',
  link_limit: '已达到本次作品数量上限',
  card_limit: '已达到本次浏览卡片上限，不代表已搜完所有结果',
  swipe_limit: '已达到本次翻页上限，不代表已搜完所有结果',
  remote_stop: '已收到停止请求',
  user_stop: '电脑端已请求停止',
  outbox_backlog: '待上传队列积压，暂停继续发现',
}
const limitReasons = new Set(['keyword_time_limit', 'batch_time_limit', 'task_deadline', 'link_limit', 'card_limit', 'swipe_limit'])
export function runResultLabel(detail: DiscoveryRunDetail) {
  return detail.run.status === 'completed' && detail.items.some(item => limitReasons.has(item.reason || ''))
    ? '发现结束 · 达到本次上限' : statusLabel(detail.run.status)
}
export function nodeStateLabel(node: AndroidNode) {
  if (node.holdState === 'closure_required') return '旧操作待确认停止'
  if (node.holdState === 'stopping') return '正在停止手机操作'
  if (node.deviceHeld) return '正在执行手机任务'
  if (node.status !== 'active') return '节点已停用'
  if (!node.online) return '执行器离线'
  return node.readyForSearch ? '可执行搜索' : '已连接 · 等待手机就绪'
}
export function durationLabel(milliseconds: number) {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1000)
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
export const statusLabel = (status: string) => labels[status] || '等待核对'
export const reasonLabel = (reason?: string) => reason ? reasons[reason] || '请查看任务详情并核对执行端状态' : ''
export const canResumeRun = (status: string) => ['needs_action', 'interrupted'].includes(status)
export const canStopDiscovery = (status: string) => ['pending', 'waiting_device', 'claimed', 'running', 'recovering', 'interrupted', 'needs_action', 'resume_requested'].includes(status)
export function safeOriginalUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['www.douyin.com', 'v.douyin.com', 'www.iesdouyin.com'].includes(url.hostname) ? url.href : null
  } catch { return null }
}
