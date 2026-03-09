# Screenshot-to-Slack/Linear Design

**Goal:** Give the sandbox agent the ability to take screenshots using `agent-browser`, upload them
to R2, and deliver them as inline images in Slack threads and Linear issue comments — both on-demand
(agent decides) and on session completion.

**Branch:** `feat/axiom-cloudflare`

---

## Architecture

```
Sandbox Container (agent-browser + Chromium)
  → agent-browser screenshot /tmp/shot.png
  → send-update tool reads file, uploads to R2 via /api/media/upload
  → send-update POSTs { message, screenshotUrl } to /agent-update on control plane
  → control plane emits screenshot artifact + broadcasts to WebSocket clients

On session completion:
  → slack-bot extracts screenshot artifacts → posts Slack image blocks inline
  → linear-bot extracts screenshot artifacts → embeds markdown ![img](url)
```

**Key decisions:**

- **agent-browser bundled in sandbox container** — the agent needs to screenshot localhost dev
  servers running inside its own container, which only works from inside
- **No new agent tools** — existing `send-update` already handles screenshotPath upload +
  notification
- **R2 for storage** — existing `upload-media` / R2MediaService infrastructure, public URLs with
  cache headers
- **Inline images, not links** — Slack `image` blocks and Linear markdown `![](url)` for real visual
  feedback

---

## Components

### 1. Sandbox Container (`packages/sandbox/Dockerfile`)

Add agent-browser and Chromium to the Cloudflare sandbox container image.

**Changes:**

- Install Chromium + system dependencies (libnss3, libatk-bridge2.0-0, libxkbcommon0, fonts)
- Install agent-browser globally via npm
- Environment variable `CHROME_PATH` pointing to system Chromium

**Result:** Agent can run `agent-browser open http://localhost:3000` and
`agent-browser screenshot /tmp/shot.png` as shell commands.

### 2. Local Dev Runner (`packages/sandbox/dev.sh`)

Shell script + docker-compose to test the sandbox locally against a deployed or local control plane.

**What it does:**

- Builds the sandbox container image
- Reads config from `packages/sandbox/.env.local` (gitignored)
- Runs the container with the right env vars
- Supports pointing at either a deployed CP or local wrangler dev

**Usage:**

```bash
cd packages/sandbox
cp .env.local.example .env.local  # fill in values
./dev.sh                           # build + run
```

### 3. Control Plane — `/agent-update` endpoint

The `send-update` tool POSTs to `/sessions/{id}/agent-update` but this route doesn't exist yet.

**Endpoint:** `POST /sessions/:sessionId/agent-update` **Auth:** Bearer sandbox auth token (same as
WebSocket auth) **Body:** `{ message: string, screenshotUrl?: string }`

**Behavior:**

1. Validate sandbox auth token
2. If `screenshotUrl` present, create a screenshot artifact via `repository.createArtifact()` with
   `type: "screenshot"`, `url: screenshotUrl`
3. Broadcast the update as a sandbox event to all WebSocket clients:
   ```json
   { "type": "token", "content": "📸 Agent update: {message}", "timestamp": ... }
   ```
4. If screenshot artifact created, also broadcast artifact event
5. Return 200

### 4. Control Plane — Wire media routes into router

The R2 media routes exist (`packages/control-plane/src/routes/media.ts`) but are NOT wired into the
router. Need to add `mediaRoutes` to the routes array in `router.ts`.

### 5. Slack Bot — Inline Screenshot Images

**File:** `packages/slack-bot/src/completion/blocks.ts`

After the text section block, before the context block, insert `image` blocks for each screenshot
artifact:

```typescript
for (const artifact of response.artifacts.filter((a) => a.type === "screenshot")) {
  blocks.push({
    type: "image",
    image_url: artifact.url,
    alt_text: artifact.label || "Screenshot",
  });
}
```

Slack Block Kit `image` blocks render the image inline in the thread. The R2 URL must be publicly
accessible (it already is — R2MediaService serves with public cache headers).

