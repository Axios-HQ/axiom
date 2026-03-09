# GitHub Token Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task.

**Goal:** Make GitHub tokens auto-refresh in sandboxes so git operations work beyond the 1-hour
token expiry.

**Architecture:** The sandbox calls a new control plane endpoint
(`/sessions/:id/github-token-refresh`) to get a fresh GitHub App installation token. A git
credential helper script calls this endpoint transparently, and `GITHUB_TOKEN` is refreshed for `gh`
CLI. This mirrors the existing OpenAI token refresh pattern (`openai-token-refresh-service.ts`,
`codex-auth-plugin.ts`).

**Tech Stack:** TypeScript (Cloudflare Workers), Python (Modal sandbox), Bash (credential helper)

---

### Task 1: Control Plane — GitHub Token Refresh Service

Add a service that returns a fresh GitHub App installation token, following the pattern of
`OpenAITokenRefreshService`.

**Files:**

- Create: `packages/control-plane/src/session/github-token-refresh-service.ts`
- Test: `packages/control-plane/src/session/github-token-refresh-service.test.ts`

**Step 1: Write the failing test**

Create `packages/control-plane/src/session/github-token-refresh-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubTokenRefreshService } from "./github-token-refresh-service";
import type { Logger } from "../logger";

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger()),
  };
}

describe("GitHubTokenRefreshService", () => {
  const mockGetCachedInstallationToken = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a fresh token when GitHub App is configured", async () => {
    mockGetCachedInstallationToken.mockResolvedValue("ghs_fresh_token_123");

    const service = new GitHubTokenRefreshService(
      {
        appId: "12345",
        privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
        installationId: "67890",
      },
      undefined,
      createLogger()
    );

    const result = await service.refresh(mockGetCachedInstallationToken);

    expect(result).toEqual({ ok: true, token: "ghs_fresh_token_123" });
    expect(mockGetCachedInstallationToken).toHaveBeenCalledWith(
      {
        appId: "12345",
        privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
        installationId: "67890",
      },
      undefined,
      undefined
    );
  });

  it("returns error when GitHub App credentials are missing", async () => {
    const service = new GitHubTokenRefreshService(null, undefined, createLogger());
    const result = await service.refresh(mockGetCachedInstallationToken);

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "GitHub App not configured",
    });
    expect(mockGetCachedInstallationToken).not.toHaveBeenCalled();
  });

  it("returns error when token generation fails", async () => {
    mockGetCachedInstallationToken.mockRejectedValue(new Error("GitHub API down"));

    const service = new GitHubTokenRefreshService(
      {
        appId: "12345",
        privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
        installationId: "67890",
      },
      undefined,
      createLogger()
    );

    const result = await service.refresh(mockGetCachedInstallationToken);

    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "GitHub token refresh failed",
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run:
`npm test -w @open-inspect/control-plane -- --run src/session/github-token-refresh-service.test.ts`
Expected: FAIL with "Cannot find module './github-token-refresh-service'"

**Step 3: Write minimal implementation**

Create `packages/control-plane/src/session/github-token-refresh-service.ts`:

```typescript
import type { GitHubAppConfig, InstallationTokenCacheBindings } from "../auth/github-app";
import type { Logger } from "../logger";

export type GitHubTokenRefreshResult =
  | { ok: true; token: string }
  | { ok: false; status: number; error: string };

/**
 * Refreshes GitHub App installation tokens for sandbox use.
 * Called when git operations need fresh credentials (tokens expire after 1 hour).
 */
export class GitHubTokenRefreshService {
  constructor(
    private readonly config: GitHubAppConfig | null,
    private readonly cacheEnv: InstallationTokenCacheBindings | undefined,
    private readonly log: Logger
  ) {}

