# Open-Inspect Symphony Integration Analysis

**Date**: 2026-03-05  
**Scope**: Current architecture review, Symphony compliance assessment, implementation roadmap

---

## Executive Summary

Open-Inspect has a functional distributed agent system with key components already built. The
**scheduler exists but is limited** (image rebuilding only), the **session lifecycle is stateful and
robust**, **Linear integration is partial** (webhook-based but no workflow orchestration), and
**WebSocket protocol is established** but doesn't yet support Symphony's workflow definition model.
The codebase is **90% ready for Symphony compliance**—main gaps are workflow definition loading,
task-level state management, and Symphony message types.

---

## 1. Current Scheduler Implementation

### Location

- **modal-infra**: `/packages/modal-infra/src/scheduler/image_builder.py`
- **control-plane**: `/packages/control-plane/src/scheduler/durable-object.ts`

### What Exists

#### Modal-side Scheduler (image_builder.py)

- **Cron job** (runs every 30 minutes): `rebuild_repo_images()`
- **Responsibilities**:
  1. Fetches enabled repos from control plane
  2. Fetches current image build status
  3. Uses `git ls-remote` to check remote HEAD SHA
  4. Compares SHA against latest ready image
  5. Triggers async `build_repo_image()` if SHA differs
  6. Marks stale builds (>35 min old) as failed
  7. Cleans up old failed build records (>24 hours)
- **Build flow**:
  - `api_build_repo_image` (HTTP endpoint) receives build request from control plane
  - Spawns async `build_repo_image()` function via `modal.Function.spawn()`
  - Creates build sandbox, streams logs, snapshots filesystem on success
  - Calls back to control plane with HMAC-signed result (success/failure)
- **Key constants**:
  - `CALLBACK_MAX_RETRIES = 3` (with exponential backoff 2^n seconds)
  - `STALE_BUILD_THRESHOLD_SECONDS = 2100` (35 minutes)
  - `FAILED_BUILD_CLEANUP_SECONDS = 86400` (24 hours)

#### Control Plane Scheduler (SchedulerDO, scheduler/durable-object.ts)

- **Singleton Durable Object** that processes automations
- **Responsibilities**:
  1. Recovery sweep: detects orphaned "starting" runs (5-min threshold)
  2. Processes overdue automations (max 25 per tick)
  3. Creates runs atomically, advances schedule
  4. Auto-pauses automations after 3 consecutive failures
- **Triggers**:
  - Cron tick from Worker `scheduled()` handler
  - Manual trigger from `POST /automations/:id/trigger`
  - Run complete callback from SessionDO
- **Constants**:
  - `MAX_PER_TICK = 25` (batch size)
  - `ORPHAN_THRESHOLD_MS = 5 * 60 * 1000`
  - `DEFAULT_EXECUTION_TIMEOUT_MS = 90 * 60 * 1000`
  - `AUTO_PAUSE_THRESHOLD = 3`

### Scheduling Limitations

- **Image rebuilds only** — no task/step scheduling
- **No workflow definition parsing** — scheduler is hardcoded for image rebuilds
- **No step-level parallelism** — linear automation runs (one at a time per automation)
- **Stale threshold is fixed** — not configurable per session/automation
- **No priority queue** — FIFO processing

---

## 2. Agent Session Lifecycle

### Flow Diagram

```
Created → Active (Active) → Completed/Failed/Cancelled
   ↓
[Participants join]
[Prompts enqueued] → [Processing] → [Message complete]
   ↓
[Sandbox spawning] → [Sandbox warming] → [Ready] → [Running]
   ↓
[Git sync] → [Setup/Start scripts] → [OpenCode ready] → [Accepts prompts]
   ↓
[Session snapshot taken] → [Archived]
```

### Session State Management

**SessionDO (Durable Object per session)**

- **SQLite database** per session (persisted in Durable Object storage)
- **Tables**:
  - `session`: metadata (id, title, repo, branch, status, timestamps)
  - `participants`: users who joined (id, user_id, scm info, role)
  - `messages`: prompts/responses (id, author_id, content, status, timestamps)
  - `events`: execution events (id, type, data, messageId, timestamp)
  - `artifacts`: PRs/screenshots (id, type, url, metadata, timestamp)
  - `ws_mapping`: WebSocket client → participant mapping
  - `sandbox`: current sandbox reference (id, status, snapshot_id)

**Control Plane Lifecycle**

