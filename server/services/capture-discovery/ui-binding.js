import {DiscoveryError} from './validation.js';

const caption = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, '');
// The existing PC collector removes one leading @ from the publisher name.
// Match that presentation rule without changing the raw mobile evidence or
// stripping internal @ signs, emoji, or any other nickname characters.
const author = value => String(value ?? '').normalize('NFC').trim().replace(/^@\s*/u, '');
export function normalizeUiBinding(input) {
  if (!input || !['douyin-30.6.0-de106-api27-p0','douyin-40.6.0-de106-api27-p0'].includes(input.profileId)
      || !/^[a-f0-9]{64}$/.test(input.cardId) || !['note','video'].includes(input.kind)) {
    throw new DiscoveryError('INVALID_UI_BINDING');
  }
  return {profileId:input.profileId, cardId:input.cardId, kind:input.kind};
}

// Never use the copied share caption as independent evidence. This comparison
// runs against the browser's actual record, within the formal ingestion transaction.
export function matchesUiBoundRecord(event, record) {
  if (event.verification !== 'ui_bound') return true;
  const expected = caption(event.titleHint);
  const kind = String(record?.url || '').match(/douyin\.com\/(note|video)\/\d{16,22}/)?.[1];
  return !!expected && !!author(event.authorHint) && !!event.uiBinding
    && kind === event.uiBinding.kind && author(record?.author_name) === author(event.authorHint)
    && [record?.title, record?.content].some(value => caption(value) === expected);
}

export async function assertUiBoundIngestion(tx, {tenantId, candidateId, record}) {
  const rows = await tx.queryAll(`SELECT event.payload FROM capture_discovery_run_candidates demand
    JOIN capture_discovery_events event ON event.task_id=demand.run_id AND event.candidate_id=demand.candidate_id AND event.tenant_id=demand.tenant_id
    WHERE demand.tenant_id=$1 AND demand.candidate_id=$2
      AND demand.demand_status IN ('active','fulfilled','needs_action') AND event.verification='ui_bound' AND event.delivery_mode='normal'
    LIMIT 101`, [tenantId, candidateId]);
  if (rows.length > 100 || rows.some(row => !matchesUiBoundRecord(row.payload, record))) {
    throw new DiscoveryError('DISCOVERY_DETAIL_IDENTITY_MISMATCH', 409);
  }
}
