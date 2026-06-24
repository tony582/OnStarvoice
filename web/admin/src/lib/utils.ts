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

// 紧凑(列表用,省宽):MM-DD HH:mm,不带年份。精确时间看详情抽屉(到秒)。
export function formatDateCompact(v: string | undefined | null): string {
  if (!v) return '-'
  try {
    const d = new Date(v)
    if (isNaN(d.getTime())) return v
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
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

// 账号名带品牌/车型(全称·简称)= 品牌关联号(非真实车主)。客户口径:名字带品牌车型,不是 4S店 即 KOE。
// ⚠ 与 server/routes/triage.js 的同名正则保持一致
const BRAND_MODEL_RE = /(安吉星|onstar|别克|凯迪拉克|凯迪|雪佛兰|buick|cadillac|chevrolet|上汽通用|君越|君威|昂科威|昂科拉|昂科旗|gl8|gl6|英朗|威朗|凯越|微蓝|velite|阅朗|ct4|ct5|ct6|xt4|xt5|xt6|锐歌|lyriq|凯雷德|科鲁兹|科沃兹|迈锐宝|创酷|创界|探界者|开拓者|沃兰多|星迈罗|赛欧|畅巡|景程)/i
const DEALER_NAME_RE = /(4s|旗舰店|体验中心|服务中心|销售服务|特约|经销|汽贸)/i

// 疑似身份:① 账号名带品牌/车型 → 像门店/经销(或 LLM 判经销)=4S店,否则 =KOE;
//          ② 名字不带品牌 → 按 LLM source_type:用户(ugc)·KOL 按粉丝分级(KOC<5万/初级<50万/中级<300万/头部≥300万)·4S店·KOE(员工)·其他
export function identityLabel(sourceType?: string | null, fans?: number | null, name?: string | null): string {
  const nm = String(name || '')
  const st = String(sourceType || '')
  if (BRAND_MODEL_RE.test(nm)) {
    return (DEALER_NAME_RE.test(nm) || st === 'dealer') ? '4S店' : 'KOE'
  }
  if (st === 'dealer') return '4S店'
  if (st === 'employee') return 'KOE'
  if (st === 'ugc') return '用户'
  if (st === 'other') return '其他'
  if (st === 'pgc') {
    const f = Number(fans)
    if (!Number.isFinite(f) || f <= 0) return 'KOL'
    if (f < 50000) return 'KOC'
    if (f < 500000) return '初级KOL'
    if (f < 3000000) return '中级KOL'
    return '头部KOL'
  }
  return ''
}