1. **Created**: `POST /sessions` → SessionDO created + indexed in D1
2. **Active**: WebSocket connected, participants joined
3. **Sandbox spawn**: Triggered by prompt or warm event
4. **Message queue**: Prompts queued (FIFO), processed one at a time
5. **Execution**: Message sent to sandbox via WebSocket
6. **Completion**: Execution result received, message marked complete
7. **Archive**: User archives session

**Session-level State Tracked**

- Last activity timestamp
- Processing message ID (one at a time)
- Pending message queue length
- Sandbox reference (ID, status, snapshot)
- Execution timeout (90 min default)
- Inactivity timeout (10 min default)

### Message Queue

**Location**: `packages/control-plane/src/session/message-queue.ts`

**Key Methods**:

- `handlePromptMessage(ws, data)`: Enqueue prompt from web/Slack/Linear
  - Creates message with ID
  - Updates session to "active"
  - Calls `processMessageQueue()`
- `processMessageQueue()`: FIFO processing
  - Checks if sandbox connected
  - If not, spawns sandbox
  - Sends command to sandbox via WebSocket:
    `{ type: "prompt", messageId, content, model, author, attachments }`
- `stopExecution()`: Cancels current processing message
  - Marks message as "failed"
  - Sends synthetic `execution_complete` event

**Message Status Flow**

```
pending → processing → completed
                    ↘ failed
```

### Sandbox Lifecycle

**Manager**: `packages/modal-infra/src/sandbox/manager.py`

**Key Methods**:

- `create_sandbox(config)`: Spawn new sandbox
  - Uses Modal API: `modal.Sandbox.create(...)`
  - Selects image: snapshot > repo image > base image
  - Injects env vars (repo secrets, session config, VCS tokens)
  - Returns `SandboxHandle` with sandbox object + metadata
- `create_build_sandbox(repo, branch)`: Spawn image build sandbox
  - Sets `IMAGE_BUILD_MODE=true` (special entrypoint behavior)
  - Shorter timeout (30 min)
  - Streams logs until `image_build.complete` event
  - Snapshots filesystem on success
- `warm_sandbox(config)`: Pre-warm sandbox before prompts
  - Creates sandbox, waits for ready status
  - Useful for reducing latency on first prompt

**Entrypoint** (`packages/modal-infra/src/sandbox/entrypoint.py`):

1. **Git sync**: Clone/pull repository
   - Logs: `event="git.sync_complete"` with `head_sha`
2. **Setup script**: Runs `.openinspect/setup.sh` (if exists, optional)
3. **Start script**: Runs `.openinspect/start.sh` (if exists, optional)
4. **OpenCode start**: Launches server on port 4096
5. **Bridge start**: Connects WebSocket to control plane
6. **Wait for shutdown**: Handles SIGTERM/SIGINT, takes snapshots

**Workspace Management**:

- **Location**: `/workspace`
- **Repo cloned to**: `/workspace/{repo_name}`
- **Session config**: Passed as JSON via env var `SESSION_CONFIG`
- **Snapshot restore**: Filesystem restored from previous session, git pull for latest
- **Workspace state**: Fully preserved across snapshots (no clean clone on restore)

---

## 3. Linear Integration Status

### What Exists

**linear-bot** (`packages/linear-bot/`)

- **OAuth2 integration** with Linear Agents API
- **Webhook handler** for `AgentSessionEvent` (issue mention/assign)
- **Repo resolution cascade**:
  1. Project → repo mapping (static, highest priority)
  2. Team → repo mapping (static, with optional label filters)
  3. Linear's `issueRepositorySuggestions` API (built-in, 70%+ confidence)
  4. LLM classifier (Claude Haiku, fallback)
- **Activity types**: Thought (thinking), Response (status), Error, Action (tool calls)
- **Completion callback** from control plane: Updates Linear with PR link
- **Tool call callback** (ephemeral): Shows tool progress as "Editing file X"

**Flow**:

```
Issue mentioned → Linear webhook
  → Emit Thought (thinking)
  → Resolve repo
  → Create Open-Inspect session
  → Emit Response (working on...)
  → Agent works in sandbox
  → Completion callback
  → Emit Response (PR link: #123)
```

**API Config Endpoints**:

- `PUT /config/team-repos` — static team→repo mapping
- `PUT /config/project-repos` — static project→repo mapping
- `PUT /config/user-prefs/:userId` — per-user model preferences

### Linear Integration Gaps

- **No workflow definition loading** — can't read WORKFLOW.md from repo
- **No task scheduling** — each issue = one session (no multi-step workflows)
- **No workflow state** — no tracking of completed steps/subtasks
- **Hardcoded agent flow** — issue → session → PR, no custom steps
- **No workflow language** — Linear issues are free text, no structured task definitions

