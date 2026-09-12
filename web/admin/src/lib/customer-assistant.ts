import { api } from '@/lib/api'

export type AssistantGroup = { chatId: string; name: string }
export type AssistantMember = { chatId: string; openId: string; name: string; email: string; canEmail: boolean }
export type AssistantSettings = {
  enabled: boolean
  mode: 'preview' | 'live'
  useDailyApp: boolean
  appId: string
  botOpenId: string
  groups: AssistantGroup[]
  members: AssistantMember[]
  hasAppSecret: boolean
  hasVerificationToken: boolean
  hasEncryptKey: boolean
}
export type AssistantSecrets = { appSecret: string; verificationToken: string; encryptKey: string }
export type AssistantSettingsInput = Omit<AssistantSettings, 'hasAppSecret' | 'hasVerificationToken' | 'hasEncryptKey'> & Partial<AssistantSecrets>
export type AssistantSettingsResponse = { ok: true; settings: AssistantSettings; callbackPath?: string }
export type AssistantPreviewInput = { text: string; chatId: string; senderId: string; sessionId?: string }
export type AssistantPreviewResponse = {
  ok: true
  reply: string
  toolResults: unknown[]
  sessionId: string
  dryRun: true
}
export type AssistantActivity = { id: string; status: string; createdAt: string; reply?: string; error?: string; dryRun: boolean }
export type AssistantActivityResponse = { ok: true; events: AssistantActivity[] }
export type AssistantService = {
  settings: () => Promise<AssistantSettingsResponse>
  save: (settings: AssistantSettingsInput) => Promise<AssistantSettingsResponse>
  preview: (input: AssistantPreviewInput) => Promise<AssistantPreviewResponse>
  activity: () => Promise<AssistantActivityResponse>
}

export const EMPTY_ASSISTANT_SETTINGS: AssistantSettings = {
  enabled: false, mode: 'preview', useDailyApp: true, appId: '', botOpenId: '',
  groups: [], members: [], hasAppSecret: false, hasVerificationToken: false, hasEncryptKey: false,
}

function checked<T extends { ok: true }>(response: T): T {
  if (!response?.ok) throw new Error('客户助手请求未完成，请重试。')
  return response
}

export const customerAssistantApi: AssistantService = {
  settings: async () => checked(await api.get<AssistantSettingsResponse>('/customer-assistant/settings')),
  save: async settings => checked(await api.put<AssistantSettingsResponse>('/customer-assistant/settings', settings)),
  preview: async input => {
    const response = checked(await api.post<AssistantPreviewResponse>('/customer-assistant/preview', input))
    if (response.dryRun !== true) throw new Error('服务未返回预览标记，请联系管理员检查客户助手配置。')
    return response
  },
  activity: async () => checked(await api.get<AssistantActivityResponse>('/customer-assistant/activity')),
}
