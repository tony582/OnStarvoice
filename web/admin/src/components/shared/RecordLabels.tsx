import { useMemo, useState } from 'react'
import { Check, Loader2, Plus, Search, Tag, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  MAX_CUSTOM_TAG_NAME, MAX_CUSTOM_TAGS,
  type CustomTag, type CustomTagPatch,
} from '@/lib/custom-tags'

interface DraftTag extends CustomTag {
  pending?: boolean
}

const TAG_TONES = [
  {
    chip: 'bg-sky-500/10 text-sky-700 ring-sky-500/15 dark:text-sky-300',
    dot: 'bg-sky-500',
  },
  {
    chip: 'bg-violet-500/10 text-violet-700 ring-violet-500/15 dark:text-violet-300',
    dot: 'bg-violet-500',
  },
  {
    chip: 'bg-teal-500/10 text-teal-700 ring-teal-500/15 dark:text-teal-300',
    dot: 'bg-teal-500',
  },
  {
    chip: 'bg-amber-500/12 text-amber-700 ring-amber-500/20 dark:text-amber-300',
    dot: 'bg-amber-500',
  },
  {
    chip: 'bg-rose-500/10 text-rose-700 ring-rose-500/15 dark:text-rose-300',
    dot: 'bg-rose-500',
  },
  {
    chip: 'bg-slate-500/10 text-slate-600 ring-slate-500/15 dark:text-slate-300',
    dot: 'bg-slate-500',
  },
]

export function RecordLabelChips({
  tags,
  limit,
  compact = false,
  removable = false,
  disabled = false,
  onRemove,
  className,
}: {
  tags: CustomTag[]
  limit?: number
  compact?: boolean
  removable?: boolean
  disabled?: boolean
  onRemove?: (tag: CustomTag) => void
  className?: string
}) {
  const visible = limit === undefined ? tags : tags.slice(0, limit)
  const hidden = Math.max(0, tags.length - visible.length)

  if (tags.length === 0) return null

  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
      {visible.map(tag => {
        const tone = toneForTag(tag)
        return (
          <span
            key={tag.id}
            title={tag.name}
            className={cn(
              'inline-flex min-w-0 items-center gap-1 rounded-md font-semibold ring-1 ring-inset',
              compact ? 'max-w-28 px-1.5 py-0.5 text-[10px]' : 'max-w-44 px-2 py-1 text-[11px]',
              tone.chip,
            )}
          >
            <span className="truncate">{tag.name}</span>
            {removable && onRemove && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRemove(tag)}
                aria-label={`移除标签 ${tag.name}`}
                className="-mr-0.5 shrink-0 rounded p-0.5 opacity-60 transition hover:bg-black/5 hover:opacity-100 disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-white/10"
              >
                <X className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
              </button>
            )}
          </span>
        )
      })}
      {hidden > 0 && (
        <span
          title={tags.slice(visible.length).map(tag => tag.name).join('、')}
          className={cn(
            'rounded-md bg-muted font-semibold text-muted-foreground',
            compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]',
          )}
        >
          +{hidden}
        </span>
      )}
    </div>
  )
}