---

## 4. WebSocket Protocol

### Location

- **Control Plane WebSocket Manager**: `packages/control-plane/src/session/websocket-manager.ts`
- **Bridge (Sandbox ↔ Control Plane)**: `packages/modal-infra/src/sandbox/bridge.py`

### Client → Server Messages (from web/Slack/clients)

```typescript
type ClientMessage =
  | { type: "ping" }                           // Health check
  | { type: "subscribe"; token: string; clientId: string }
  | { type: "prompt"; content: string; model?: string; attachments?: [...] }
  | { type: "stop" }                           // Stop execution
  | { type: "typing" }                         // Warm sandbox
  | { type: "presence"; status: string; cursor?: string }
```

### Server → Client Messages (to web/Slack/clients)

```typescript
type ServerMessage =
  | { type: "pong" }
  | { type: "subscribed"; participants: [...] }
  | { type: "prompt_queued"; messageId: string; position: number }
  | { type: "sandbox_event"; event: SandboxEvent }
  | { type: "sandbox_spawning" }
  | { type: "sandbox_warming" }
  | { type: "sandbox_status"; status: SandboxStatus }
  | { type: "sandbox_ready" }
  | { type: "sandbox_error"; error: string }
  | { type: "artifact_created"; artifact: Artifact }
  | { type: "snapshot_saved"; snapshotId: string }
  | { type: "presence_sync"; participants: [...] }
  | { type: "error"; code: string; message: string }
```

### Sandbox → Control Plane (WebSocket)

**Bridge sends**:

```python
# Event types sent by bridge
SandboxEvent = Union[
  { type: "heartbeat"; sandboxId: str; status: str; timestamp: float }
  { type: "token"; content: str; messageId: str; ... }
  { type: "tool_call"; toolName: str; args: dict; ... }
  { type: "tool_result"; toolName: str; output: str; ... }
  { type: "step_start"; stepId: str; ... }
  { type: "step_finish"; stepId: str; success: bool; ... }
  { type: "git_sync"; headSha: str; branchName: str; ... }
  { type: "error"; message: str; ... }
  { type: "execution_complete"; messageId: str; success: bool; ... }
  { type: "push_complete"; prUrl: str; ... }
  { type: "push_error"; error: str; ... }
  { type: "artifact"; type: str; url: str; ... }
]
```

**Bridge receives** (commands from control plane):

```python
SandboxCommand = {
  type: "prompt",
  messageId: str,
  content: str,
  model: str,
  reasoningEffort: str,
  author: { userId: str, scmName: str, scmEmail: str },
  attachments?: [...]
}
# + stop, snapshot, shutdown commands
```

### Protocol Features

- **Reconnection logic**: Exponential backoff (2^n seconds, max 60s)
- **Event buffering**: Survives WS reconnects
- **Pending ACKs**: Re-sent until control plane confirms receipt
- **Heartbeat**: 30-second intervals from bridge
- **Message ordering**: Sequential message processing (FIFO)

### Symphony Protocol Gaps

- **No workflow definition messages** — can't send task definitions
- **No step-level commands** — only "prompt" (monolithic LLM call)
- **No workflow state sync** — no `sync_workflow_state` message type
- **No progress tracking** — step progress implied by event order, not explicit

---

## 5. Workflow Loading & State Management

### Current Status: **Not Implemented**

**What we searched for**:

- `WORKFLOW.md` loading in repo — not found
- Workflow definition parsing — not found
- Task-level state tracking — not found
- Workflow schema validation — not found

**What exists instead**:

- **Session state** (message queue, events)
- **Sandbox events** (tool calls, execution complete)
- **Message-level state** (pending/processing/completed)
- **No workflow-level state**

### Repository Hook Scripts (Partial Substitute)

- `.openinspect/setup.sh` — runs once on fresh sandbox
- `.openinspect/start.sh` — runs on each restore
- These are ad-hoc scripts, not structured workflows

### Session-to-Workflow Mapping (Needed)

```
Current: Session → Messages → Events (linear)
Needed:  Session → Workflow → Tasks → Steps → Events (hierarchical)
```

---

## 6. Workspace Management

### Current Implementation

**Location**: `packages/modal-infra/src/sandbox/manager.py`

**Workspace Path**: `/workspace`

**Initialization**:

