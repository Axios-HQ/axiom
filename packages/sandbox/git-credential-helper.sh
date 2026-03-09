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
