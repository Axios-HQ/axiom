-- better-auth core tables
CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS "session" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS "account" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  access_token_expires_at INTEGER,
  scope TEXT,
  id_token TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS "verification" (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Organization plugin tables
CREATE TABLE IF NOT EXISTS "organization" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS "member" (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'developer',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS "invitation" (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'developer',
  status TEXT NOT NULL DEFAULT 'pending',
  inviter_id TEXT NOT NULL REFERENCES "user"(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- API key plugin table
CREATE TABLE IF NOT EXISTS "api_key" (
  id TEXT PRIMARY KEY,
  name TEXT,
  start TEXT,
  prefix TEXT,
  key TEXT NOT NULL UNIQUE,
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES "organization"(id) ON DELETE CASCADE,
  ref_id TEXT,
  ref_type TEXT,
  metadata TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  remaining_requests INTEGER,
  last_request INTEGER,
  expires_at INTEGER,
  last_refill INTEGER,
  rate_limit_enabled INTEGER NOT NULL DEFAULT 0,
  rate_limit_time_window INTEGER,
  rate_limit_max INTEGER,
  request_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_session_user_id ON "session"(user_id);
CREATE INDEX IF NOT EXISTS idx_session_token ON "session"(token);
CREATE INDEX IF NOT EXISTS idx_account_user_id ON "account"(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_provider ON "account"(provider_id, account_id);
CREATE INDEX IF NOT EXISTS idx_member_org_id ON "member"(organization_id);
CREATE INDEX IF NOT EXISTS idx_member_user_id ON "member"(user_id);
CREATE INDEX IF NOT EXISTS idx_invitation_org_id ON "invitation"(organization_id);
CREATE INDEX IF NOT EXISTS idx_api_key_user_id ON "api_key"(user_id);
CREATE INDEX IF NOT EXISTS idx_api_key_org_id ON "api_key"(organization_id);
CREATE INDEX IF NOT EXISTS idx_api_key_key ON "api_key"(key);
