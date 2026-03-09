CREATE TABLE IF NOT EXISTS identity_links (
  provider          TEXT    NOT NULL,
  external_user_id  TEXT    NOT NULL,
  github_user_id    TEXT    NOT NULL,
  github_login      TEXT    NOT NULL,
  github_name       TEXT,
  created_by        TEXT    NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (provider, external_user_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_links_github_user
  ON identity_links (github_user_id);
