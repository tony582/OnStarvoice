export function FollowedCreatorBadge({ label }: { label?: string | null }) {
  if (!label) return null
  return <span title={`关注博主 · ${label}`} className="inline-flex max-w-48 items-center truncate rounded-full border border-teal-500/40 bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-800 dark:bg-teal-950 dark:text-teal-200">
    关注博主 · {label}
  </span>
}
