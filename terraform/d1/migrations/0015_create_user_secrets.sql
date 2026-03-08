CREATE TABLE IF NOT EXISTS user_secrets (
  user_id         TEXT    NOT NULL,
  key             TEXT    NOT NULL,
  encrypted_value TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_user_secrets_user_id
  ON user_secrets (user_id);
