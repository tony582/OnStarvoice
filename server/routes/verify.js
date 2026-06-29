import { Router } from 'express';
import { queryOne, execute, getTenantByAuthCode } from '../db/init.js';
import crypto from 'crypto';

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
    const { code, authCode, fingerprint = '', userAgent = '', clientUuid = '', clientLabel = '' } = req.body;
    const resolvedCode = code || authCode;
    const resolvedFingerprint = fingerprint || clientUuid;
    const resolvedUserAgent = userAgent || clientLabel;

    if (!resolvedCode) {
      return res.json({ ok: false, reason: 'invalid_request', message: '缺少激活码' });
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
    const existingBinding = await queryOne(
      'SELECT * FROM auth_bindings WHERE code_id = $1 AND fingerprint = $2',
      [codeRow.id, fp]
    );

    if (existingBinding) {
      await execute(
        'UPDATE auth_bindings SET last_seen_at = now(), user_agent = $1 WHERE id = $2',
        [resolvedUserAgent, existingBinding.id]
      );
    } else {
      const bindingCount = (await queryOne(
        'SELECT COUNT(*) as count FROM auth_bindings WHERE code_id = $1',
        [codeRow.id]
      )).count;

      if (bindingCount >= codeRow.max_bindings) {
        return res.json({
          ok: false,
          reason: 'binding_limit_reached',
          message: `当前激活码最多绑定 ${codeRow.max_bindings} 个环境，已达上限`,
          bindingCount,
          maxBindings: codeRow.max_bindings,
        });
      }

      await execute(
        'INSERT INTO auth_bindings (code_id, fingerprint, user_agent) VALUES ($1, $2, $3)',
        [codeRow.id, fp, resolvedUserAgent]
      );
    }

    let daysRemaining = null;
    if (codeRow.expires_at) {
      const diff = new Date(codeRow.expires_at) - new Date();
      daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    }

    // 绑定数随上面的 upsert 变化,重新查一次回传 —— 侧栏「环境绑定数占用」要显示真实占用,
    // 否则只拿到 maxBindings、currentBindings 缺失会恒显示 0。
    const currentBindings = Number(
      (await queryOne('SELECT COUNT(*) as count FROM auth_bindings WHERE code_id = $1', [codeRow.id]))
        ?.count || 0
    );

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
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
