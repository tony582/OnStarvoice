-- Mobile control reuses capture_agents/tasks/items/attempts. No parallel queue.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_android_mobile_device_binding
 ON capture_agents(tenant_id,(capabilities->>'deviceId'))
 WHERE capabilities->>'agentKind'='android_mobile' AND status<>'revoked';
CREATE INDEX IF NOT EXISTS idx_android_discovery_runs
 ON capture_tasks(tenant_id,created_at DESC) WHERE metadata->>'workflow'='douyin_mobile_discovery';
CREATE INDEX IF NOT EXISTS idx_android_device_held_items
 ON capture_task_items(tenant_id,assigned_agent_id) WHERE metadata->>'deviceHeld'='true';
