#!/usr/bin/env bash
# Build and run the sandbox container locally for testing.
# Reads config from .env.local (gitignored).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load env
if [ ! -f .env.local ]; then
  echo "Error: .env.local not found. Copy .env.local.example and fill in values."
  exit 1
fi

set -a
source .env.local
set +a

# Validate required vars
for var in CONTROL_PLANE_URL SESSION_ID SANDBOX_ID SANDBOX_AUTH_TOKEN; do
  if [ -z "${!var:-}" ]; then
    echo "Error: $var is required in .env.local"
    exit 1
  fi
done

echo "Building sandbox container..."
docker build -t open-inspect-sandbox .

echo "Running sandbox container..."
echo "  CONTROL_PLANE_URL=$CONTROL_PLANE_URL"
echo "  SESSION_ID=$SESSION_ID"
echo "  SANDBOX_ID=$SANDBOX_ID"

docker run --rm -it \
  -e CONTROL_PLANE_URL="$CONTROL_PLANE_URL" \
  -e SESSION_ID="$SESSION_ID" \
  -e SANDBOX_ID="$SANDBOX_ID" \
  -e SANDBOX_AUTH_TOKEN="$SANDBOX_AUTH_TOKEN" \
  -e GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
  -e CHROME_PATH=/usr/bin/chromium \
  open-inspect-sandbox