Also handle screenshot artifacts in the `send-update` mid-session path: when `agent-update` callback
fires (not just completion), post the screenshot to the Slack thread immediately so the user sees it
in real time.

### 6. Linear Bot — Inline Screenshot Images

**File:** `packages/linear-bot/src/completion/extractor.ts` (formatAgentResponse)

Embed screenshot artifacts as markdown images in the Linear comment body:

```markdown
![Screenshot](https://r2-url/sessions/xxx/uuid.png)
```

Linear's markdown renderer supports inline images. For the Agent API path, include the image in the
`agentActivityCreate` content body.

### 7. Web UI — Screenshot in Timeline

When a screenshot artifact event arrives via WebSocket, render it inline in the session timeline.
Add handling in `EventItem` for artifact events with `type: "screenshot"`:

```tsx
case "artifact":
  if (event.artifactType === "screenshot" && event.url) {
    return (
      <div className="rounded-xl overflow-hidden border border-border-muted">
        <img src={event.url} alt="Screenshot" className="w-full" />
      </div>
    );
  }
```

### 8. Completion Flow — Auto-Screenshot on Session Complete

Optional: before the agent's execution_complete event, if a dev server is running (preview artifact
exists), automatically take a screenshot and attach it. This happens in the bridge or supervisor
when it detects execution finishing.

This is a nice-to-have and can be deferred — the agent can take screenshots explicitly via
`send-update` at any point during the session.

---

## Data Flow

### Mid-session screenshot (agent-initiated):

```
1. Agent: agent-browser open http://localhost:3000
2. Agent: agent-browser screenshot /tmp/shot.png
3. Agent: calls send-update tool with message + screenshotPath
4. send-update: reads /tmp/shot.png, POSTs binary to /api/media/upload
5. R2MediaService: stores in R2, returns public URL
6. send-update: POSTs { message, screenshotUrl } to /sessions/{id}/agent-update
7. Control plane: creates screenshot artifact, broadcasts to WebSocket clients
8. Web UI: renders image inline in timeline
9. If Slack session: posts image block to Slack thread immediately
10. If Linear session: emits agent activity with image markdown
```

### Completion screenshot (in Slack/Linear summary):

```
1. execution_complete event fires
2. slack-bot/linear-bot calls extractAgentResponse()
3. Extractor fetches artifacts API → finds screenshot artifacts
4. Slack: buildCompletionBlocks() adds image blocks
5. Linear: formatAgentResponse() adds ![Screenshot](url) markdown
```

---

## Files to Create/Modify

| File                                                | Action | Purpose                                  |
| --------------------------------------------------- | ------ | ---------------------------------------- |
| `packages/sandbox/Dockerfile`                       | Modify | Add Chromium + agent-browser             |
| `packages/sandbox/.env.local.example`               | Create | Template for local dev env vars          |
| `packages/sandbox/dev.sh`                           | Create | Local dev runner script                  |
| `packages/control-plane/src/session/http/routes.ts` | Modify | Add `/agent-update` endpoint             |
| `packages/control-plane/src/routes/router.ts`       | Modify | Wire mediaRoutes into router             |
| `packages/slack-bot/src/completion/blocks.ts`       | Modify | Add image blocks for screenshots         |
| `packages/slack-bot/src/callbacks.ts`               | Modify | Handle agent-update callback with images |
| `packages/linear-bot/src/completion/extractor.ts`   | Modify | Add screenshot markdown                  |
| `packages/linear-bot/src/callbacks.ts`              | Modify | Handle agent-update callback             |
| `packages/web/src/app/(app)/session/[id]/page.tsx`  | Modify | Render screenshot artifacts inline       |

---

## Testing

- **Unit:** Control plane agent-update endpoint handler tests
- **Unit:** Slack bot image block generation tests
- **Unit:** Linear bot screenshot markdown formatting tests
- **Integration:** Build sandbox container locally, run agent-browser screenshot, verify upload
- **E2E:** Full flow from agent screenshot → R2 → Slack image block (requires deployed stack)
