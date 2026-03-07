# Axiom Cloudflare-Native Fork Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task.

**Goal:** Fork Open-Inspect into a Cloudflare-native background agent platform with better-auth
(org/RBAC), Cloudflare Sandbox SDK, Agents SDK, and UI improvements.

**Architecture:** Three-layer Cloudflare-native stack: better-auth (D1) for all auth including org
RBAC and API keys; SessionAgent (Agents SDK) as control plane with SandboxProvider abstraction; CF
Sandbox SDK containers with outbound WebSocket bridge. UI adds session management (folders, rename,
delete), agent visibility (diff viewer), and input (slash commands).

**Tech Stack:** better-auth + D1, Cloudflare Agents SDK, Cloudflare Sandbox SDK, Next.js on CF
Workers (OpenNext), React 19, Vitest, Playwright, Terraform

**Git Safety:** All work on `feat/axiom-cloudflare` branch. Push only to `origin`
(CisarJosh/background-agents). NEVER push to or PR against `upstream`
(ColeMurray/background-agents).

---

## Phase 0: Project Scaffold

### Task 0.1: Add fork remotes for reference

**Files:**

- None (git config only)

**Step 1: Add reference remotes**

```bash
git remote add ref-deathbyknowledge https://github.com/deathbyknowledge/background-agents.git
git remote add ref-klussyapp https://github.com/klussyapp/background-agents.git
git remote add ref-dosmond https://github.com/dosmond/background-agents.git
git remote add ref-axiom https://github.com/Axios-HQ/axiom.git
git fetch ref-deathbyknowledge main
git fetch ref-klussyapp main
git fetch ref-dosmond main
git fetch ref-axiom main
```

**Step 2: Verify remotes**

Run: `git remote -v` Expected: origin, upstream, ref-deathbyknowledge, ref-klussyapp, ref-dosmond,
ref-axiom

**Step 3: Commit**

No files changed — remotes are local config.

---

## Phase 1a: better-auth Setup

### Task 1a.1: Install better-auth and create auth configuration

**Files:**

- Modify: `packages/web/package.json` (add better-auth, remove next-auth)
- Create: `packages/web/src/lib/auth.ts` (rewrite)
- Create: `packages/web/src/lib/auth-client.ts`
- Create: `packages/shared/src/auth-types.ts`
- Test: `packages/web/src/lib/auth.test.ts`

**Step 1: Write the failing test**

Create `packages/web/src/lib/auth.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("better-auth configuration", () => {
  it("exports an auth instance with github provider", async () => {
    // This will fail until we create the auth module
    const { auth } = await import("./auth");
    expect(auth).toBeDefined();
    expect(auth.options.socialProviders).toHaveProperty("github");
  });

  it("exports organization plugin", async () => {
    const { auth } = await import("./auth");
    // Verify org plugin is configured
    expect(auth.options.plugins).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -w @open-inspect/web -- --run src/lib/auth.test.ts` Expected: FAIL — module not found

**Step 3: Install better-auth**

```bash
cd packages/web
npm install better-auth
npm uninstall next-auth
```

**Step 4: Create auth server config**

Rewrite `packages/web/src/lib/auth.ts`:

```typescript
import { betterAuth } from "better-auth";
import { organization, apiKey } from "better-auth/plugins";
import { checkAccessAllowed, parseAllowlist } from "./access-control";

export const auth = betterAuth({
  database: {
    // D1 adapter — will be configured per-environment
    type: "sqlite",
    url: process.env.AUTH_DATABASE_URL!,
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      scope: ["read:user", "user:email", "repo"],
    },
  },
  plugins: [
    organization({
      roles: {
        admin: { description: "Full access to org resources" },
        developer: { description: "Create sessions, view repos" },
      },
      defaultRole: "developer",
    }),
    apiKey(),
  ],
  callbacks: {
    async onSignIn({ user, profile }) {
      const config = {
        allowedDomains: parseAllowlist(process.env.ALLOWED_EMAIL_DOMAINS),
        allowedUsers: parseAllowlist(process.env.ALLOWED_USERS),
      };
      const githubProfile = profile as { login?: string };
      return checkAccessAllowed(config, {
        githubUsername: githubProfile.login,
        email: user.email ?? undefined,
      });
    },
  },
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  },
});

export type Session = typeof auth.$Infer.Session;
```

