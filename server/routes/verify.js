import { Router } from 'express';
import { queryOne, execute } from '../db/init.js';
import crypto from 'crypto';

const router = Router();

/**
 * POST /api/verify
 * 验证激活码，处理环境绑定
 */
router.post('/', (req, res) => {
  const { code, authCode, fingerprint = '', userAgent = '', clientUuid = '', clientLabel = '' } = req.body;
  const resolvedCode = code || authCode;
  const resolvedFingerprint = fingerprint || clientUuid;
  const resolvedUserAgent = userAgent || clientLabel;

  if (!resolvedCode) {
    return res.json({ ok: false, reason: 'invalid_request', message: '缺少激活码' });
  }

  const codeRow = queryOne('SELECT * FROM auth_codes WHERE code = ?', [resolvedCode]);

  if (!codeRow) {
    return res.json({ ok: false, reason: 'verify_failed', message: '激活码不存在，请检查后重试' });
  }

  if (codeRow.status === 'frozen') {
    return res.json({ ok: false, reason: 'frozen', message: '激活码已被冻结，请联系管理员' });
  }

  if (codeRow.status === 'expired' || (codeRow.expires_at && new Date(codeRow.expires_at) < new Date())) {
    if (codeRow.status !== 'expired') {
      execute("UPDATE auth_codes SET status = 'expired' WHERE id = ?", [codeRow.id]);
    }
    return res.json({ ok: false, reason: 'expired', message: '激活码已过期，请续费或联系管理员获取新激活码' });
  }

  // 处理环境绑定
  const fp = resolvedFingerprint || crypto.randomUUID();
  const existingBinding = queryOne(
    'SELECT * FROM auth_bindings WHERE code_id = ? AND fingerprint = ?',
    [codeRow.id, fp]
  );

  if (existingBinding) {
    execute(
      "UPDATE auth_bindings SET last_seen_at = datetime('now'), user_agent = ? WHERE id = ?",
      [resolvedUserAgent, existingBinding.id]
    );
  } else {
    const bindingCount = queryOne(
      'SELECT COUNT(*) as count FROM auth_bindings WHERE code_id = ?',
      [codeRow.id]
    ).count;

    if (bindingCount >= codeRow.max_bindings) {
      return res.json({
        ok: false, reason: 'binding_limit_reached',
        message: `当前激活码最多绑定 ${codeRow.max_bindings} 个环境，已达上限`,
        bindingCount, maxBindings: codeRow.max_bindings,
      });
    }

    execute(
      'INSERT INTO auth_bindings (code_id, fingerprint, user_agent) VALUES (?, ?, ?)',
      [codeRow.id, fp, resolvedUserAgent]
    );
  }

  let daysRemaining = null;
  if (codeRow.expires_at) {
    const diff = new Date(codeRow.expires_at) - new Date();
    daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  return res.json({
    ok: true,
    credential: {
      code: codeRow.code, type: codeRow.type, status: codeRow.status,
      ownerEmail: codeRow.owner_email, ownerName: codeRow.owner_name,
      expiresAt: codeRow.expires_at, daysRemaining, maxBindings: codeRow.max_bindings,
    },
    user: { email: codeRow.owner_email, name: codeRow.owner_name },
  });
});

export default router;
