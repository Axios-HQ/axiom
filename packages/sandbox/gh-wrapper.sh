#!/bin/bash
# Wrapper for gh CLI that reads a refreshed GitHub token if available.
# Falls back to GITHUB_TOKEN env var if no refreshed token exists.

if [ -f /tmp/.github-token ]; then
  export GITHUB_TOKEN
  GITHUB_TOKEN=$(cat /tmp/.github-token)
fi

exec /usr/bin/gh "$@"