**Step 5: Create auth client**

Create `packages/web/src/lib/auth-client.ts`:

```typescript
import { createAuthClient } from "better-auth/react";
import { organizationClient, apiKeyClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [organizationClient(), apiKeyClient()],
});

export const { useSession, signIn, signOut, useActiveOrganization, useListOrganizations } =
  authClient;
```

**Step 6: Run tests to verify they pass**

Run: `npm test -w @open-inspect/web -- --run src/lib/auth.test.ts` Expected: PASS

**Step 7: Commit**

```bash
git add packages/web/src/lib/auth.ts packages/web/src/lib/auth-client.ts packages/web/src/lib/auth.test.ts packages/web/package.json packages/shared/src/auth-types.ts
git commit -m "feat(auth): replace NextAuth with better-auth (GitHub OAuth, org, API keys)"
```

### Task 1a.2: Create better-auth API route handler

**Files:**

- Modify: `packages/web/src/app/api/auth/[...nextauth]/route.ts` → rename to
  `packages/web/src/app/api/auth/[...all]/route.ts`
- Modify: `packages/web/src/app/providers.tsx` (swap SessionProvider)
- Test: `packages/web/src/app/api/auth/auth-route.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";

describe("auth route handler", () => {
  it("exports GET and POST handlers", async () => {
    const mod = await import("./[...all]/route");
    expect(mod.GET).toBeDefined();
    expect(mod.POST).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -w @open-inspect/web -- --run src/app/api/auth/auth-route.test.ts` Expected: FAIL

**Step 3: Create route handler**

Delete `packages/web/src/app/api/auth/[...nextauth]/route.ts`. Create
`packages/web/src/app/api/auth/[...all]/route.ts`:

```typescript
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
```

**Step 4: Update providers.tsx**

Replace `SessionProvider` from next-auth with the better-auth client approach. Remove the
`"use client"` next-auth SessionProvider wrapper — better-auth uses its own hooks.

**Step 5: Run tests**

Run: `npm test -w @open-inspect/web -- --run` Expected: PASS

**Step 6: Commit**

```bash
git add packages/web/src/app/api/auth/
git commit -m "feat(auth): add better-auth route handler, remove NextAuth"
```

### Task 1a.3: D1 migration for better-auth tables

**Files:**

- Create: `terraform/d1/migrations/0014_create_better_auth_tables.sql`
- Test: verify migration applies in integration tests

**Step 1: Create migration**

```sql
-- better-auth core tables
CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  github_id TEXT,
  github_login TEXT,
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
  key_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES "organization"(id) ON DELETE CASCADE,
  permissions TEXT,
  expires_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_session_user_id ON "session"(user_id);
CREATE INDEX IF NOT EXISTS idx_session_token ON "session"(token);
CREATE INDEX IF NOT EXISTS idx_account_user_id ON "account"(user_id);
CREATE INDEX IF NOT EXISTS idx_member_org_id ON "member"(organization_id);
CREATE INDEX IF NOT EXISTS idx_member_user_id ON "member"(user_id);
CREATE INDEX IF NOT EXISTS idx_api_key_user_id ON "api_key"(user_id);
CREATE INDEX IF NOT EXISTS idx_api_key_org_id ON "api_key"(organization_id);
```

**Step 2: Run integration tests to verify migration applies**

Run: `npm run test:integration -w @open-inspect/control-plane` Expected: PASS (migrations
auto-applied)

**Step 3: Commit**

```bash
git add terraform/d1/migrations/0014_create_better_auth_tables.sql
git commit -m "feat(auth): add D1 migration for better-auth tables (user, session, org, api_key)"
```

### Task 1a.4: Replace HMAC internal auth with better-auth API keys in bots

**Files:**

- Modify: `packages/shared/src/auth.ts` (keep as deprecated shim, add api-key validation)
- Modify: `packages/slack-bot/src/index.ts`
- Modify: `packages/github-bot/src/index.ts`
- Modify: `packages/linear-bot/src/index.ts`
- Modify: `packages/control-plane/src/auth/internal.ts`
- Test: `packages/shared/src/auth.test.ts`

**Step 1: Write failing test for API key validation**