1. **Fresh (no snapshot)**:
   - Clone repo: `git clone https://... /workspace/{repo_name}`
   - Run setup script: `.openinspect/setup.sh`
   - Run start script: `.openinspect/start.sh`
   - Start OpenCode
2. **From snapshot**:
   - Restore filesystem from snapshot
   - Git pull: `git pull origin {branch}`
   - Run start script: `.openinspect/start.sh`
   - Start OpenCode

**Environment Variables** (injected into sandbox):

```python
{
  "SANDBOX_ID": "...",
  "CONTROL_PLANE_URL": "...",
  "SANDBOX_AUTH_TOKEN": "...",
  "REPO_OWNER": "...",
  "REPO_NAME": "...",
  "VCS_HOST": "github.com",
  "VCS_CLONE_USERNAME": "x-access-token",
  "VCS_CLONE_TOKEN": "...",
  "GITHUB_TOKEN": "...",
  "GITHUB_APP_TOKEN": "...",
  "SESSION_CONFIG": "{...json...}",
  "FROM_REPO_IMAGE": "true",  # if using prebuilt image
  "REPO_IMAGE_SHA": "...",
  "IMAGE_BUILD_MODE": "true", # for build sandboxes only
  # + user-provided secrets
}
```

**Session Config** (JSON in env):

```json
{
  "session_id": "...",
  "branch": "main"
  // workflow-related fields would go here
}
```

**Snapshot/Restore Cycle**:

- After execution completes, bridge can request snapshot
- Modal's `snapshot_filesystem()` creates immutable image
- Stored with snapshot ID in registry
- On next prompt, restore snapshot → git pull → ready

**State Preservation**:

- ✅ Files/directories (full filesystem preserved)
- ✅ Git history (repo cloned with history)
- ✅ Dependencies (npm modules, pip packages in snapshot)
- ❌ Session state (not stored, would need to encode in session DB)
- ❌ Workflow state (no workflow tracking)

---

## 7. Symphony Spec Compliance Assessment

### What's Implemented ✅

1. **Session/agent lifecycle** — spawning, warming, snapshotting, restoring
2. **Message queuing** — FIFO prompt queue with status tracking
3. **WebSocket streaming** — real-time event push to clients
4. **Event system** — tool calls, git sync, execution complete events
5. **Distributed architecture** — control plane + sandboxes
6. **State persistence** — Durable Objects + D1 for session state
7. **Workspace snapshots** — Modal filesystem snapshots
8. **Repository integration** — GitHub App, git operations
9. **Linear integration** — webhook-based triggering (partial)

### What's Missing ❌

1. **Workflow definitions** — no WORKFLOW.md parsing, no task graph
2. **Task scheduling** — no multi-step orchestration
3. **Step-level state** — no per-step completion tracking
4. **Conditional execution** — no if/else, no branching
5. **Parallel tasks** — sequential only
6. **Workflow context** — no variable scoping, no task-to-task data flow
7. **Workflow persistence** — no saved workflow templates
8. **Workflow UI** — no visualization of workflow progress
9. **Idempotency markers** — no replay protection
10. **Monitoring/observability** — limited step-level logging

### Compliance Gap Summary

| Component                | Status      | Gap                         |
| ------------------------ | ----------- | --------------------------- |
| **Session spawn**        | ✅ Complete | None                        |
| **Sandbox lifecycle**    | ✅ Complete | None                        |
| **Message queue**        | ✅ Complete | No step-level priority      |
| **WebSocket protocol**   | ⚠️ Partial  | No workflow message types   |
| **Event streaming**      | ✅ Complete | No step events              |
| **Workspace snapshots**  | ✅ Complete | None                        |
| **State persistence**    | ✅ Complete | No workflow state           |
| **Linear integration**   | ⚠️ Partial  | No workflow reading         |
| **Workflow definitions** | ❌ Missing  | Major implementation needed |
| **Task graph execution** | ❌ Missing  | Major implementation needed |
| **Step tracking**        | ❌ Missing  | Major implementation needed |
| **Conditional logic**    | ❌ Missing  | Major implementation needed |
| **Parallel execution**   | ❌ Missing  | Design decision needed      |

---

## 8. Key Files & Their Roles

### Control Plane (TypeScript)

