import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatNumber(v: number | string | undefined | null): string {
  const num = Number(v)
  if (isNaN(num)) return '0'
  if (num >= 10000) return (num / 10000).toFixed(1) + '万'
  return num.toLocaleString('zh-CN')
}

export function formatDate(v: string | undefined | null): string {
  if (!v) return '-'
  try {
    const d = new Date(v)
    if (isNaN(d.getTime())) return v
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前'
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前'
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  } catch {
    return v
  }
}

export function formatFullDate(v: string | undefined | null): string {
  if (!v) return '-'
  try {
    return new Date(v).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return v
  }
}

// 精确到秒(采集快照历史用,区分相隔几秒的两次采集)
export function formatFullDateSec(v: string | undefined | null): string {
  if (!v) return '-'
  try {
    return new Date(v).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return v
  }
}

export function compact(text: string, maxLen: number): string {
  if (!text) return ''
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text
}

export const LABELS = {
  sentiment: { positive: '正面', neutral: '中性', negative: '负面', '': '待标注' } as Record<string, string>,
  category: {
    safety_rescue: '安全救援', feature_usage: '功能使用', renewal_billing: '续费收费',
    privacy: '隐私安全', app_issue: 'App问题', service_quality: '服务质量',
    brand_image: '品牌形象', other: '其他', '': '待分类',
  } as Record<string, string>,
  triage: {
    unhandled: '未处理', reviewing: '待复核', issue_linked: '已转工单', ticketed: '已转工单',
    official_responded: '官方已响应', archived: '已归档', false_positive: '误报',
  } as Record<string, string>,
  priority: { low: '低', normal: '普通', high: '高', urgent: '紧急' } as Record<string, string>,
  issueStatus: {
    new: '新建', triage: '分诊', in_progress: '处理中', waiting: '等待',
    review: '复核', resolved: '已解决', closed: '已关闭', ignored: '忽略',
  } as Record<string, string>,
  severity: { low: '低', medium: '中', high: '高', critical: '严重' } as Record<string, string>,
  reportType: { daily: '日报', weekly: '周报', monthly: '月报' } as Record<string, string>,
  reportStatus: { generating: '生成中', generated: '待发送', sent: '已发送', skipped: '无新增', failed: '失败' } as Record<string, string>,
  leadStatus: { new: '新线索', following: '跟进中', ticketed: '已转工单', resolved: '已处理', ignored: '已忽略' } as Record<string, string>,
  leadType: {
    sales_intent: '购买意向', complaint: '投诉维权', renewal_billing: '续费收费',
    app_issue: 'App故障', service_quality: '服务求助', safety_privacy: '安全隐私',
    brand_risk: '品牌风险', other: '其他跟进',
  } as Record<string, string>,
  recordType: {
    single_note: '单笔记', keyword_notes: '关键词笔记', blogger_profile: '博主信息',
    blogger_notes: '博主笔记', official_content: '官方内容',
  } as Record<string, string>,
  role: {
    platform_admin: '平台管理员', internal_operator: '内部运营',
    tenant_admin: '客户管理员', tenant_analyst: '分析员', tenant_viewer: '只读',
  } as Record<string, string>,
  platform: {
    xiaohongshu: '小红书', douyin: '抖音', weibo: '微博',
  } as Record<string, string>,
} as const

export function platformName(key: string): string {
  return LABELS.platform[key] || key || '-'
}

// 账号名疑似品牌关联(经销商/员工/营销号):品牌/车型词 + 角色/营销词 → 非真实车主 UGC
const KOE_BRAND_RE = /(安吉星|onstar|别克|凯迪拉克|雪佛兰|上汽通用|gl8|昂科威|君威|君越|英朗|威朗|科鲁兹|凯越|探界者|创酷|迈锐宝|cadillac|buick|chevrolet)/i
const KOE_ROLE_RE = /(4s|店|销售|顾问|客服|服务|经销|官方|导购|试驾|售后|服务生|大话|说车|聊车|玩车|车评|讲车|谈车|解读|百科|严选|优选|学堂|课堂|研究所|资讯|那些事|车事)/i
export function looksLikeKOEName(name?: string | null): boolean {
  const n = String(name || '')
  return KOE_BRAND_RE.test(n) && KOE_ROLE_RE.test(n)
}
