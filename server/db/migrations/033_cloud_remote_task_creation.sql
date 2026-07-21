ALTER TABLE capture_agents
  ADD COLUMN IF NOT EXISTS unattended_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS unattended_plan_updated_at TIMESTAMPTZ;

-- 032 originally allowed only resume/stop. Keep this as a separate additive
-- migration because a developer or test database may already have recorded 032.
ALTER TABLE capture_agent_commands
  DROP CONSTRAINT IF EXISTS capture_agent_commands_command_type_check;

ALTER TABLE capture_agent_commands
  ADD CONSTRAINT capture_agent_commands_command_type_check
  CHECK (command_type IN ('resume', 'stop', 'create'));
