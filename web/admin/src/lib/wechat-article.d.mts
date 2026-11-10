export function wechatArticleData(record?: Record<string, unknown>): Record<string, unknown>
export function wechatArticleMetric(record: Record<string, unknown>, field: string): string
export interface WechatArticleMetricDetail {
  key: 'read' | 'like' | 'share' | 'recommend' | 'comments'
  label: string; value: string; source: string; capturedAt: string
}
export function wechatArticleDetail(record?: Record<string, unknown>): {
  account: string; author: string; location: string; published: string; metrics: WechatArticleMetricDetail[]
}
export type WechatArticleBodyBlock = { type: 'text'; text: string } | { type: 'image'; url: string; ref: string; alt: string; layer?: 'visible' | 'interactive' }
export function wechatArticleBodyBlocks(record?: Record<string, unknown>, displayImages?: { url: string; ref: string }[]): WechatArticleBodyBlock[]
export function wechatArticlePresentation(record?: Record<string, unknown>, capturedComments?: number): {
  bodyStatus: string; bodyLabel: string; bodyDescription: string; metricNotice: string;
  commentStatus: string; commentTitle: string; commentDescription: string; postingNote: string; commentTab: string;
}