  async refresh(
    getCachedInstallationToken: (
      config: GitHubAppConfig,
      env?: InstallationTokenCacheBindings,
      options?: { forceRefresh?: boolean }
    ) => Promise<string>
  ): Promise<GitHubTokenRefreshResult> {
    if (!this.config) {
      return { ok: false, status: 404, error: "GitHub App not configured" };
    }

    try {
      const token = await getCachedInstallationToken(this.config, this.cacheEnv, undefined);

      this.log.info("GitHub token refreshed");
      return { ok: true, token };
    } catch (e) {
      this.log.error("GitHub token refresh failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, status: 502, error: "GitHub token refresh failed" };
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run:
`npm test -w @open-inspect/control-plane -- --run src/session/github-token-refresh-service.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add packages/control-plane/src/session/github-token-refresh-service.ts packages/control-plane/src/session/github-token-refresh-service.test.ts
git commit -m "feat: add GitHubTokenRefreshService for sandbox token renewal"
```

---

### Task 2: Control Plane — Wire Up the HTTP Endpoint

Add the route, internal path, and DO handler for `/sessions/:id/github-token-refresh`. Follow the
exact pattern of the existing OpenAI token refresh endpoint.

**Files:**

- Modify: `packages/control-plane/src/session/contracts.ts` (add path constant)
- Modify: `packages/control-plane/src/session/http/routes.ts` (add handler + route)
- Modify: `packages/control-plane/src/session/durable-object.ts` (add handler method)
- Modify: `packages/control-plane/src/router.ts` (add route + sandbox auth pattern)

**Step 1: Add the internal path constant**

In `packages/control-plane/src/session/contracts.ts`, add to `SessionInternalPaths`:

```typescript
  githubTokenRefresh: "/internal/github-token-refresh",
```

**Step 2: Add to the internal route handler interface and routes array**

In `packages/control-plane/src/session/http/routes.ts`:

Add to `SessionInternalRouteHandlers` interface:

```typescript
githubTokenRefresh: SessionInternalRouteHandler;
```

Add to the routes array in `createSessionInternalRoutes`:

```typescript
    {
      method: "POST",
      path: SessionInternalPaths.githubTokenRefresh,
      handler: handlers.githubTokenRefresh,
    },
```

**Step 3: Add the DO handler**

In `packages/control-plane/src/session/durable-object.ts`:

1. Import `GitHubTokenRefreshService`:

```typescript
import { GitHubTokenRefreshService } from "./github-token-refresh-service";
```

2. Add `getCachedInstallationToken` import (already imported — verify):

```typescript
import { getCachedInstallationToken, type GitHubAppConfig } from "../auth/github-app";
```

3. Register the handler in the route handlers object (near line 141 where `openaiTokenRefresh` is):

```typescript
      githubTokenRefresh: () => this.handleGitHubTokenRefresh(),
```

4. Add the handler method (near `handleOpenAITokenRefresh` around line 1525):

```typescript
  private async handleGitHubTokenRefresh(): Promise<Response> {
    const config = this.getGitHubAppConfig();

    const service = new GitHubTokenRefreshService(
      config,
      { REPOS_CACHE: this.env.REPOS_CACHE },
      this.log
    );

    const result = await service.refresh(getCachedInstallationToken);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: result.status });
    }

    return Response.json({ token: result.token }, { status: 200 });
  }

  private getGitHubAppConfig(): GitHubAppConfig | null {
    const appId = this.env.GITHUB_APP_ID;
    const privateKey = this.env.GITHUB_APP_PRIVATE_KEY;
    const installationId = this.env.GITHUB_APP_INSTALLATION_ID;

    if (!appId || !privateKey || !installationId) {
      return null;
    }

    return { appId, privateKey, installationId };
  }
```

Check if `getGitHubAppConfig` or similar already exists in the DO — reuse if so. Search for
`GITHUB_APP_ID` in `durable-object.ts`.

**Step 4: Add the router route and sandbox auth pattern**

In `packages/control-plane/src/router.ts`:

1. Add to `SANDBOX_AUTH_ROUTES` array:

```typescript
  /^\/sessions\/[^/]+\/github-token-refresh$/, // GitHub token refresh from sandbox
```

2. Add to the routes array (near the OpenAI token refresh route at line ~389):

```typescript
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/github-token-refresh"),
    handler: handleGitHubTokenRefresh,
  },
```

3. Add the handler function (near `handleOpenAITokenRefresh` at line ~1044):

```typescript
async function handleGitHubTokenRefresh(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  return stub.fetch(
    internalRequest(
      buildSessionInternalUrl(SessionInternalPaths.githubTokenRefresh),
      { method: "POST" },
      ctx
    )
  );
}
```

**Step 5: Run existing tests to make sure nothing broke**

Run: `npm test -w @open-inspect/control-plane -- --run src/session/http/routes.test.ts`

The routes test likely enumerates all handlers — it will fail until you add
`githubTokenRefresh: noopHandler()` to the test's handler object. Check the test file first.

Run: `npm test -w @open-inspect/control-plane -- --run src/session/contracts.test.ts`

Same — the contracts test enumerates all paths. Add `"githubTokenRefresh"` to the expected list.

**Step 6: Run full control-plane tests**

Run: `npm test -w @open-inspect/control-plane` Expected: All tests pass

**Step 7: Run typecheck**

Run: `npm run typecheck` Expected: PASS

**Step 8: Commit**

```bash
git add packages/control-plane/src/session/contracts.ts packages/control-plane/src/session/http/routes.ts packages/control-plane/src/session/durable-object.ts packages/control-plane/src/router.ts
git commit -m "feat: wire up /github-token-refresh endpoint on control plane"
```

---

### Task 3: Sandbox — Git Credential Helper Script

Create the bash script that git calls automatically when it needs credentials. It fetches a fresh
token from the control plane.

**Files:**

- Create: `packages/sandbox/git-credential-helper.sh`

**Step 1: Create the credential helper script**

Create `packages/sandbox/git-credential-helper.sh`:

```bash
#!/bin/bash
# Git credential helper that fetches fresh GitHub App tokens from the control plane.
# Installed by entrypoint.py during sandbox setup.
#
# Git credential helpers receive "get", "store", or "erase" as $1.
# On "get", they read key=value pairs from stdin (host, protocol, etc.)
# and output username/password on stdout.

set -euo pipefail

# Only respond to "get" requests
if [ "${1:-}" != "get" ]; then
  exit 0
fi

# Read stdin to get the host git is asking about
HOST=""
while IFS= read -r line; do
  case "$line" in
    host=*) HOST="${line#host=}" ;;
    "") break ;;
  esac
done

# Only handle github.com requests
if [ "$HOST" != "github.com" ]; then
  exit 0
fi

# Required environment variables (set by sandbox manager)
: "${CONTROL_PLANE_URL:?}"
: "${SANDBOX_AUTH_TOKEN:?}"
: "${SESSION_ID:?}"

# Fetch fresh token from control plane
RESPONSE=$(curl -sf \
  -X POST \
  -H "Authorization: Bearer ${SANDBOX_AUTH_TOKEN}" \
  "${CONTROL_PLANE_URL}/sessions/${SESSION_ID}/github-token-refresh" \
  2>/dev/null) || {
  # Fallback to original token if refresh fails
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    echo "username=x-access-token"
    echo "password=${GITHUB_TOKEN}"
    exit 0
  fi
  exit 1
}

TOKEN=$(echo "$RESPONSE" | jq -r '.token // empty')
if [ -z "$TOKEN" ]; then
  # Fallback to original token
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    echo "username=x-access-token"
    echo "password=${GITHUB_TOKEN}"
    exit 0
  fi
  exit 1
fi

# Write refreshed token to file for gh CLI wrapper
echo "$TOKEN" > /tmp/.github-token

echo "username=x-access-token"
echo "password=${TOKEN}"
```

**Step 2: Make the script executable in the Dockerfile**

Check `packages/sandbox/Dockerfile` for the COPY pattern used for other scripts. Add:

```dockerfile
COPY git-credential-helper.sh /app/sandbox/git-credential-helper.sh
RUN chmod +x /app/sandbox/git-credential-helper.sh
```

**Step 3: Create a gh CLI wrapper**

Create `packages/sandbox/gh-wrapper.sh`:

```bash
#!/bin/bash
# Wrapper for gh CLI that reads a refreshed GitHub token if available.
# Falls back to GITHUB_TOKEN env var if no refreshed token exists.

if [ -f /tmp/.github-token ]; then
  export GITHUB_TOKEN
  GITHUB_TOKEN=$(cat /tmp/.github-token)
fi

exec /usr/bin/gh "$@"
```

Add to Dockerfile:

```dockerfile
COPY gh-wrapper.sh /app/sandbox/gh-wrapper.sh
RUN chmod +x /app/sandbox/gh-wrapper.sh
```

**Step 4: Commit**

```bash
git add packages/sandbox/git-credential-helper.sh packages/sandbox/gh-wrapper.sh packages/sandbox/Dockerfile
git commit -m "feat: add git credential helper and gh wrapper for token refresh"
```

---

### Task 4: Sandbox — Configure Git to Use Credential Helper

Modify the sandbox entrypoint to set up the credential helper and remove embedded credentials from
the git remote URL.

**Files:**

- Modify: `packages/modal-infra/src/sandbox/entrypoint.py`

**Step 1: Understand the current git setup**

Read `packages/modal-infra/src/sandbox/entrypoint.py`:

- Line 95-99: `_build_repo_url()` embeds `x-access-token:{token}` in the URL
- Line 159-169: `git remote set-url origin` uses the authenticated URL after clone
- Line 67-70: `vcs_clone_token` read from env vars

**Step 2: Add credential helper setup method**

After `perform_git_sync()` completes successfully (around line 230-238), add a call to configure the
credential helper. Add this method to `SandboxSupervisor`:

```python
async def _configure_credential_helper(self) -> None:
    """Replace embedded git credentials with a credential helper that auto-refreshes tokens."""
    credential_helper = "/app/sandbox/git-credential-helper.sh"
    gh_wrapper = "/app/sandbox/gh-wrapper.sh"

    # Only configure if credential helper exists (may not in local dev)
    if not Path(credential_helper).exists():
        self.log.debug("credential_helper.not_found", path=credential_helper)
        return

    try:
        # Configure git to use the credential helper
        await self._run_git_command(
            "config", "--global", "credential.helper", credential_helper,
            error_msg="Failed to configure credential helper"
        )

        # Remove embedded credentials from the remote URL
        unauthenticated_url = self._build_repo_url(authenticated=False)
        if self.repo_path.exists() and (self.repo_path / ".git").exists():
            await self._run_git_command(
                "remote", "set-url", "origin", unauthenticated_url,
                cwd=str(self.repo_path),
                error_msg="Failed to update remote URL"
            )

        # Symlink gh wrapper if gh CLI is installed
        gh_path = Path("/usr/bin/gh")
        gh_local = Path("/usr/local/bin/gh")
        if gh_path.exists() and Path(gh_wrapper).exists():
            # gh_local takes precedence in PATH over /usr/bin/gh
            if gh_local.exists() or gh_local.is_symlink():
                gh_local.unlink()
            gh_local.symlink_to(gh_wrapper)
            self.log.info("gh_wrapper.installed")

        self.log.info("credential_helper.configured")
    except Exception as e:
        self.log.warn("credential_helper.setup_error", exc=e)
        # Non-fatal: original embedded credentials still work for the first hour
```

Check if `_run_git_command` exists as a helper. If not, use `asyncio.create_subprocess_exec`
directly (match the pattern used elsewhere in the file for running git commands).

**Step 3: Call the credential helper setup after git sync**

In `perform_git_sync()`, after the successful sync block (around line 230-238, after
`git rev-parse HEAD`), add:

```python
        # Set up credential helper for token auto-refresh
        await self._configure_credential_helper()
```

**Step 4: Ensure SESSION_ID env var is available**

Check `packages/modal-infra/src/sandbox/manager.py` — the credential helper needs `SESSION_ID` as an
env var. Verify it's already set. Search for `SESSION_ID` in `manager.py`. The session ID is in
`SESSION_CONFIG` JSON but may not be a standalone env var. If not set, add it:

In `packages/modal-infra/src/sandbox/manager.py`, in the env vars setup section:

```python
env_vars["SESSION_ID"] = config.session_id
```

**Step 5: Run Python tests**

Run: `cd packages/modal-infra && pytest tests/ -v` Expected: PASS

**Step 6: Commit**

```bash
git add packages/modal-infra/src/sandbox/entrypoint.py packages/modal-infra/src/sandbox/manager.py
git commit -m "feat: configure git credential helper in sandbox for token auto-refresh"
```

---

### Task 5: Smoke Test and Update Design Doc

**Step 1: Run all TypeScript tests**

```bash
npm test -w @open-inspect/control-plane
npm test -w @open-inspect/slack-bot
npm test -w @open-inspect/linear-bot
```

**Step 2: Run typecheck**

```bash
npm run typecheck
```

**Step 3: Run lint**

```bash
npm run lint:fix
```

**Step 4: Run Python tests**

```bash
cd packages/modal-infra && pytest tests/ -v
```

**Step 5: Update the design doc**

Update `docs/plans/2026-03-09-github-token-refresh-design.md` to reflect the actual implementation:

- The bridge does NOT have an HTTP server — the credential helper calls the control plane directly
- No WebSocket command needed — uses standard HTTP endpoint like OpenAI token refresh
- Add the `gh` wrapper approach for `GITHUB_TOKEN` refresh

**Step 6: Commit**

```bash
git add docs/plans/2026-03-09-github-token-refresh-design.md
git commit -m "docs: update design doc to reflect implemented approach"
```
