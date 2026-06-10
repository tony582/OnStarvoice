import 'dotenv/config';
import { initDb, closeDb, getDefaultTenantId, queryOne, withTransaction } from '../db/init.js';
import { hashPassword, normalizeEmail } from '../services/auth-service.js';

async function main() {
  const [, , emailRaw, password, nameRaw = 'Platform Admin'] = process.argv;
  const email = normalizeEmail(emailRaw);
  if (!email || !password || password.length < 8) {
    console.error('Usage: node scripts/create-platform-admin.js <email> <password>=8+ [name]');
    process.exit(1);
  }

  await initDb();
  const tenantId = await getDefaultTenantId();
  const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    throw new Error(`User already exists: ${email}`);
  }

  const user = await withTransaction(async tx => {
    const created = await tx.queryOne(`
      INSERT INTO users (email, name, password_hash, status, is_internal, global_role, must_change_password)
      VALUES ($1, $2, $3, 'active', true, 'platform_admin', false)
      RETURNING id
    `, [email, nameRaw, hashPassword(password)]);
    await tx.execute(`
      INSERT INTO user_memberships (user_id, tenant_id, role, status)
      VALUES ($1, $2, 'tenant_admin', 'active')
    `, [created.id, tenantId]);
    await tx.execute(`
      INSERT INTO password_events (user_id, event_type, metadata)
      VALUES ($1, 'created', $2::jsonb)
    `, [created.id, JSON.stringify({ cli: true })]);
    return created;
  });

  console.log(`Created platform_admin ${email} (${user.id})`);
  await closeDb();
}

main().catch(async err => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