```typescript
import { describe, it, expect } from "vitest";
import { validateApiKey } from "./auth";

describe("API key validation", () => {
  it("rejects missing Authorization header", async () => {
    const result = await validateApiKey(null, mockD1());
    expect(result.valid).toBe(false);
  });

  it("rejects malformed Bearer token", async () => {
    const result = await validateApiKey("Basic abc", mockD1());
    expect(result.valid).toBe(false);
  });

  it("accepts valid API key with org context", async () => {
    const db = mockD1WithKey("oi_key_abc123", "org-1", "admin");
    const result = await validateApiKey("Bearer oi_key_abc123", db);
    expect(result.valid).toBe(true);
    expect(result.organizationId).toBe("org-1");
    expect(result.role).toBe("admin");
  });
});
```

**Step 2-5: Implement, test, commit**

Each bot's auth middleware gets updated to validate API keys against D1 instead of HMAC tokens. The
control plane's internal routes validate the same way.

```bash
git commit -m "feat(auth): replace HMAC internal tokens with better-auth API keys"
```

### Task 1a.5: Update all web components to use better-auth hooks

**Files:**

- Modify: `packages/web/src/components/session-sidebar.tsx` (useSession from better-auth)
- Modify: `packages/web/src/app/(app)/layout.tsx`
- Modify: `packages/web/src/app/providers.tsx`
- Modify: all files importing from `next-auth/react`
- Test: existing component tests should still pass

**Step 1: Find all next-auth imports**

```bash
grep -r "next-auth" packages/web/src/ --include="*.ts" --include="*.tsx" -l
```

**Step 2: Replace each import**

- `useSession` from `next-auth/react` → `useSession` from `@/lib/auth-client`
- `signOut` from `next-auth/react` → `signOut` from `@/lib/auth-client`
- `getServerSession` → `auth.api.getSession` from better-auth

**Step 3: Run full web test suite**

Run: `npm test -w @open-inspect/web -- --run` Expected: PASS

**Step 4: Commit**

```bash
git commit -m "refactor(web): migrate all components from next-auth to better-auth hooks"
```

---

## Phase 1b: Cloudflare Sandbox Provider

### Task 1b.1: Create CloudflareSandboxProvider

**Files:**

- Create: `packages/control-plane/src/sandbox/providers/cloudflare-provider.ts`
- Create: `packages/control-plane/src/sandbox/providers/cloudflare-provider.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { CloudflareSandboxProvider } from "./cloudflare-provider";

describe("CloudflareSandboxProvider", () => {
  it("implements SandboxProvider interface", () => {
    const provider = new CloudflareSandboxProvider(mockSandboxBinding());
    expect(provider.name).toBe("cloudflare");
    expect(provider.capabilities.supportsSnapshots).toBe(false); // initial impl
    expect(provider.capabilities.supportsRestore).toBe(false);
    expect(provider.capabilities.supportsWarm).toBe(false);
  });

  it("creates a sandbox via CF Sandbox SDK", async () => {
    const binding = mockSandboxBinding();
    const provider = new CloudflareSandboxProvider(binding);
    const result = await provider.createSandbox({
      sessionId: "test-session",
      sandboxId: "test-sandbox",
      repoOwner: "test",
      repoName: "repo",
      controlPlaneUrl: "https://cp.example.com",
      sandboxAuthToken: "token",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(result.sandboxId).toBe("test-sandbox");
    expect(binding.create).toHaveBeenCalled();
  });

  it("terminates a sandbox", async () => {
    const binding = mockSandboxBinding();
    const provider = new CloudflareSandboxProvider(binding);
    await provider.terminateSandbox("test-sandbox");
    expect(binding.destroy).toHaveBeenCalledWith("test-sandbox");
  });
});

function mockSandboxBinding() {
  return {
    create: vi.fn().mockResolvedValue({ id: "cf-container-id" }),
    destroy: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({ status: "running" }),
  };
}
```

**Step 2: Run test to verify it fails**

Run:
`npm test -w @open-inspect/control-plane -- --run src/sandbox/providers/cloudflare-provider.test.ts`
Expected: FAIL

**Step 3: Implement CloudflareSandboxProvider**

Reference: deathbyknowledge's `CloudflareSandboxManager` pattern. The provider wraps the CF Sandbox
SDK binding.

