#!/usr/bin/env bash
# Supervisor for Cloudflare sandbox container.
#
# Runs as PID 1 inside the container. Responsibilities:
# 1. Configure git credentials and identity
# 2. Clone the repository
# 3. Run repo hooks (.openinspect/setup.sh, .openinspect/start.sh)
# 4. Start OpenCode agent
# 5. Start WebSocket bridge to control plane
# 6. Monitor processes and handle shutdown

set -euo pipefail

# ==================== Configuration ====================

BRIDGE_DIR="/opt/bridge"
REPO_DIR="/home/user/repo"
HEALTH_CHECK_INTERVAL_SECONDS=30
SHUTDOWN_GRACE_PERIOD_SECONDS=10
CLONE_DEPTH=100
SETUP_TIMEOUT_SECONDS=300
START_TIMEOUT_SECONDS=120

# ==================== Signal Handling ====================

BRIDGE_PID=""
OPENCODE_PID=""
SHUTTING_DOWN=false

cleanup() {
  if [ "$SHUTTING_DOWN" = true ]; then
    return
  fi
  SHUTTING_DOWN=true

  echo "[supervisor] Received shutdown signal, cleaning up..."

  if [ -n "$OPENCODE_PID" ] && kill -0 "$OPENCODE_PID" 2>/dev/null; then
    echo "[supervisor] Stopping OpenCode (PID $OPENCODE_PID)..."
    kill -TERM "$OPENCODE_PID" 2>/dev/null || true
  fi

  if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "[supervisor] Stopping bridge (PID $BRIDGE_PID)..."
    kill -TERM "$BRIDGE_PID" 2>/dev/null || true
  fi

  local waited=0
  while [ $waited -lt $SHUTDOWN_GRACE_PERIOD_SECONDS ]; do
    local any_alive=false
    if [ -n "$OPENCODE_PID" ] && kill -0 "$OPENCODE_PID" 2>/dev/null; then
      any_alive=true
    fi
    if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
      any_alive=true
    fi
    if [ "$any_alive" = false ]; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if [ -n "$OPENCODE_PID" ] && kill -0 "$OPENCODE_PID" 2>/dev/null; then
    kill -9 "$OPENCODE_PID" 2>/dev/null || true
  fi
  if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill -9 "$BRIDGE_PID" 2>/dev/null || true
  fi

  echo "[supervisor] Shutdown complete."
  exit 0
}

trap cleanup SIGTERM SIGINT SIGHUP

# ==================== Validation ====================

: "${CONTROL_PLANE_URL:?CONTROL_PLANE_URL is required}"
: "${SESSION_ID:?SESSION_ID is required}"
: "${SANDBOX_ID:?SANDBOX_ID is required}"
: "${SANDBOX_AUTH_TOKEN:?SANDBOX_AUTH_TOKEN is required}"
: "${REPO_OWNER:?REPO_OWNER is required}"
: "${REPO_NAME:?REPO_NAME is required}"

echo "[supervisor] Starting sandbox $SANDBOX_ID for session $SESSION_ID"
echo "[supervisor] Repository: $REPO_OWNER/$REPO_NAME"

# ==================== Git Setup ====================

echo "[supervisor] Configuring git credentials..."

# Install credential helper
chmod +x /app/sandbox/git-credential-helper.sh 2>/dev/null || true
git config --global credential.helper "/app/sandbox/git-credential-helper.sh"

# Set git identity (will be updated per-prompt by bridge)
git config --global user.name "OpenInspect"
git config --global user.email "open-inspect@noreply.github.com"

# Configure git for better performance in containers
git config --global core.compression 0
git config --global http.postBuffer 524288000
git config --global http.lowSpeedLimit 0
git config --global http.lowSpeedTime 999999

# Make gh CLI use our wrapper
chmod +x /app/sandbox/gh-wrapper.sh 2>/dev/null || true
if [ -f /app/sandbox/gh-wrapper.sh ]; then
  # Create symlink so 'gh' command uses our wrapper
  mkdir -p /home/user/.local/bin
  ln -sf /app/sandbox/gh-wrapper.sh /home/user/.local/bin/gh
  export PATH="/home/user/.local/bin:$PATH"
fi

# ==================== Clone Repository ====================

BRANCH="${GIT_BRANCH:-}"
CLONE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"

echo "[supervisor] Cloning repository..."
cd /home/user

