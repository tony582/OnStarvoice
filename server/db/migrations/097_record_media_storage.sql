-- Keep source URLs as collection evidence. Terminal failures are bound to their
-- exact signed URL, so a fresh URL from a later capture can be saved again.
ALTER TABLE records ADD COLUMN IF NOT EXISTS cover_storage_error JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE records ADD COLUMN IF NOT EXISTS author_avatar_local TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN IF NOT EXISTS author_avatar_storage_error JSONB NOT NULL DEFAULT '{}'::jsonb;
