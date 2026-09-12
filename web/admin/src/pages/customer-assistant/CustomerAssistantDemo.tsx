import { useState } from 'react'
import { CustomerAssistantWorkspace } from './CustomerAssistantWorkspace'
import { EMPTY_ASSISTANT_SETTINGS, type AssistantActivity, type AssistantService, type AssistantSettings } from '@/lib/customer-assistant'

// This adapter has no network calls and is reachable only from the explicit development preview.
function createDemoService(): AssistantService {
  let settings: AssistantSettings = {
    ...EMPTY_ASSISTANT_SETTINGS,
    botOpenId: 'ou_demo_bot', hasVerificationToken: true, hasEncryptKey: true,
    groups: [{ chatId: 'oc_demo_customer_group', name: '客户舆情服务群（演示）' }],
    members: [
      { chatId: 'oc_demo_customer_group', openId: 'ou_demo_contact', name: '客户经办人（演示）', email: 'customer@example.com', canEmail: true },
      { chatId: 'oc_demo_customer_group', openId: 'ou_demo_viewer', name: '只读成员（演示）', email: '', canEmail: false },
    ],
  }
  let sequence = 0
  const events: AssistantActivity[] = []
  const snapshot = () => ({ ok: true as const, settings: structuredClone(settings), callbackPath: '/api/customer-assistant/feishu/demo-tenant' })
  return {
    settings: async () => snapshot(),
    save: async input => {
      const { appSecret, verificationToken, encryptKey, ...publicSettings } = input
      settings = { ...settings, ...structuredClone(publicSettings), hasAppSecret: settings.hasAppSecret || !!appSecret, hasVerificationToken: settings.hasVerificationToken || !!verificationToken, hasEncryptKey: settings.hasEncryptKey || !!encryptKey }
      return snapshot()
    },
    preview: async input => {
      const member = settings.members.find(member => member.chatId === input.chatId && member.openId === input.senderId)
      if (!member) throw new Error('演示成员尚未授权，请重新选择。')
      let reply: string
      let toolResults: unknown[]
      if (/邮件|邮箱|email|mail/i.test(input.text)) {
        reply = member.canEmail
          ? '邮件预览，未发送。\n收件人：customer@example.com（演示邮箱）\n主题：客户舆情日报 · 2026-09-12（演示）\n正文将使用已保存的日报内容，并附日报文件。\n这是模拟结果，没有真实邮件或附件。'
          : '这位演示成员尚未获准发送日报邮件。请由管理员在“授权成员与邮箱”中绑定邮箱并开启邮件权限。'
        toolResults = [{ name: 'preview_daily_report_email', dryRun: true, status: member.canEmail ? 'preview' : 'not_authorized', demonstration: true }]
      } else if (/日报|报告/.test(input.text)) {
        reply = '演示日报：2026-09-12《客户舆情日报》\n模拟摘要：本期纳入 12 条负面内容，其中 3 条待跟进。\n正式接入后会返回当前租户对应日期的真实日报入口。此演示没有生成文件。'
        toolResults = [{ name: 'get_daily_report', date: '2026-09-12', status: 'demo', demonstration: true }]
      } else {
        reply = '演示结果：今天共 12 条负面内容。\n统计范围：演示租户，2026-09-12 00:00 至 10:30（北京时间）。\n其中 3 条待跟进。数量与内容均为演示数据，不代表真实舆情。\n你可以接着说“今天的日报给我一份”或“把日报发我邮箱”。'
        toolResults = [{ name: 'get_negative_count', count: 12, pending: 3, date: '2026-09-12', asOf: '2026-09-12T02:30:00.000Z', demonstration: true }]
      }
      const id = `demo-message-${++sequence}`
      events.unshift({ id, status: 'preview', createdAt: new Date().toISOString(), reply, dryRun: true })
      return { ok: true, reply, toolResults, sessionId: input.sessionId || `demo-session-${sequence}`, dryRun: true }
    },
    activity: async () => ({ ok: true, events: structuredClone(events) }),
  }
}

export default function CustomerAssistantDemo() {
  const [service] = useState(createDemoService)
  return <main className="min-h-dvh bg-background px-4 py-6 text-foreground sm:px-6 lg:px-10"><CustomerAssistantWorkspace service={service} tenantName="示例客户（演示）" demo /></main>
}
