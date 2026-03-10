# @open-inspect/sandbox

Container image for the Cloudflare Sandbox SDK runtime.

## Overview

This package defines the container that runs inside Cloudflare's sandbox infrastructure. It
provides:

- **Node 22 runtime** with git, curl, and GitHub CLI pre-installed
- **OpenCode agent** installed globally for AI-powered coding
- **WebSocket bridge** for bidirectional communication with the control plane
- **Supervisor** for process lifecycle management and health monitoring

## Architecture

```
┌─────────────────────────────────────────┐
│  Cloudflare Sandbox Container           │
│                                         │
│  ┌─────────────┐  ┌──────────────────┐  │
│  │  supervisor  │  │                  │  │
│  │  (bash)      │──│  health monitor  │  │
│  └──────┬───────┘  └──────────────────┘  │
│         │                                │
│  ┌──────┴───────┐  ┌──────────────────┐  │
│  │   OpenCode   │  │     bridge       │  │
│  │   (agent)    │  │  (WebSocket →    │  │
│  │              │  │   control plane) │  │
│  └──────────────┘  └──────────────────┘  │
│                                         │
│  /home/user/repo  ← working directory   │
└─────────────────────────────────────────┘
```

## Components

### Supervisor (`supervisor.sh`)

Bash script that orchestrates the container lifecycle:

- Validates required environment variables
- Starts the WebSocket bridge process
- Starts the OpenCode agent
- Monitors both processes and shuts down if either exits
- Handles SIGTERM/SIGINT for graceful shutdown with a configurable grace period

### Bridge (`bridge/index.ts`)

Node.js WebSocket client that connects outbound to the control plane SessionAgent:

- Automatic reconnection with exponential backoff
- Heartbeat/pong-based health checking
- Forwards agent events upstream to the control plane
- Receives prompts and commands from the control plane

### Environment Variables

| Variable              | Required | Description                           |
| --------------------- | -------- | ------------------------------------- |
| `CONTROL_PLANE_URL`   | Yes      | Control plane base URL                |
| `SESSION_ID`          | Yes      | Session ID for WebSocket routing      |
| `SANDBOX_ID`          | Yes      | Sandbox identifier                    |
| `SANDBOX_AUTH_TOKEN`  | Yes      | Auth token for control plane          |
| `REPO_OWNER`          | Yes      | GitHub repository owner               |
| `REPO_NAME`           | Yes      | GitHub repository name                |
| `LLM_PROVIDER`        | Yes      | LLM provider (e.g., "anthropic")      |
| `LLM_MODEL`           | Yes      | LLM model identifier                  |
| `GIT_BRANCH`          | No       | Git branch to work on                 |
| `OPENCODE_SESSION_ID` | No       | OpenCode session ID for resumption    |
| `REPO_IMAGE_ID`       | No       | Pre-built repo image ID               |
| `REPO_IMAGE_SHA`      | No       | Git SHA the repo image was built from |

## Building

```bash
docker build -t open-inspect/sandbox:latest packages/sandbox/
```

## Snapshots

The Cloudflare Sandbox SDK supports squashfs-based directory backups:

- **Backup**: Creates a squashfs snapshot of `/home/user/repo`, stored in R2
- **Restore**: Mounts the squashfs as a read-only FUSE lower layer with copy-on-write upper
- Snapshots have a default TTL of 3 days (259200 seconds)
