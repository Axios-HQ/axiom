# GitHub Token Refresh Design

## Problem

GitHub App installation tokens expire after 1 hour. The sandbox receives `GITHUB_TOKEN` and
`VCS_CLONE_TOKEN` at creation time and never refreshes them. Any session running longer than 1 hour
fails on git operations (`git fetch`, `git pull`, `git push`, `gh` CLI).

The control plane's PR creation flow works fine — it generates fresh tokens via
`getCachedInstallationToken()` — but direct git operations inside the sandbox break.

## Solution

Add a transparent token refresh mechanism using a git credential helper that calls a local bridge
endpoint, which fetches a fresh token from the control plane.

## Architecture

```
Agent runs `git push`
  → git invokes credential helper script
    → helper calls bridge HTTP: POST http://localhost:{port}/refresh-github-token
      → bridge sends WebSocket command to control plane: { type: "refresh_github_token" }
        → control plane calls getCachedInstallationToken()
      → bridge receives fresh token
    → helper outputs token in git credential format
  → git push succeeds with fresh token
```

## Components

### 1. Git Credential Helper Script (`/app/sandbox/git-credential-helper.sh`)

Installed during sandbox setup. Called by git automatically when credentials are needed.

```bash
#!/bin/bash
# Git credential helper that fetches fresh tokens from the bridge
if [ "$1" != "get" ]; then exit 0; fi

# Read stdin to get the host git is asking about
while IFS= read -r line; do
  case "$line" in
    host=*) HOST="${line#host=}" ;;
    protocol=*) PROTOCOL="${line#protocol=}" ;;
    "") break ;;
  esac
done

# Only handle github.com requests
if [ "$HOST" != "github.com" ]; then exit 0; fi

# Fetch fresh token from bridge
RESPONSE=$(curl -s -f "http://localhost:${BRIDGE_PORT:-4097}/refresh-github-token" 2>/dev/null)
if [ $? -ne 0 ]; then
  # Fallback to env var if bridge unavailable
  echo "username=x-access-token"
  echo "password=${GITHUB_TOKEN}"
  exit 0
fi

TOKEN=$(echo "$RESPONSE" | jq -r '.token // empty')
if [ -z "$TOKEN" ]; then
  echo "username=x-access-token"
  echo "password=${GITHUB_TOKEN}"
  exit 0
fi

echo "username=x-access-token"
echo "password=${TOKEN}"
```

### 2. Bridge HTTP Endpoint (`/refresh-github-token`)

New endpoint on the bridge's local HTTP server. Requests a fresh token from the control plane via
the existing WebSocket connection.

- Request: `GET /refresh-github-token`
- Response: `{ "token": "ghs_xxx..." }`
- Caches the token for 30 minutes to avoid excessive requests
- Falls back to the original `VCS_CLONE_TOKEN` if refresh fails

### 3. Control Plane WebSocket Command

New command type on the session Durable Object WebSocket handler:

- Command: `{ type: "refresh_github_token" }`
- Response: `{ type: "github_token_refreshed", token: "ghs_xxx..." }`
- Uses existing `getCachedInstallationToken()` with KV + memory caching

### 4. Sandbox Setup Changes

During `perform_git_sync()` in `entrypoint.py`:

- Install the credential helper script
- Configure git to use it:
  `git config --global credential.helper /app/sandbox/git-credential-helper.sh`
- Remove embedded credentials from the remote URL (use `https://github.com/owner/repo.git` without
  token in URL)
- Keep `GITHUB_TOKEN` env var as fallback for `gh` CLI

### 5. GITHUB_TOKEN Env Var Refresh

For `gh` CLI and other tools that read `GITHUB_TOKEN` directly:

- The credential helper script also writes the fresh token to a well-known file
  (`/tmp/.github-token`)
- A wrapper script for `gh` reads from this file if it exists
- Or: bridge updates the env var file that the shell sources

## Fallback Behavior

1. Bridge available + control plane connected → fresh token (best case)
2. Bridge available but control plane disconnected → cached token from last refresh
3. Bridge unavailable → original `GITHUB_TOKEN` env var (pre-refresh behavior)
4. All fail → git operation fails with auth error (same as today, no regression)

## Files to Modify

| File                                                   | Change                                                  |
| ------------------------------------------------------ | ------------------------------------------------------- |
| `packages/modal-infra/src/sandbox/bridge.py`           | Add `/refresh-github-token` HTTP endpoint               |
| `packages/modal-infra/src/sandbox/entrypoint.py`       | Install credential helper, configure git                |
| `packages/sandbox/git-credential-helper.sh`            | New: credential helper script                           |
| `packages/control-plane/src/session/durable-object.ts` | Handle `refresh_github_token` WebSocket command         |
| `packages/control-plane/src/auth/github-app.ts`        | No changes (existing `getCachedInstallationToken` used) |

## Testing

- Unit test: bridge `/refresh-github-token` endpoint returns cached/fresh token
- Unit test: control plane handles `refresh_github_token` command
- Integration: credential helper script output format
- Manual: run session >1 hour, verify git operations work throughout
