-- Indexes for the per-record audit_logs lookups behind 处理记录 / 状态备注.
--
-- docs/hotfix/20261009-triage-export-timeout.md: the content triage export
-- (GET /api/triage/records/export), the list's latest-progress join and the
-- record activity feed all find a record's status notes with
--   al.target_id = r.id::text OR COALESCE(al.metadata->'recordIds','[]'::jsonb) ? r.id::text
-- Neither side of that OR had an index, so every exported row re-read the
-- tenant's whole audit_logs (5,000 rows × 83k audit rows ≈ 123 s locally) and
-- the 10 s reporting statement limit cancelled the export.
--
-- No statement changes. The GIN expression repeats the statements' own
-- COALESCE verbatim so the planner can match it; with both indexes the OR
-- becomes a BitmapOr of two index probes per row (0.57 s for 5,000 rows).
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_target
  ON audit_logs (tenant_id, target_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_record_ids
  ON audit_logs USING GIN ((COALESCE(metadata->'recordIds', '[]'::jsonb)));
