import { useAuth } from '@/lib/auth'
import { useNav } from '@/lib/navigation'
import { CreatorRoster } from './CreatorRoster'

export function MonitorTasksTab({ onViewHits }: { onViewHits?: (subscriptionId: string) => void }) {
  const { navigate } = useNav()
  const { tenantId } = useAuth()
  return <CreatorRoster key={tenantId} onViewHits={onViewHits}
    onScan={id=>navigate('dispatch',{create:'creator_patrol',subscriptionId:id})} />
}
