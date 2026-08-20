import { queryOne } from '../db/init.js';
import { hashLlmRelayAgentToken } from '../services/llm-relay-jobs.js';

export async function requireLlmRelayAgent(req, res, next) {
  try {
    const authorization = String(req.headers.authorization || '');
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : String(req.headers['x-llm-relay-agent-token'] || '').trim();
    if (!token) {
      return res.status(401).json({
        ok: false,
        error: 'missing_llm_relay_agent_token',
        message: '缺少本机 AI Agent 令牌',
      });
    }
    const agent = await queryOne(`
      SELECT token.id, token.tenant_id, token.name, tenant.name AS tenant_name
      FROM llm_relay_agent_tokens token
      JOIN tenants tenant ON tenant.id = token.tenant_id
      WHERE token.token_hash = $1
        AND token.revoked_at IS NULL
        AND tenant.status = 'active'
      LIMIT 1
    `, [hashLlmRelayAgentToken(token)]);
    if (!agent) {
      return res.status(401).json({
        ok: false,
        error: 'invalid_llm_relay_agent_token',
        message: '本机 AI Agent 令牌无效或已撤销',
      });
    }
    req.llmRelayAgent = agent;
    req.tenantId = agent.tenant_id;
    req.tenantName = agent.tenant_name;
    req.actorType = 'llm_relay_agent';
    req.actorName = agent.name;
    return next();
  } catch (error) {
    return next(error);
  }
}
