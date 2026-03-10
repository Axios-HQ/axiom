#!/usr/bin/env bash
# Supervisor for Cloudflare sandbox container.
#
# Starts the WebSocket bridge and OpenCode agent, monitors health,
# and handles graceful shutdown.

set -euo pipefail

# ==================== Configuration ====================

BRIDGE_DIR="/opt/bridge"
HEALTH_CHECK_INTERVAL_SECONDS=30
SHUTDOWN_GRACE_PERIOD_SECONDS=10

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

  # Send SIGTERM to child processes
  if [ -n "$OPENCODE_PID" ] && kill -0 "$OPENCODE_PID" 2>/dev/null; then
    echo "[supervisor] Stopping OpenCode (PID $OPENCODE_PID)..."
    kill -TERM "$OPENCODE_PID" 2>/dev/null || true
  fi

  if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "[supervisor] Stopping bridge (PID $BRIDGE_PID)..."
    kill -TERM "$BRIDGE_PID" 2>/dev/null || true
  fi

  # Wait for graceful shutdown
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

  # Force kill if still alive
  if [ -n "$OPENCODE_PID" ] && kill -0 "$OPENCODE_PID" 2>/dev/null; then
    echo "[supervisor] Force killing OpenCode..."
    kill -9 "$OPENCODE_PID" 2>/dev/null || true
  fi
  if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "[supervisor] Force killing bridge..."
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

echo "[supervisor] Starting sandbox $SANDBOX_ID for session $SESSION_ID"

# ==================== Start Bridge ====================

echo "[supervisor] Starting WebSocket bridge..."
node "$BRIDGE_DIR/index.js" &
BRIDGE_PID=$!

# Give bridge time to connect
sleep 2

if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
  echo "[supervisor] ERROR: Bridge failed to start"
  exit 1
fi

echo "[supervisor] Bridge started (PID $BRIDGE_PID)"

# ==================== Start OpenCode ====================

echo "[supervisor] Starting OpenCode agent..."
opencode &
OPENCODE_PID=$!

echo "[supervisor] OpenCode started (PID $OPENCODE_PID)"

# ==================== Health Monitor ====================

echo "[supervisor] Entering health monitoring loop..."

while true; do
  sleep "$HEALTH_CHECK_INTERVAL_SECONDS" &
  wait $! || break  # Break on signal

  # Check bridge health
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "[supervisor] Bridge process died, shutting down..."
    cleanup
    break
  fi

  # Check OpenCode health
  if ! kill -0 "$OPENCODE_PID" 2>/dev/null; then
    echo "[supervisor] OpenCode process exited, shutting down..."
    cleanup
    break
  fi
done
