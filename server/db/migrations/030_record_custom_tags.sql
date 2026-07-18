-- 内容级人工自定义标签:
-- 1) custom_tags 是租户内可复用的标签字典;
-- 2) record_custom_tags 保存记录与人工标签的关联,与 records.tags(平台话题标签)完全分离。

CREATE UNIQUE INDEX IF NOT EXISTS uniq_records_tenant_id
  ON records (tenant_id, id);

CREATE TABLE IF NOT EXISTS custom_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT custom_tags_name_length_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 24),
  CONSTRAINT custom_tags_normalized_name_check
    CHECK (char_length(btrim(normalized_name)) BETWEEN 1 AND 24),
  CONSTRAINT custom_tags_tenant_normalized_name_key
    UNIQUE (tenant_id, normalized_name),
  CONSTRAINT custom_tags_tenant_id_key
    UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_custom_tags_tenant_last_used
  ON custom_tags (tenant_id, last_used_at DESC);

CREATE TABLE IF NOT EXISTS record_custom_tags (
  tenant_id UUID NOT NULL,
  record_id UUID NOT NULL,
  tag_id UUID NOT NULL,
  added_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  added_by_name TEXT NOT NULL DEFAULT '',
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, record_id, tag_id),
  CONSTRAINT record_custom_tags_record_fk
    FOREIGN KEY (tenant_id, record_id)
    REFERENCES records(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT record_custom_tags_tag_fk
    FOREIGN KEY (tenant_id, tag_id)
    REFERENCES custom_tags(tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_record_custom_tags_tenant_tag_record
  ON record_custom_tags (tenant_id, tag_id, record_id);
