CREATE TABLE IF NOT EXISTS user_secrets (
  user_id         TEXT    NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  key             TEXT    NOT NULL,
  encrypted_value TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
