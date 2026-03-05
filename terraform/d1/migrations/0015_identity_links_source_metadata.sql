ALTER TABLE identity_links ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE identity_links ADD COLUMN source_metadata TEXT;
ALTER TABLE identity_links ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0;

UPDATE identity_links
SET is_manual = CASE
  WHEN created_by LIKE 'auto:%' THEN 0
  ELSE 1
END
WHERE is_manual = 0;

CREATE INDEX IF NOT EXISTS idx_identity_links_provider_manual
  ON identity_links (provider, is_manual);
