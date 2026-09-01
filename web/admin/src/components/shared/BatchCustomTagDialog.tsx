import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Loader2, Plus, Search, Tags, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RecordLabelChips } from '@/components/shared/RecordLabels'
import { cn } from '@/lib/utils'
import {
  MAX_CUSTOM_TAG_NAME,
  MAX_CUSTOM_TAGS,
  type CustomTag,
} from '@/lib/custom-tags'

interface DraftTag extends CustomTag {
  pending?: boolean
}

export type BatchCustomTagMode = 'add' | 'remove'

export interface BatchCustomTagValues {
  addTagIds: string[]
  addNames: string[]
  removeTagIds: string[]
}

const MAX_BATCH_REMOVE_TAGS = 20

export function BatchCustomTagDialog({
  mode,
  count,
  catalog,
  onSearch,
  onApply,
  onCancel,
}: {
  mode: BatchCustomTagMode
  count: number
  catalog: CustomTag[]
  onSearch?: (query: string) => void
  onApply: (values: BatchCustomTagValues) => Promise<void>
  onCancel: () => void
}) {
  const [selected, setSelected] = useState<DraftTag[]>([])
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const queryName = cleanName(query)
  const normalizedQuery = normalizeName(queryName)
  const selectedNames = useMemo(
    () => new Set(selected.map(tag => normalizeName(tag.name))),
    [selected],
  )
  const filteredCatalog = catalog.filter(tag => (
    !normalizedQuery || normalizeName(tag.name).includes(normalizedQuery)
  ))
  const exactCatalogTag = catalog.find(tag => normalizeName(tag.name) === normalizedQuery)
  const canCreate = Boolean(
    mode === 'add'
    && normalizedQuery
    && !exactCatalogTag
    && !selectedNames.has(normalizedQuery)
    && [...queryName].length <= MAX_CUSTOM_TAG_NAME,
  )
  const selectionLimit = mode === 'remove' ? MAX_BATCH_REMOVE_TAGS : MAX_CUSTOM_TAGS
  const atLimit = selected.length >= selectionLimit

  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (mode !== 'add' || !onSearch) return
    const timer = window.setTimeout(() => onSearch(queryName), 250)
    return () => window.clearTimeout(timer)
  }, [mode, onSearch, queryName])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel, saving])

  const toggleCatalogTag = (tag: CustomTag) => {
    if (saving) return
    setError('')
    setSelected(current => {
      if (current.some(item => item.id === tag.id)) {
        return current.filter(item => item.id !== tag.id)
      }
      if (current.length >= selectionLimit) return current
      return [...current, tag]
    })
  }

  const addFromInput = () => {
    if (mode !== 'add' || !queryName || saving) return
    if ([...queryName].length > MAX_CUSTOM_TAG_NAME) {
      setError(`单个标签不能超过 ${MAX_CUSTOM_TAG_NAME} 个字`)
      return
    }
    if (atLimit) {
      setError(`单次最多选择或新建 ${selectionLimit} 个标签`)
      return
    }
    if (selectedNames.has(normalizedQuery)) {
      setQuery('')
      return
    }
    if (exactCatalogTag) {
      toggleCatalogTag(exactCatalogTag)
      setQuery('')
      return
    }
    setSelected(current => [
      ...current,
      { id: `new:${normalizedQuery}`, name: queryName, pending: true },
    ])
    setQuery('')
    setError('')
  }

  const apply = useCallback(async () => {
    if (!selected.length || saving) return
    setSaving(true)
    setError('')
    try {
      await onApply(mode === 'remove'
        ? {
          addTagIds: [],
          addNames: [],
          removeTagIds: selected.map(tag => tag.id),
        }
        : {
          addTagIds: selected.filter(tag => !tag.pending).map(tag => tag.id),
          addNames: selected.filter(tag => tag.pending).map(tag => tag.name),
          removeTagIds: [],
        })
      onCancel()
    } catch (err) {
      setError(err instanceof Error
        ? err.message
        : `批量${mode === 'remove' ? '移除' : '添加'}标签失败，请稍后重试`)
    } finally {
      setSaving(false)
    }
  }, [mode, onApply, onCancel, saving, selected])

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4 animate-in fade-in duration-150"
      onMouseDown={() => { if (!saving) onCancel() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-custom-tag-title"
        className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl sm:rounded-xl animate-in zoom-in-95 duration-150"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-border px-4 py-4 sm:px-5">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Tags className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 id="batch-custom-tag-title" className="text-sm font-bold">
              {mode === 'remove' ? '批量移除自定义标签' : '批量添加自定义标签'}
            </h3>
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
              {mode === 'remove'
                ? `从 ${count} 条内容中解除所选标签关联；标签选项和其他内容不受影响。`
                : `将选中的标签添加到 ${count} 条内容；原有标签不会被移除。`}
            </p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={onCancel}
            aria-label={`关闭批量${mode === 'remove' ? '移除' : '添加'}标签`}
            className="ml-auto rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {selected.length > 0 ? (
            <RecordLabelChips
              tags={selected}
              removable
              disabled={saving}
              onRemove={tag => setSelected(current => current.filter(item => item.id !== tag.id))}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-border px-3 py-2.5 text-[11px] text-muted-foreground">
              {mode === 'remove'
                ? '先从下方选择要解除关联的标签。'
                : '先从下方选择已有标签，或输入名称新建标签。'}
            </div>
          )}

          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              disabled={saving}
              onChange={event => {
                setQuery(event.target.value)
                if (error) setError('')
              }}
              onKeyDown={event => {
                if (mode === 'add' && event.key === 'Enter') {
                  event.preventDefault()
                  addFromInput()
                }
              }}
              placeholder={mode === 'remove' ? '搜索要移除的标签…' : '搜索或输入新标签，回车添加…'}
              className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-10 text-[12px] outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-60"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="清空标签搜索"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-background p-1">
            {canCreate && (
              <button
                type="button"
                disabled={atLimit || saving}
                onClick={addFromInput}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] font-semibold text-primary transition hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="min-w-0 truncate">新建并添加“{queryName}”</span>
              </button>
            )}
            {filteredCatalog.length === 0 && !canCreate ? (
              <div className="px-3 py-8 text-center text-[11px] text-muted-foreground">
                {catalog.length
                  ? '没有匹配的标签'
                  : mode === 'remove'
                    ? '所选内容暂无可移除标签'
                    : '暂无可复用标签，可直接输入新标签'}
              </div>
            ) : filteredCatalog.map(tag => {
              const checked = selected.some(item => item.id === tag.id)
              return (
                <button
                  key={tag.id}
                  type="button"
                  disabled={saving || (!checked && atLimit)}
                  onClick={() => toggleCatalogTag(tag)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] transition hover:bg-accent disabled:pointer-events-none disabled:opacity-40',
                    checked && 'bg-accent/70',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{tag.name}</span>
                  {Number(tag.usageCount || 0) > 0 && (
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {mode === 'remove' ? '已关联 ' : ''}
                      {Number(tag.usageCount).toLocaleString('zh-CN')}
                      {mode === 'remove' ? ' 条' : ''}
                    </span>
                  )}
                  <span className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                  )}>
                    {checked && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="mt-2 flex items-start justify-between gap-3 text-[10.5px] text-muted-foreground">
            <span>
              {mode === 'remove'
                ? '只解除已存在的关联；没有该标签的内容保持不变。'
                : `若某条内容添加后超过 ${MAX_CUSTOM_TAGS} 个标签，该条会跳过并单独提示。`}
            </span>
            <span className={cn('shrink-0 font-semibold tabular-nums', atLimit && 'text-amber-600 dark:text-amber-300')}>
              {selected.length}/{selectionLimit}
            </span>
          </div>
          {error && <p className="mt-2 text-[11px] font-medium text-destructive" role="alert">{error}</p>}
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex sm:justify-end sm:px-5">
          <Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>取消</Button>
          <Button
            variant={mode === 'remove' ? 'destructive' : 'default'}
            size="sm"
            disabled={!selected.length || saving}
            onClick={() => void apply()}
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {mode === 'remove' ? `从 ${count} 条内容移除` : `添加到 ${count} 条内容`}
          </Button>
        </div>
      </div>
    </div>
  )
}

function cleanName(value: string): string {
  return value.normalize('NFKC').trim().replace(/^#+\s*/u, '').replace(/\s+/gu, ' ')
}

function normalizeName(value: string): string {
  return cleanName(value).toLocaleLowerCase('zh-CN')
}
