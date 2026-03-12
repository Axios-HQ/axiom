#!/usr/bin/env bash
# Deploy control plane with Cloudflare Containers support.
#
# This script:
# 1. Builds the control plane bundle
# 2. Sets secrets via wrangler secret bulk (secrets persist at worker level)
# 3. Deploys with wrangler using the containers overlay config
#
# Prerequisites:
# - Docker running (for container image build)
# - CLOUDFLARE_API_TOKEN set or wrangler logged in
# - terraform.tfvars accessible for secret values
#
# Usage:
#   ./scripts/deploy-containers.sh
#   ./scripts/deploy-containers.sh --dry-run
#   ./scripts/deploy-containers.sh --skip-secrets  # if secrets already set

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"
TF_DIR="$ROOT_DIR/terraform/environments/production"
CP_DIR="$ROOT_DIR/packages/control-plane"

DRY_RUN=false
SKIP_SECRETS=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --skip-secrets) SKIP_SECRETS=true ;;
  esac
done

# ==================== Build ====================

echo "==> Building @open-inspect/shared..."
npm run build -w @open-inspect/shared

echo "==> Building @open-inspect/control-plane..."
npm run build -w @open-inspect/control-plane

# ==================== Secrets ====================

if [ "$SKIP_SECRETS" = false ]; then
  echo "==> Setting worker secrets via wrangler secret bulk..."

  # Read secret values from terraform.tfvars
  get_tfvar() {
    local key="$1"
    # Handle multi-line values (like private keys) by reading the heredoc
    if grep -q "^${key}.*<<-" "$TF_DIR/terraform.tfvars"; then
      # Multi-line heredoc value
      sed -n "/^${key}/,/^EOF$/p" "$TF_DIR/terraform.tfvars" | sed '1d;$d'
    else
      # Single-line value
      grep "^${key}" "$TF_DIR/terraform.tfvars" | sed 's/.*= *"\(.*\)"/\1/' | head -1
    fi
  }

  # Build JSON for wrangler secret bulk
  SECRETS_JSON=$(cat <<JSONEOF
{
  "GITHUB_CLIENT_SECRET": "$(get_tfvar github_client_secret)",
  "TOKEN_ENCRYPTION_KEY": "$(get_tfvar token_encryption_key)",
  "REPO_SECRETS_ENCRYPTION_KEY": "$(get_tfvar repo_secrets_encryption_key)",
  "MODAL_TOKEN_ID": "$(get_tfvar modal_token_id)",
  "MODAL_TOKEN_SECRET": "$(get_tfvar modal_token_secret)",
  "MODAL_API_SECRET": "$(get_tfvar modal_api_secret)",
  "INTERNAL_CALLBACK_SECRET": "$(get_tfvar internal_callback_secret)",
  "GITHUB_APP_ID": "$(get_tfvar github_app_id)",
  "GITHUB_APP_INSTALLATION_ID": "$(get_tfvar github_app_installation_id)",
  "ANTHROPIC_API_KEY": "$(get_tfvar anthropic_api_key)",
  "OPENAI_API_KEY": "$(get_tfvar openai_api_key)"
}
JSONEOF
)

  # GitHub App private key needs special handling (multi-line)
  GITHUB_APP_KEY=$(get_tfvar github_app_private_key)

  if [ "$DRY_RUN" = true ]; then
    echo "[dry-run] Would set 11 secrets + GITHUB_APP_PRIVATE_KEY via wrangler secret bulk"
  else
    cd "$CP_DIR"
    echo "$SECRETS_JSON" | npx wrangler secret bulk --config wrangler.containers.toml

    # Set the private key separately (multi-line)
    echo "$GITHUB_APP_KEY" | npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config wrangler.containers.toml
    cd "$ROOT_DIR"
  fi
fi

# ==================== Deploy ====================

echo "==> Deploying control plane with Cloudflare Containers..."
cd "$CP_DIR"

if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would run: npx wrangler deploy --config wrangler.containers.toml"
  echo ""
  echo "[dry-run] Config file:"
  cat wrangler.containers.toml
else
  npx wrangler deploy --config wrangler.containers.toml
fi

echo "==> Done."
