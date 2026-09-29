export type PublishTimeShape = {
  kind: 'empty' | 'exact' | 'date' | 'relative_time' | 'relative_day' | 'other'
  precision: '' | 'second' | 'minute'
  edited: boolean
  text: string
}

export type TilePresentation = { value: string; hint: string }

export function classifyPublishTimeText(raw: unknown): PublishTimeShape

export function publishTimePresentation(record?: {
  publish_time?: unknown
  published_ts?: unknown
  publish_display?: unknown
} | null): TilePresentation

export function captureKeywordPresentation(keyword: unknown, discoveryKeywords?: unknown): TilePresentation