```typescript
import {
  SandboxProviderError,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type CreateSandboxConfig,
  type CreateSandboxResult,
} from "../provider";

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly name = "cloudflare";
  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: false,
  };

  constructor(private readonly sandboxBinding: CloudflareSandboxBinding) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const container = await this.sandboxBinding.create({
        image: "axiom-sandbox:latest",
        env: {
          SESSION_ID: config.sessionId,
          SANDBOX_ID: config.sandboxId,
          CONTROL_PLANE_URL: config.controlPlaneUrl,
          SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
          REPO_OWNER: config.repoOwner,
          REPO_NAME: config.repoName,
          LLM_PROVIDER: config.provider,
          LLM_MODEL: config.model,
          ...(config.userEnvVars ?? {}),
        },
      });
      return {
        sandboxId: config.sandboxId,
        providerObjectId: container.id,
        status: "creating",
        createdAt: Date.now(),
      };
    } catch (error) {
      throw SandboxProviderError.fromFetchError("Failed to create CF sandbox", error);
    }
  }
}

interface CloudflareSandboxBinding {
  create(config: { image: string; env: Record<string, string> }): Promise<{ id: string }>;
  destroy(id: string): Promise<void>;
  get(id: string): Promise<{ status: string }>;
}
```

**Step 4: Run tests**

Run:
`npm test -w @open-inspect/control-plane -- --run src/sandbox/providers/cloudflare-provider.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/control-plane/src/sandbox/providers/cloudflare-provider.ts packages/control-plane/src/sandbox/providers/cloudflare-provider.test.ts
git commit -m "feat(sandbox): add CloudflareSandboxProvider implementing SandboxProvider interface"
```

### Task 1b.2: Add provider selection logic

**Files:**

- Create: `packages/control-plane/src/sandbox/providers/factory.ts`
- Create: `packages/control-plane/src/sandbox/providers/factory.test.ts`
- Modify: `packages/control-plane/src/session/durable-object.ts` (use factory)

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { createSandboxProvider } from "./factory";

describe("createSandboxProvider", () => {
  it("returns ModalSandboxProvider when SANDBOX_PROVIDER=modal", () => {
    const provider = createSandboxProvider("modal", { modalClient: mockModalClient() });
    expect(provider.name).toBe("modal");
  });

  it("returns CloudflareSandboxProvider when SANDBOX_PROVIDER=cloudflare", () => {
    const provider = createSandboxProvider("cloudflare", { sandboxBinding: mockBinding() });
    expect(provider.name).toBe("cloudflare");
  });

  it("defaults to modal when SANDBOX_PROVIDER is unset", () => {
    const provider = createSandboxProvider(undefined, { modalClient: mockModalClient() });
    expect(provider.name).toBe("modal");
  });

  it("throws when cloudflare selected but no binding", () => {
    expect(() => createSandboxProvider("cloudflare", {})).toThrow();
  });
});
```

**Step 2-5: Implement factory, test, commit**

```bash
git commit -m "feat(sandbox): add provider factory with modal/cloudflare selection via env var"
```

### Task 1b.3: Create packages/sandbox (container runtime)

**Files:**

- Create: `packages/sandbox/Dockerfile`
- Create: `packages/sandbox/supervisor.sh`
- Create: `packages/sandbox/bridge/index.ts`
- Create: `packages/sandbox/bridge/package.json`
- Create: `packages/sandbox/README.md`

Reference: deathbyknowledge's `packages/sandbox` structure.

**Step 1: Create Dockerfile**

```dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install OpenCode agent
RUN npm install -g @anthropic-ai/opencode

# Install gh CLI (for PR creation)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY bridge/ ./bridge/
COPY supervisor.sh ./
RUN cd bridge && npm install
RUN chmod +x supervisor.sh

