-- Fix better-auth tables: rename snake_case columns to camelCase.
-- better-auth expects camelCase column names by default.
-- Since this is a fresh deployment with no user data, drop and recreate.

DROP TABLE IF EXISTS "user_secrets";
DROP TABLE IF EXISTS "api_key";
DROP TABLE IF EXISTS "invitation";
DROP TABLE IF EXISTS "member";
DROP TABLE IF EXISTS "organization";
DROP TABLE IF EXISTS "verification";
DROP TABLE IF EXISTS "account";
DROP TABLE IF EXISTS "session";
DROP TABLE IF EXISTS "user";

-- Drop old indexes (will be recreated below)
DROP INDEX IF EXISTS idx_session_user_id;
DROP INDEX IF EXISTS idx_session_token;
DROP INDEX IF EXISTS idx_account_user_id;
DROP INDEX IF EXISTS idx_account_provider;
DROP INDEX IF EXISTS idx_member_org_id;
DROP INDEX IF EXISTS idx_member_user_id;
DROP INDEX IF EXISTS idx_invitation_org_id;
DROP INDEX IF EXISTS idx_api_key_user_id;
DROP INDEX IF EXISTS idx_api_key_org_id;
DROP INDEX IF EXISTS idx_api_key_key;

-- Recreate with camelCase column names

CREATE TABLE "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE "session" (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expiresAt INTEGER NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE "account" (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  accessToken TEXT,
  refreshToken TEXT,
  accessTokenExpiresAt INTEGER,
  refreshTokenExpiresAt INTEGER,
  scope TEXT,
  password TEXT,
  idToken TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE "verification" (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Organization plugin tables
CREATE TABLE "organization" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  metadata TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE "member" (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'developer',
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(organizationId, userId)
);

CREATE TABLE "invitation" (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'developer',
  status TEXT NOT NULL DEFAULT 'pending',
  inviterId TEXT NOT NULL REFERENCES "user"(id),
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch())
);

-- API key plugin table
CREATE TABLE "api_key" (
  id TEXT PRIMARY KEY,
  name TEXT,
  start TEXT,
  prefix TEXT,
  key TEXT NOT NULL UNIQUE,
  userId TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  organizationId TEXT REFERENCES "organization"(id) ON DELETE CASCADE,
  refId TEXT,
  refType TEXT,
  metadata TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  remainingRequests INTEGER,
  lastRequest INTEGER,
  expiresAt INTEGER,
  lastRefill INTEGER,
  rateLimitEnabled INTEGER NOT NULL DEFAULT 0,
  rateLimitTimeWindow INTEGER,
  rateLimitMax INTEGER,
  requestCount INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch()),
  deletedAt INTEGER
);

-- Indexes
CREATE INDEX idx_session_userId ON "session"(userId);
CREATE INDEX idx_session_token ON "session"(token);
CREATE INDEX idx_account_userId ON "account"(userId);
CREATE UNIQUE INDEX idx_account_provider ON "account"(providerId, accountId);
CREATE INDEX idx_member_orgId ON "member"(organizationId);
CREATE INDEX idx_member_userId ON "member"(userId);
CREATE INDEX idx_invitation_orgId ON "invitation"(organizationId);
CREATE INDEX idx_api_key_userId ON "api_key"(userId);
CREATE INDEX idx_api_key_orgId ON "api_key"(organizationId);
CREATE INDEX idx_api_key_key ON "api_key"(key);

-- Recreate user_secrets (dropped above because it FKs to "user")
CREATE TABLE IF NOT EXISTS user_secrets (
  user_id         TEXT    NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  key             TEXT    NOT NULL,
  encrypted_value TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