if [ -d "$REPO_DIR/.git" ]; then
  echo "[supervisor] Repository already exists, pulling latest..."
  cd "$REPO_DIR"
  git fetch --depth "$CLONE_DEPTH" origin
  if [ -n "$BRANCH" ]; then
    git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH" 2>/dev/null || true
  fi
  git pull --ff-only 2>/dev/null || true
else
  if [ -n "$BRANCH" ]; then
    git clone --depth "$CLONE_DEPTH" --branch "$BRANCH" "$CLONE_URL" "$REPO_DIR" 2>&1 || \
    git clone --depth "$CLONE_DEPTH" "$CLONE_URL" "$REPO_DIR" 2>&1
  else
    git clone --depth "$CLONE_DEPTH" "$CLONE_URL" "$REPO_DIR" 2>&1
  fi
fi

cd "$REPO_DIR"
echo "[supervisor] Repository cloned at $(git rev-parse --short HEAD)"

# ==================== Repo Hooks ====================

SETUP_SCRIPT=".openinspect/setup.sh"
START_SCRIPT=".openinspect/start.sh"

if [ -f "$SETUP_SCRIPT" ]; then
  echo "[supervisor] Running setup hook: $SETUP_SCRIPT"
  chmod +x "$SETUP_SCRIPT"
  timeout "$SETUP_TIMEOUT_SECONDS" bash "$SETUP_SCRIPT" 2>&1 || {
    echo "[supervisor] WARNING: Setup hook failed or timed out (exit code $?)"
  }
fi

if [ -f "$START_SCRIPT" ]; then
  echo "[supervisor] Running start hook: $START_SCRIPT"
  chmod +x "$START_SCRIPT"
  timeout "$START_TIMEOUT_SECONDS" bash "$START_SCRIPT" 2>&1 || {
    echo "[supervisor] WARNING: Start hook failed or timed out (exit code $?)"
  }
fi

# ==================== Copy OpenCode Tools ====================

# Copy tools to OpenCode plugins directory if they exist
TOOLS_SRC="/opt/tools"
OPENCODE_PLUGINS_DIR="$REPO_DIR/.opencode/plugins"

if [ -d "$TOOLS_SRC" ]; then
  mkdir -p "$OPENCODE_PLUGINS_DIR"
  cp -r "$TOOLS_SRC"/* "$OPENCODE_PLUGINS_DIR/" 2>/dev/null || true
  echo "[supervisor] Copied OpenCode tools to $OPENCODE_PLUGINS_DIR"
fi

# ==================== Write Session Config ====================

# OpenCode needs session config as env or file
export SESSION_CONFIG=$(cat <<EOF
{"sessionId":"${SESSION_ID}","repoOwner":"${REPO_OWNER}","repoName":"${REPO_NAME}","branch":"${GIT_BRANCH:-}"}
EOF
)

# ==================== Start OpenCode ====================

echo "[supervisor] Starting OpenCode agent..."
cd "$REPO_DIR"

# Set LLM provider config
export OPENCODE_PROVIDER="${LLM_PROVIDER:-anthropic}"
export OPENCODE_MODEL="${LLM_MODEL:-claude-sonnet-4-6}"

opencode &
OPENCODE_PID=$!

echo "[supervisor] OpenCode started (PID $OPENCODE_PID)"

# Give OpenCode time to start its HTTP server
sleep 3

if ! kill -0 "$OPENCODE_PID" 2>/dev/null; then
  echo "[supervisor] ERROR: OpenCode failed to start"
  exit 1
fi

# ==================== Start Bridge ====================

echo "[supervisor] Starting WebSocket bridge..."
cd "$BRIDGE_DIR"
node index.js &
BRIDGE_PID=$!

sleep 2

if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
  echo "[supervisor] ERROR: Bridge failed to start"
  exit 1
fi

echo "[supervisor] Bridge started (PID $BRIDGE_PID)"

# ==================== Health Monitor ====================

echo "[supervisor] Entering health monitoring loop..."

while true; do
  sleep "$HEALTH_CHECK_INTERVAL_SECONDS" &
  wait $! || break

  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "[supervisor] Bridge process died, shutting down..."
    cleanup
    break
  fi

  if ! kill -0 "$OPENCODE_PID" 2>/dev/null; then
    echo "[supervisor] OpenCode process exited, shutting down..."
    cleanup
    break
  fi
done
