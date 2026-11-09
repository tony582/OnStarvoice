export function wechatArticleData(record?: Record<string, unknown>): Record<string, unknown>
export function wechatArticleMetric(record: Record<string, unknown>, field: string): string
export function wechatArticlePresentation(record?: Record<string, unknown>, capturedComments?: number): {
  bodyStatus: string; bodyLabel: string; bodyDescription: string; metricNotice: string;
  commentStatus: string; commentTitle: string; commentDescription: string; postingNote: string; commentTab: string;
}
