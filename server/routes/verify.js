import { Router } from 'express';
import { execute, getTenantByAuthCode, withTransaction } from '../db/init.js';
import crypto from 'crypto';
import { issueCaptureAgentCredential } from '../services/capture-cloud.js';

const router = Router();

// 轻量 IP 限流:/api/verify 是公开接口,防被刷(枚举激活码 / 消耗绑定名额)。
const VERIFY_RATE = { windowMs: 60000, max: 20 };
const verifyHits = new Map(); // ip -> { count, resetAt }
function verifyRateLimited(ip) {
  const key = String(ip || 'unknown');
  const now = Date.now();
  const entry = verifyHits.get(key);
  if (!entry || now > entry.resetAt) {
    verifyHits.set(key, { count: 1, resetAt: now + VERIFY_RATE.windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > VERIFY_RATE.max;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of verifyHits) if (now > entry.resetAt) verifyHits.delete(key);
}, 5 * 60000).unref?.();

/**
 * POST /api/verify
 * 验证激活码，处理环境绑定
 */
router.post('/', async (req, res, next) => {
  try {
    if (verifyRateLimited(req.ip)) {
      return res.status(429).json({ ok: false, reason: 'rate_limited', message: '请求过于频繁,请稍后再试' });
    }
    const {
      code,
      authCode,
      fingerprint = '',
      userAgent = '',
      clientUuid = '',
      clientLabel = '',
      appVersion = '',
    } = req.body || {};
    const resolvedCode = String(code || authCode || '').trim();
    const resolvedFingerprint = String(fingerprint || clientUuid || '').trim();
    const resolvedUserAgent = String(userAgent || clientLabel || '').trim();
    const resolvedAppVersion = String(appVersion || '').trim();

    if (!resolvedCode) {
      return res.json({ ok: false, reason: 'invalid_request', message: '缺少激活码' });
    }
    if (
      resolvedCode.length > 256 ||
      resolvedFingerprint.length > 240 ||
      resolvedUserAgent.length > 1000 ||
      resolvedAppVersion.length > 80
    ) {
      return res.status(400).json({
        ok: false,
        reason: 'invalid_request',
        message: '验证参数长度不合法，请刷新扩展后重试',
      });
    }

    const codeRow = await getTenantByAuthCode(resolvedCode);

    if (!codeRow) {
      return res.json({ ok: false, reason: 'verify_failed', message: '激活码不存在，请检查后重试' });
    }

    if (codeRow.status === 'frozen') {
      return res.json({ ok: false, reason: 'frozen', message: '激活码已被冻结，请联系管理员' });
    }

    if (codeRow.status === 'expired' || (codeRow.expires_at && new Date(codeRow.expires_at) < new Date())) {
      if (codeRow.status !== 'expired') {
        await execute("UPDATE auth_codes SET status = 'expired' WHERE id = $1", [codeRow.id]);
      }
      return res.json({ ok: false, reason: 'expired', message: '激活码已过期，请续费或联系管理员获取新激活码' });
    }

    // 无显式指纹时不再随机生成(否则每次请求都建新绑定、刷爆名额);
    // 改按 IP+UA 派生稳定指纹 —— 同源重复请求复用同一绑定,正常带 clientUuid 的客户端不受影响。
    const fp =
      resolvedFingerprint ||
      'anon:' +
        crypto
          .createHash('sha256')
          .update(`${req.ip || ''}|${resolvedUserAgent || ''}`)
          .digest('hex')
          .slice(0, 32);
    const bindingResult = await withTransaction(async tx => {
      // Serialize quota allocation per activation code. Two browser profiles
      // verifying at the same time can no longer both pass COUNT and exceed the
      // environment limit (or race the same fingerprint unique constraint).
      const lockedCode = await tx.queryOne(`
        SELECT id, status, expires_at, max_bindings
        FROM auth_codes WHERE id = $1
        FOR UPDATE
      `, [codeRow.id]);
      if (!lockedCode) return {error: 'verify_failed'};
      if (lockedCode.status === 'frozen') return {error: 'frozen'};
      if (
        lockedCode.status === 'expired' ||
        (lockedCode.expires_at && new Date(lockedCode.expires_at) < new Date())
      ) {
        return {error: 'expired'};
      }

      let binding = await tx.queryOne(
        'SELECT * FROM auth_bindings WHERE code_id = $1 AND fingerprint = $2',
        [codeRow.id, fp],
      );
      if (binding) {
        binding = await tx.queryOne(`
          UPDATE auth_bindings
          SET last_seen_at = now(), user_agent = $1
          WHERE id = $2
          RETURNING *
        `, [resolvedUserAgent, binding.id]);
      } else {
        const bindingCount = Number((await tx.queryOne(
          'SELECT COUNT(*) AS count FROM auth_bindings WHERE code_id = $1',
          [codeRow.id],
        ))?.count || 0);
        if (bindingCount >= lockedCode.max_bindings) {
          return {
            error: 'binding_limit_reached',
            bindingCount,
            maxBindings: lockedCode.max_bindings,
          };
        }
        binding = await tx.queryOne(`
          INSERT INTO auth_bindings (code_id, fingerprint, user_agent)
          VALUES ($1, $2, $3)
          RETURNING *
        `, [codeRow.id, fp, resolvedUserAgent]);
      }
      const currentBindings = Number((await tx.queryOne(
        'SELECT COUNT(*) AS count FROM auth_bindings WHERE code_id = $1',
        [codeRow.id],
      ))?.count || 0);
      return {binding, currentBindings};
    });
    if (bindingResult.error === 'binding_limit_reached') {
      return res.json({
        ok: false,
        reason: 'binding_limit_reached',
        message: `当前激活码最多绑定 ${bindingResult.maxBindings} 个环境，已达上限`,
        bindingCount: bindingResult.bindingCount,
        maxBindings: bindingResult.maxBindings,
      });
    }
    if (bindingResult.error) {
      const messages = {
        verify_failed: '激活码不存在，请检查后重试',
        frozen: '激活码已被冻结，请联系管理员',
        expired: '激活码已过期，请续费或联系管理员获取新激活码',
      };
      return res.json({ok: false, reason: bindingResult.error, message: messages[bindingResult.error]});
    }
    const binding = bindingResult.binding;

    let daysRemaining = null;
    if (codeRow.expires_at) {
      const diff = new Date(codeRow.expires_at) - new Date();
      daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    }

    // 绑定数随上面的 upsert 变化,重新查一次回传 —— 侧栏「环境绑定数占用」要显示真实占用,
    // 否则只拿到 maxBindings、currentBindings 缺失会恒显示 0。
    const currentBindings = bindingResult.currentBindings;
    const captureAgent = await issueCaptureAgentCredential({
      tenantId: codeRow.tenant_id,
      authCodeId: codeRow.id,
      authBindingId: binding?.id || null,
      clientUuid: resolvedFingerprint || fp,
      clientLabel: resolvedUserAgent,
      appVersion: resolvedAppVersion,
      userAgent: req.headers['user-agent'] || '',
    });

    return res.json({
      ok: true,
      credential: {
        code: codeRow.code,
        type: codeRow.type,
        status: codeRow.status,
        ownerEmail: codeRow.owner_email,
        ownerName: codeRow.owner_name,
        expiresAt: codeRow.expires_at,
        daysRemaining,
        maxBindings: codeRow.max_bindings,
        currentBindings,
      },
      user: { email: codeRow.owner_email, name: codeRow.owner_name },
      tenant: { id: codeRow.tenant_id, name: codeRow.tenant_name },
      captureAgent,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