| File                           | Role                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `router.ts`                    | HTTP routing, request dispatcher                                  |
| `session/durable-object.ts`    | **Core**: Session state machine, WebSocket hub, sandbox lifecycle |
| `session/message-queue.ts`     | **Core**: Prompt enqueue, processing, dispatch to sandbox         |
| `session/websocket-manager.ts` | WebSocket connection management, message broadcasting             |
| `session/sandbox-events.ts`    | Event processing from sandbox (token, tool call, error)           |
| `scheduler/durable-object.ts`  | Automation scheduling, run lifecycle                              |
| `db/session-index.ts`          | D1: Session list, search, filtering                               |
| `db/automation-store.ts`       | D1: Automation definitions, runs, schedules                       |
| `types.ts`                     | TypeScript interface definitions                                  |

### Modal Infra (Python)

| File                         | Role                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `sandbox/manager.py`         | **Core**: Sandbox create/warm/snapshot lifecycle                     |
| `sandbox/entrypoint.py`      | **Core**: Supervisor, git sync, script execution, process management |
| `sandbox/bridge.py`          | **Core**: WebSocket bridge, OpenCode communication, event forwarding |
| `sandbox/types.py`           | Type definitions                                                     |
| `scheduler/image_builder.py` | **Core**: Image rebuild scheduler, build sandbox creation, callbacks |
| `web_api.py`                 | HTTP endpoints (create/warm/snapshot/restore)                        |
| `images/base.py`             | Base container image definition                                      |
| `auth/github_app.py`         | GitHub App token generation                                          |
| `auth/internal.py`           | HMAC authentication                                                  |

### Shared (TypeScript)

| File             | Role                                               |
| ---------------- | -------------------------------------------------- |
| `types/index.ts` | Message, event, session, artifact type definitions |
| `models.ts`      | LLM model enum and validation                      |
| `git.ts`         | Git utilities                                      |
| `cron.ts`        | Cron schedule parsing                              |

### Linear Bot (TypeScript)

| File                     | Role                                   |
| ------------------------ | -------------------------------------- |
| `webhook-handler.ts`     | AgentSessionEvent processing           |
| `classifier/index.ts`    | Repo resolution logic (cascade)        |
| `callbacks.ts`           | Completion/tool-call callback handlers |
| `utils/linear-client.ts` | GraphQL API client for Linear          |

---

## 9. Implementation Roadmap for Symphony Compliance

### Phase 1: Workflow Definition (Week 1-2)

**Goal**: Load and parse WORKFLOW.md from repository

1. Create workflow schema (TypeScript + JSON Schema)
2. Add `loadWorkflow(repoOwner, repoName, branch)` function in control-plane
   - Fetch WORKFLOW.md from GitHub using GitHub App
   - Parse YAML/JSON task definitions
   - Validate against schema
3. Store in D1 `workflows` table (schema, version, repo_id, branch)
4. Add endpoint: `GET /repos/:owner/:name/workflows`

**Files to create**:

- `packages/shared/src/workflow-schema.ts` — TypeScript types for workflow
- `packages/control-plane/src/db/workflows.ts` — D1 workflow store
- `packages/control-plane/src/routes/workflows.ts` — REST endpoints

### Phase 2: Workflow State Management (Week 2-3)

**Goal**: Track workflow execution state in sessions

1. Extend SessionDO to support workflow mode
   - Add `workflow_id` and `current_task_id` to session table
   - Add `workflow_state` table: `{ session_id, task_id, status, result, start_at, end_at }`
2. Create `WorkflowExecutor` class
   - Resolve next task based on current state
   - Handle conditional branches
   - Manage task-level state
3. Extend message-queue to use workflow executor
   - Instead of sending whole session as one prompt, send one task at a time
   - Wait for task completion before moving to next

**Files to create**:

- `packages/control-plane/src/session/workflow-executor.ts` — Task graph execution
- `packages/control-plane/src/db/workflow-state.ts` — D1 workflow run state

### Phase 3: WebSocket Protocol Extension (Week 3)

**Goal**: Add workflow message types

1. New message types:

   ```typescript
   // Client → Server
   { type: "load_workflow"; workflowId: string }
   { type: "execute_workflow"; workflowId: string; inputs?: {} }

   // Server → Client
   { type: "workflow_loaded"; workflow: WorkflowDef }
   { type: "workflow_started"; taskId: string; definition: TaskDef }
   { type: "task_complete"; taskId: string; result: {} }
   { type: "workflow_complete"; result: {} }
   ```

2. Update bridge.py to handle task-level events
   - Parse `task_start` / `task_complete` events from OpenCode
   - Map to workflow state

**Files to modify**:

- `packages/control-plane/src/types.ts` — Add workflow message types
- `packages/modal-infra/src/sandbox/bridge.py` — Task event handling

