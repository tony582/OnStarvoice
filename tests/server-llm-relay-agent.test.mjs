import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function source(path) {
  return await readFile(resolve(repoRoot, path), 'utf8');
}

test('AI relay has independent tenant-scoped tables and never joins capture tasks', async () => {
  const migration = await source('server/db/migrations/068_llm_relay_agent.sql');
  const service = await source('server/services/llm-relay-jobs.js');
  const middleware = await source('server/middleware/llm-relay-agent.js');
  const router = await source('server/routes/llm-relay-agent.js');
  const combined = [migration, service, middleware, router].join('\n');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS llm_relay_agent_tokens/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS llm_relay_jobs/);
  assert.match(migration, /tenant_id UUID NOT NULL REFERENCES tenants/);
  assert.doesNotMatch(combined, /\bcapture_tasks\b|\bcapture_agents\b|\bcapture_agent_tokens\b/);
  assert.match(service, /FOR UPDATE SKIP LOCKED/);
  assert.match(service, /Number\(active\?\.count \|\| 0\) >= availableSlots/);
  assert.doesNotMatch(service, /MAX_ACTIVE_JOBS_PER_TENANT\s*=\s*100/);
  assert.match(service, /system_prompt = ''/);
  assert.match(middleware, /hashLlmRelayAgentToken/);
  assert.match(router, /router\.post\('\/agent\/heartbeat'/);
});

test('Agent API is mounted separately and local-offline errors retain cloud fallback', async () => {
  const app = await source('server/app.js');
  const labeler = await source('server/services/ai-labeler.js');
  const prefilter = await source('server/services/relevance-prefilter.js');

  assert.match(app, /app\.use\('\/api\/llm-relay', llmRelayAgentRouter\)/);
  assert.match(labeler, /runLlmRelayPolicy/);
  assert.match(labeler, /LLM_RELAY_ERROR/);
  assert.match(labeler, /callRelevancePrefilterWithPrompt/);
  assert.match(labeler, /isLlmRelayEligibleKind\(requestKind\)/);
  assert.match(labeler, /LLM_RELAY_CLASSIFICATION_TIMEOUT_MS/);
  assert.match(labeler, /LLM_RELAY_PREFILTER_TIMEOUT_MS/);
  assert.match(labeler, /relayQueueTimeoutMs/);
  assert.match(prefilter, /callRelevancePrefilterWithPrompt/);
  assert.match(prefilter, /getRelevancePrefilterRouteConfigs/);
  assert.doesNotMatch(prefilter, /requestLlmRelayAgentCompletion/);
});

test('admin only returns plaintext agent token once and never exposes its hash', async () => {
  const admin = await source('server/routes/admin.js');
  const ui = await source('web/admin/src/pages/AdminPages.tsx');

  assert.match(admin, /ai\.relay_agent_token_rotated/);
  assert.match(admin, /ai\.relay_agent_tested/);
  assert.match(admin, /Return exactly \{\"ok\":true,\"source\":\"antigravity\"\}/);
  assert.match(admin, /RETURNING id, name, created_at/);
  assert.doesNotMatch(admin, /RETURNING[^\n]*token_hash/);
  assert.match(ui, /一次性 Agent 令牌/);
  assert.match(ui, /Agent 只向外连接阿里云，不会领取或修改采集任务/);
  assert.match(ui, /当前接列表前置预判（每批最多 8 条）及最终相关性与情感判断/);
  assert.match(ui, /测试本机 AI/);
});
