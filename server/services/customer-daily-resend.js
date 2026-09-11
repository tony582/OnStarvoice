import {randomUUID} from 'node:crypto';
import {dailyError} from './customer-daily-report-config.js';

export function validateDailyResend(resendOf) {
  if (resendOf !== undefined && (typeof resendOf !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resendOf))) {
    throw dailyError('请刷新日报后再次发送。',400,'daily_resend_invalid');
  }
}

// The caller holds the delivery row lock. Rotate the external send identity only
// for the success the user actually saw; replayed requests cannot send again.
export async function requeueDailySuccess(tx,{table,tenantId,reportId,resendOf,targetKey,actorId = ''}) {
  if (!['customer_daily_deliveries','customer_daily_email_deliveries'].includes(table)) throw new Error('Invalid delivery table');
  validateDailyResend(resendOf);
  if (!resendOf) return false;
  const row = await tx.queryOne(`SELECT * FROM ${table} WHERE tenant_id=$1 AND report_id=$2 AND id=$3 FOR UPDATE`,[tenantId,reportId,resendOf]);
  if (!row || row.status !== 'sent' || row.ambiguous) return false;
  if (table === 'customer_daily_deliveries' && row.target_key !== targetKey) return false;
  const nextId = randomUUID();
  await tx.execute(`INSERT INTO audit_logs (tenant_id,actor_type,actor_id,action,target_type,target_id,metadata)
    VALUES ($1,'user',$2,'customer_daily_resend','customer_daily_report',$3,$4::jsonb)`,
  [tenantId,actorId,reportId,JSON.stringify({channel:table === 'customer_daily_deliveries' ? 'feishu' : 'email',
    previousDeliveryId:row.id,nextDeliveryId:nextId,messageId:row.message_id,sentAt:row.sent_at,
    recipients:row.recipients || null,targetKey:row.target_key || null,attempts:row.attempts})]);
  await tx.execute(`UPDATE ${table} SET id=$4,status='queued',message_id=NULL,sent_at=NULL,error_message=NULL,
    claim_token=NULL,claimed_at=NULL,attempts=0,updated_at=now()
    ${table === 'customer_daily_deliveries' ? ',next_attempt_at=now(),automatic=false' : ''}
    WHERE tenant_id=$1 AND report_id=$2 AND id=$3 AND status='sent' AND NOT ambiguous`,[tenantId,reportId,resendOf,nextId]);
  return true;
}