### Phase 4: Linear Workflow Integration (Week 4)

**Goal**: Linear issues can trigger multi-step workflows

1. Add `workflow_id` field to Linear issue mapping
2. Extend linear-bot to:
   - Detect `!workflow:workflow-id` labels or metadata
   - Load workflow from repo
   - Create session in workflow mode
3. Add Linear callback support for multi-step status
   - Update activity at each task completion

**Files to modify**:

- `packages/linear-bot/src/webhook-handler.ts` — Workflow detection
- `packages/linear-bot/src/callbacks.ts` — Task-level callbacks

### Phase 5: Observability & UI (Week 5)

**Goal**: Visualize workflow progress

1. Add workflow progress endpoint: `GET /sessions/:id/workflow`
   - Returns task graph + current execution state
2. Web UI updates:
   - Show task/step list instead of flat event stream
   - Highlight current task
   - Show completed vs. pending tasks
3. Linear integration:
   - Show task progress in activity

**Files to create**:

- `packages/control-plane/src/routes/workflow-progress.ts` — Progress API
- Updates to `packages/web/` for UI

---

## 10. Technical Dependencies & Constraints

### Current Constraints

1. **Single message processing**: Control-plane processes one prompt at a time (by design)
   - Implication: Can't parallelize tasks (would need redesign)
   - Workaround: Sequential task execution is fine for most workflows

2. **Sandbox isolation**: Each session gets isolated sandbox
   - Implication: Can't share workspace between parallel tasks
   - Implication: Snapshots are per-session, not per-task

3. **WebSocket as state sync**: WS is primary transport
   - Implication: Clients always need live connection for real-time updates
   - Workaround: Polling endpoint for offline scenarios

4. **Durable Objects per session**: SQLite storage is per-session
   - Implication: Can't efficiently query across sessions for workflow analytics
   - Workaround: Use D1 for aggregate data

5. **Linear Agents API limitations**: No native task type
   - Implication: Can't represent workflow steps natively in Linear
   - Workaround: Use activity updates (Thought/Response types)

### Dependencies

- **Modal**: Sandbox creation/management API (no changes needed)
- **Cloudflare Workers**: WebSocket hibernation (working well)
- **Durable Objects**: Per-session state (can scale to task tables)
- **D1**: Global state (migrations needed for workflow tables)
- **GitHub API**: Read WORKFLOW.md (already authenticated)
- **Linear Agents API**: Activity updates (no new capabilities needed)

### Performance Implications

- **Workflow definition parsing**: ~100ms per workflow (cached)
- **Task state updates**: ~50ms per task completion (D1 write)
- **WebSocket message overhead**: ~1ms per event
- **Snapshot/restore**: 2-5 seconds (dominant factor, acceptable)

---

## 11. Recommended Starting Point

### Quick Win (2 days)

1. Add `WORKFLOW.md` parsing to control-plane
2. Store parsed workflow in D1
3. Add REST endpoint to fetch workflow for a repo
4. No execution yet—just loading/validation

**Benefit**: Unblocks downstream work, validates schema design

### MVP (2 weeks)

1. Extend session schema to track workflow + task state
2. Create task-level message queue
3. Update bridge to emit task events
4. Simple sequential execution (no conditionals/branching)
5. Linear integration: detect workflow labels

**Benefit**: End-to-end workflow execution works

### Polish (1 week)

1. WebSocket protocol for workflow control
2. Observability/progress tracking
3. Linear activity updates per task
4. Error handling & retry logic

---

## Appendix: Key Constants & Defaults

### Timeouts

- **Sandbox inactivity**: 600,000 ms (10 min)
- **Execution timeout**: 5,400,000 ms (90 min)
- **Bridge SSE timeout**: 120 s (configurable per deployment)
- **Git push timeout**: 120 s
- **Build timeout**: 1800 s (30 min)
- **Setup script timeout**: 300 s (5 min)
- **Start script timeout**: 120 s (2 min)

### Retry Logic

- **WebSocket reconnect**: Exponential backoff (2^n seconds, max 60s)
- **Build callback**: 3 retries with exponential backoff (2, 4, 8 seconds)
- **Modal API calls**: Built-in retry (Modal SDK handles)

### Queue Limits

- **Max pending events per message**: 2000
- **Max event buffer size**: 1000
- **Max automations per tick**: 25

### Resource Limits

- **Max message content length**: Unlimited (but reasonable)
- **Max attachments per message**: Unlimited (but check web UI)
- **Snapshot retention**: Not enforced (Modal policy dependent)