export function RecordLabelEditor({
  initialTags,
  catalog,
  onSave,
  onDeleteCatalogTag,
  onCancel,
  onSavingChange,
}: {
  initialTags: CustomTag[]
  catalog: CustomTag[]
  onSave: (patch: CustomTagPatch) => Promise<CustomTag[]>
  onDeleteCatalogTag?: (tag: CustomTag) => Promise<number>
  onCancel: () => void
  onSavingChange?: (saving: boolean) => void
}) {
  const [draft, setDraft] = useState<DraftTag[]>(() => initialTags.map(tag => ({ ...tag })))
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingTagId, setDeletingTagId] = useState('')
  const [removingTagId, setRemovingTagId] = useState('')
  const [globallyDeletedTagIds, setGloballyDeletedTagIds] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState('')

  const mergedCatalog = useMemo(() => {
    const byId = new Map<string, CustomTag>()
    // 目录里的 usageCount 比记录上的精简标签更完整，因此同 ID 时以目录数据为准。
    for (const tag of [...initialTags, ...catalog]) {
      if (!globallyDeletedTagIds.has(tag.id)) byId.set(tag.id, tag)
    }
    return [...byId.values()].sort((a, b) =>
      Number(b.usageCount || 0) - Number(a.usageCount || 0) || a.name.localeCompare(b.name, 'zh-CN'))
  }, [catalog, globallyDeletedTagIds, initialTags])

  const normalizedQuery = normalizeName(query)
  const filteredCatalog = mergedCatalog.filter(tag =>
    !normalizedQuery || normalizeName(tag.name).includes(normalizedQuery))
  const exactCatalogTag = mergedCatalog.find(tag => normalizeName(tag.name) === normalizedQuery)
  const exactDraftTag = draft.find(tag => normalizeName(tag.name) === normalizedQuery)
  const canCreate = Boolean(normalizedQuery && !exactCatalogTag && !exactDraftTag)
  const initialIds = useMemo(() => new Set(
    initialTags.filter(tag => !globallyDeletedTagIds.has(tag.id)).map(tag => tag.id),
  ), [globallyDeletedTagIds, initialTags])
  const draftExistingIds = draft.filter(tag => !tag.pending).map(tag => tag.id)
  const draftPendingNames = draft.filter(tag => tag.pending).map(tag => tag.name)
  const addTagIds = draftExistingIds.filter(id => !initialIds.has(id))
  const removeTagIds = initialTags
    .filter(tag => !globallyDeletedTagIds.has(tag.id) && !draftExistingIds.includes(tag.id))
    .map(tag => tag.id)
  const changed = addTagIds.length > 0 || removeTagIds.length > 0 || draftPendingNames.length > 0
  const atLimit = draft.length >= MAX_CUSTOM_TAGS
  const busy = saving || Boolean(deletingTagId) || Boolean(removingTagId)

  const toggleCatalogTag = (tag: CustomTag) => {
    setError('')
    setDraft(current => {
      const selected = current.some(item => item.id === tag.id)
      if (selected) return current.filter(item => item.id !== tag.id)
      if (current.length >= MAX_CUSTOM_TAGS) return current
      return [...current, { ...tag }]
    })
  }

  const addFromInput = () => {
    const name = query.trim()
    if (!name) return
    if (name.length > MAX_CUSTOM_TAG_NAME) {
      setError(`单个标签不能超过 ${MAX_CUSTOM_TAG_NAME} 个字`)
      return
    }
    if (atLimit) {
      setError(`每条内容最多添加 ${MAX_CUSTOM_TAGS} 个标签`)
      return
    }
    if (exactDraftTag) {
      setQuery('')
      return
    }
    if (exactCatalogTag) {
      toggleCatalogTag(exactCatalogTag)
      setQuery('')
      return
    }
    const normalized = normalizeName(name)
    setDraft(current => [
      ...current,
      { id: `new:${normalized}`, name, pending: true },
    ])
    setQuery('')
    setError('')
  }

  const save = async () => {
    if (!changed || busy) return
    setSaving(true)
    onSavingChange?.(true)
    setError('')
    try {
      await onSave({
        addTagIds,
        addNames: draftPendingNames,
        removeTagIds,
      })
      onCancel()
    } catch (err) {
      setError(err instanceof Error ? err.message : '标签保存失败，请稍后重试')
    } finally {
      setSaving(false)
      onSavingChange?.(false)
    }
  }

  const deleteCatalogTag = async (tag: CustomTag) => {
    if (!onDeleteCatalogTag || busy) return
    const affectedRecords = Math.max(0, Number(tag.usageCount || 0))
    const message = affectedRecords > 0
      ? `确定删除标签“${tag.name}”吗？这会删除整个标签选项，并从已关联的 ${affectedRecords.toLocaleString('zh-CN')} 条内容中移除；内容本身不会被删除。`
      : `确定删除标签“${tag.name}”吗？这会删除整个标签选项，之后将无法再选择它。`
    if (!window.confirm(message)) return

    setDeletingTagId(tag.id)
    onSavingChange?.(true)
    setError('')
    try {
      await onDeleteCatalogTag(tag)
      setGloballyDeletedTagIds(current => new Set([...current, tag.id]))
      setDraft(current => current.filter(item => item.id !== tag.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除标签失败，请稍后重试')
    } finally {
      setDeletingTagId('')
      onSavingChange?.(false)
    }
  }

  const removeCurrentRecordTag = async (tag: DraftTag) => {
    if (busy) return
    if (tag.pending || !initialIds.has(tag.id)) {
      setDraft(current => current.filter(item => item.id !== tag.id))
      setError('')
      return
    }

    if (!window.confirm(`确定从当前这条内容中移除标签“${tag.name}”吗？标签选项仍会保留，其他内容不受影响。`)) {
      return
    }

    setRemovingTagId(tag.id)
    onSavingChange?.(true)
    setError('')
    try {
      await onSave({ addTagIds: [], addNames: [], removeTagIds: [tag.id] })
      // 这里只解除当前内容的关联；目录中的标签选项和其他内容保持不变。
      setDraft(current => current.filter(item => item.id !== tag.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : '移除当前内容标签失败，请稍后重试')
    } finally {
      setRemovingTagId('')
      onSavingChange?.(false)
    }
  }

  return (
    <div className="mt-2 rounded-xl border border-border bg-background/80 p-3 shadow-sm animate-in fade-in slide-in-from-top-1 duration-150">
      <div className="flex items-start gap-2">
        <div>
          <div className="text-[12px] font-bold text-foreground">管理自定义标签</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            上方 × 只从当前内容移除；下方垃圾桶删除整个标签选项。
          </div>
        </div>
        <span className={cn('ml-auto text-[10.5px] font-semibold tabular-nums', atLimit ? 'text-amber-600 dark:text-amber-300' : 'text-muted-foreground')}>
          {draft.length}/{MAX_CUSTOM_TAGS}
        </span>
      </div>

      {draft.length > 0 ? (
        <RecordLabelChips
          tags={draft}
          removable
          disabled={busy}
          onRemove={tag => void removeCurrentRecordTag(tag)}
          className="mt-3"
        />
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
          暂无标签，从下方选择或创建。
        </div>
      )}

      <div className="relative mt-3">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          maxLength={MAX_CUSTOM_TAG_NAME}
          disabled={busy}
          onChange={event => {
            setQuery(event.target.value)
            if (error) setError('')
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addFromInput()
            }
          }}
          placeholder="搜索或输入新标签…"
          className="h-8 w-full rounded-lg border border-border bg-card pl-8 pr-12 text-[12px] outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-60"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="清空搜索"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border border-border/70 bg-card p-1">
        {canCreate && (
          <button
            type="button"
            disabled={atLimit || busy}
            onClick={addFromInput}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] font-semibold text-primary transition hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="min-w-0 truncate">创建“{query.trim()}”</span>
          </button>
        )}
        {filteredCatalog.length === 0 && !canCreate ? (
          <div className="px-2 py-5 text-center text-[11px] text-muted-foreground">
            {mergedCatalog.length ? '没有匹配的标签' : '暂无可复用标签'}
          </div>
        ) : filteredCatalog.map(tag => {
          const selected = draft.some(item => item.id === tag.id)
          const tone = toneForTag(tag)
          return (
            <div
              key={tag.id}
              className={cn(
                'group flex w-full items-center rounded-md text-[12px] transition hover:bg-accent',
                selected && 'bg-accent/70',
              )}
            >
              <button
                type="button"
                disabled={busy || (!selected && atLimit)}
                onClick={() => toggleCatalogTag(tag)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition disabled:pointer-events-none disabled:opacity-40"
              >
                <span className="min-w-0 flex-1">
                  <span className={cn('inline-block max-w-full truncate rounded-md px-2 py-0.5 font-semibold ring-1 ring-inset', tone.chip)}>{tag.name}</span>
                </span>
                {Number(tag.usageCount || 0) > 0 && (
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{Number(tag.usageCount).toLocaleString('zh-CN')}</span>
                )}
                <span className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                  selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                )}>
                  {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
              </button>
              {onDeleteCatalogTag && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void deleteCatalogTag(tag)}
                  title={`删除整个标签选项“${tag.name}”`}
                  aria-label={`删除整个标签选项 ${tag.name}`}
                  className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 opacity-70 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-40"
                >
                  {deletingTagId === tag.id
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {error && <p className="mt-2 text-[11px] font-medium text-destructive">{error}</p>}
      {!error && atLimit && <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-300">已达到每条内容的标签上限。</p>}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>取消</Button>
        <Button size="sm" onClick={save} disabled={!changed || busy}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          保存标签
        </Button>
      </div>
    </div>
  )
}

export function RecordLabelsHeading() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-muted-foreground">
      <Tag className="h-3 w-3" />自定义标签
    </span>
  )
}

function toneForTag(tag: Pick<CustomTag, 'id' | 'name'>) {
  const input = `${tag.id}:${tag.name}`
  let hash = 0
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0
  }
  return TAG_TONES[Math.abs(hash) % TAG_TONES.length]
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN')
}