CMD ["./supervisor.sh"]
```

**Step 2: Create bridge (outbound WebSocket)**

The bridge connects from the container OUT to the control plane SessionAgent. It relays events
between the OpenCode agent process and the control plane.

**Step 3: Create supervisor**

The supervisor starts OpenCode + bridge, monitors health, handles graceful shutdown.

**Step 4: Commit**

```bash
git add packages/sandbox/
git commit -m "feat(sandbox): add CF Sandbox container with supervisor, bridge, and Dockerfile"
```

---

## Phase 1c: UI Scaffolding

### Task 1c.1: Add session rename functionality

**Files:**

- Create: `packages/web/src/components/session-rename.tsx`
- Create: `packages/web/src/components/session-rename.test.tsx`
- Modify: `packages/web/src/components/session-sidebar.tsx`
- Create: `packages/web/src/app/api/sessions/[id]/rename/route.ts`
- Modify: `packages/control-plane/src/session/http/routes.ts` (add rename endpoint)

Reference: dosmond + listlessbird PR #289

**Step 1: Write failing test for rename component**

**Step 2-5: Implement inline rename (double-click title, edit, save), test, commit**

```bash
git commit -m "feat(web): add inline session rename"
```

### Task 1c.2: Add session delete with confirmation

**Files:**

- Create: `packages/web/src/components/session-delete.tsx`
- Create: `packages/web/src/components/session-delete.test.tsx`
- Create: `packages/web/src/app/api/sessions/[id]/route.ts` (DELETE handler)

Reference: Tatch-AI/orq

**Step 1-5: TDD cycle, commit**

```bash
git commit -m "feat(web): add session delete with confirmation dialog"
```

### Task 1c.3: Add session folders

**Files:**

- Create: `packages/web/src/components/session-folders.tsx`
- Create: `packages/web/src/components/session-folders.test.tsx`
- Create: `packages/web/src/hooks/use-session-folders.ts`
- Modify: `packages/web/src/components/session-sidebar.tsx`

Reference: dosmond

Folders stored client-side in localStorage initially (no backend needed). Sessions grouped by
folder, drag-drop to move.

**Step 1-5: TDD cycle, commit**

```bash
git commit -m "feat(web): add session folders with drag-drop organization"
```

### Task 1c.4: Terminate sandbox on archive

**Files:**

- Modify: `packages/control-plane/src/session/durable-object.ts` (archive handler)
- Create: `packages/control-plane/src/session/archive.test.ts`

Reference: Tatch-AI/orq — snapshot before shutdown, prevent zombie containers.

**Step 1-5: TDD cycle, commit**

```bash
git commit -m "feat(session): terminate sandbox on archive (snapshot first)"
```

---

## Phase 2a: Control Plane Agents SDK Migration

### Task 2a.1: Migrate SessionDO to SessionAgent

**Files:**

- Modify: `packages/control-plane/src/session/durable-object.ts`
- Modify: `packages/control-plane/package.json` (add agents dependency)

Reference: klussyapp fork

**Step 1: Install agents package**

```bash
cd packages/control-plane && npm install agents
```

**Step 2: Change class declaration**

```typescript
// Before:
import { DurableObject } from "cloudflare:workers";
export class SessionDO extends DurableObject<Env> {

// After:
import { Agent } from "agents";
export class SessionAgent extends Agent<Env> {
```

**Step 3: Migrate WebSocket handling**

Replace manual `webSocketMessage`/`webSocketClose` with Agent's `onConnect`/`onMessage`/`onClose`.

**Step 4: Migrate alarms**

Replace `ctx.storage.setAlarm()` with Agent `schedule()` API.

**Step 5: Add better-auth API key validation to internal routes**

Replace `verifyInternalToken()` calls with API key lookup against D1.

**Step 6: Run all control-plane tests**

Run: `npm test -w @open-inspect/control-plane -- --run` Expected: PASS

**Step 7: Run integration tests**

Run: `npm run test:integration -w @open-inspect/control-plane` Expected: PASS

**Step 8: Commit**

```bash
git commit -m "feat(control-plane): migrate SessionDO to SessionAgent (Cloudflare Agents SDK)"
```

### Task 2a.2: Update Terraform for Agents SDK bindings

**Files:**

- Modify: `terraform/environments/production/workers-control-plane.tf`
- Modify: `terraform/environments/production/variables.tf`

Add `SANDBOX_PROVIDER` env var and CF Sandbox binding configuration.

```bash
git commit -m "feat(terraform): add sandbox provider selection and CF Sandbox bindings"
```

---

## Phase 2b: CF Sandbox Provider Wiring

### Task 2b.1: Wire CloudflareSandboxProvider into SessionAgent

**Files:**

- Modify: `packages/control-plane/src/session/durable-object.ts`
- Modify: `packages/control-plane/src/sandbox/lifecycle/manager.ts` (if needed)

The SessionAgent's `initSandboxProvider()` now uses the factory from Task 1b.2 to select provider
based on `env.SANDBOX_PROVIDER`.

**Step 1-5: TDD cycle, commit**

```bash
git commit -m "feat(session): wire CF sandbox provider into SessionAgent lifecycle"
```

---

## Phase 2c: Advanced UI

### Task 2c.1: Git diff viewer

**Files:**

- Create: `packages/web/src/components/diff-viewer.tsx`
- Create: `packages/web/src/components/diff-viewer.test.tsx`

Reference: dosmond. Syntax-highlighted unified diff display for agent changes.

```bash
git commit -m "feat(web): add git diff viewer with syntax highlighting"
```

### Task 2c.2: Slash commands in chat input

**Files:**

- Create: `packages/web/src/components/slash-command-menu.tsx`
- Create: `packages/web/src/components/slash-command-menu.test.tsx`
- Modify: chat input component

Reference: dosmond. Commands like `/model`, `/branch`, `/stop`, `/archive`.

```bash
git commit -m "feat(web): add slash command menu in chat input"
```

---

## Phase 3: Integration Wiring

### Task 3.1: End-to-end auth flow verification

Verify: GitHub OAuth sign-in -> better-auth session -> create org -> API key -> bot uses API key ->
session created.

### Task 3.2: End-to-end sandbox flow verification

Verify: session created -> provider factory selects CF sandbox -> container spawns -> bridge
connects -> events stream.

```bash
git commit -m "test: add end-to-end auth and sandbox flow integration tests"
```

---

## Phase 4: Playwright E2E Tests

### Task 4.1: Auth E2E tests

**Files:**

- Create: `packages/web/e2e/auth.spec.ts`

Tests: login flow, org creation, role enforcement, API key management.

### Task 4.2: Session management E2E tests

**Files:**

- Create: `packages/web/e2e/sessions.spec.ts`

Tests: create session, rename, delete, folder organization, archive.

### Task 4.3: Diff viewer E2E tests

**Files:**

- Create: `packages/web/e2e/diff-viewer.spec.ts`

```bash
git commit -m "test(e2e): add Playwright tests for auth, sessions, and diff viewer"
```

---

## Phase 5: Cherry-pick Axiom Features

### Task 5.1: Cherry-pick R2 media and file upload

```bash
git cherry-pick 88294912  # R2 media storage, agent tools
git cherry-pick 8ba24a52  # File upload UI
git cherry-pick 8a8fc26f  # Test suite for R2/upload/callbacks
git cherry-pick 77b32227  # Security review fixes
```

Resolve conflicts with new auth system if any.

### Task 5.2: Cherry-pick multi-repo and identity linking

```bash
git cherry-pick 4720d5f2  # Multi-repo session scope
git cherry-pick 01c87125  # Auto-link Slack/Linear identities
```

### Task 5.3: Cherry-pick code-server support

```bash
git cherry-pick 0f908df5  # Code-server and live preview
git cherry-pick 43c63a83  # Preview URL hydration
```

### Task 5.4: Resolve any cherry-pick conflicts and run full test suite

```bash
npm run lint:fix
npm run typecheck
npm test -w @open-inspect/control-plane -- --run
npm test -w @open-inspect/web -- --run
npm test -w @open-inspect/slack-bot -- --run
npm test -w @open-inspect/github-bot -- --run
npm test -w @open-inspect/linear-bot -- --run
git commit -m "feat: integrate Axiom features (R2 media, file upload, multi-repo, code-server)"
```

---

## Execution Notes

- **Phases 1a, 1b, 1c are independent** — dispatch as parallel agent teams
- **Phases 2a, 2b, 2c are independent** — dispatch as parallel agent teams (after Phase 1 deps)
- Each task has explicit test → implement → test → commit cycle
- Each commit is a checkpoint — bad work reverts to last checkpoint
- All pushes go to `origin` only (CisarJosh/background-agents), NEVER `upstream`
- Reference forks are read-only via `ref-*` remotes
- better-auth docs: check context7 for latest API when implementing
