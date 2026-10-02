import {DiscoveryError} from './validation.js';

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

// The copied link is the work's identity: the record's platform and work ID must equal the candidate
// resolved from that link (detail-receipt.js; repository.js looks the record up by it). The caption
// is not compared: titleHint is the search card's text, kept for display only (2026-10-02). Two cheap
// cross-checks remain against the browser's actual record, inside the formal ingestion transaction:
// the publisher shown on the card and the media kind seen on the phone.
export function matchesUiBoundRecord(event, record) {
  if (event.verification !== 'ui_bound') return true;
  const kind = String(record?.url || '').match(/douyin\.com\/(note|video)\/\d{16,22}/)?.[1];
  return !!author(event.authorHint) && !!event.uiBinding
    && kind === event.uiBinding.kind && author(record?.author_name) === author(event.authorHint);
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
