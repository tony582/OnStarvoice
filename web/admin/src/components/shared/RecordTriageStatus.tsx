import { triageDisplay, type TriageDisplayRecord } from '@/lib/triage-display'
import { StatusBadge } from '@/components/ui/badge'
import { Tooltip } from './Tooltip'

export function RecordTriageStatus({ record, className }: { record: TriageDisplayRecord; className?: string }) {
  const display = triageDisplay(record)
  const badge = <StatusBadge tone={display.status} className={className}>{display.label}</StatusBadge>
  return display.reason ? <Tooltip text={display.reason}>{badge}</Tooltip> : badge
}
