/**
 * WebSocket bridge from sandbox container to control plane SessionAgent.
 *
 * Establishes outbound WebSocket to control plane and proxies events
 * between OpenCode (local HTTP) and the control plane.
 *
 * Event flow:
 * 1. Control plane sends { type: "prompt", content, messageId }
 * 2. Bridge connects to OpenCode SSE stream at GET /event
 * 3. Bridge sends prompt via POST /session/:id/prompt_async
 * 4. Bridge translates OpenCode SSE events → SandboxEvent format
 * 5. Bridge sends translated events directly to control plane WS
 * 6. Bridge sends { type: "execution_complete" } when done
 */

import WebSocket from "ws";
import http from "node:http";

// ==================== Configuration ====================

const CONTROL_PLANE_URL = requireEnv("CONTROL_PLANE_URL");
const SESSION_ID = requireEnv("SESSION_ID");
const SANDBOX_ID = requireEnv("SANDBOX_ID");
const SANDBOX_AUTH_TOKEN = requireEnv("SANDBOX_AUTH_TOKEN");

const OPENCODE_PORT = parseInt(process.env.OPENCODE_PORT || "4096", 10);
const OPENCODE_BASE_URL = `http://localhost:${OPENCODE_PORT}`;

// Timing constants
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 15000;
const PONG_TIMEOUT_MS = 10000;
const OPENCODE_POLL_INTERVAL_MS = 2000;
const OPENCODE_READY_TIMEOUT_MS = 120000;
const SSE_INACTIVITY_TIMEOUT_MS = 600000; // 10 minutes

// ==================== State ====================

let ws = null;
let heartbeatTimer = null;
let pongTimer = null;
let reconnectAttempt = 0;
let shutdownRequested = false;
let opencodeSessionId = process.env.OPENCODE_SESSION_ID || null;
let currentPromptAbortController = null;
let inflightMessageId = null;

// ==================== Helpers ====================

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[bridge] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function log(message, data) {
  const entry = {
    component: "bridge",
    msg: message,
    ts: new Date().toISOString(),
    sandboxId: SANDBOX_ID,
    sessionId: SESSION_ID,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

function buildWebSocketUrl() {
  const url = CONTROL_PLANE_URL.replace(/^http/, "ws");
  return `${url}/sessions/${SESSION_ID}/ws?type=sandbox`;
}

/**
 * Generate an ascending ID compatible with OpenCode's message ordering.
 * Uses timestamp + random suffix to ensure lexicographic ordering.
 */
function ascendingId() {
  const ts = Date.now().toString(36).padStart(9, "0");
  const rand = Math.random().toString(36).slice(2, 8);
  return `msg_${ts}_${rand}`;
}

// ==================== Event Sending ====================

/** Send a SandboxEvent directly to the control plane (no wrapping). */
function sendEvent(event) {
  event.sandboxId = SANDBOX_ID;
  event.timestamp = event.timestamp || Date.now();
  sendRawMessage(event);
}

function sendRawMessage(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("Cannot send message, WebSocket not open", { type: message.type });
    return;
  }
  ws.send(JSON.stringify(message));
}

// ==================== Prompt Body Builder ====================

// Models that support adaptive thinking (Anthropic)
const ANTHROPIC_ADAPTIVE_THINKING_MODELS = new Set(["claude-sonnet-4-6", "claude-opus-4-6"]);
const ANTHROPIC_THINKING_BUDGETS = { low: 1024, medium: 4096, high: 10000, max: 32000 };
const ANTHROPIC_ADAPTIVE_EFFORTS = new Set(["low", "medium", "high", "max"]);

/**
 * Build the request body for OpenCode's prompt_async endpoint.
 * Mirrors the Modal Python bridge's _build_prompt_request_body.
 */
function buildPromptBody(content, messageID, model, reasoningEffort, attachments) {
  const parts = [{ type: "text", text: content }];

  // Append file attachments
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (!att || typeof att !== "object") continue;
      const mime = att.mimeType || "application/octet-stream";
      const name = att.name || "attachment";
      const url = att.url || "";
      if (typeof url !== "string" || (!url.startsWith("https://") && !url.startsWith("http://")))
        continue;
      parts.push({ type: "file", mime, url, filename: name });
    }
  }

  const body = { parts, messageID };

  // Build model spec if model is provided
  if (model) {
    let providerID, modelID;
    if (model.includes("/")) {
      [providerID, modelID] = model.split("/", 2);
    } else {
      providerID = "anthropic";
      modelID = model;
    }

    const modelSpec = { providerID, modelID };

    if (reasoningEffort) {
      if (providerID === "anthropic") {
        if (ANTHROPIC_ADAPTIVE_THINKING_MODELS.has(modelID)) {
          const options = { thinking: { type: "adaptive" } };
          if (ANTHROPIC_ADAPTIVE_EFFORTS.has(reasoningEffort)) {
            options.outputConfig = { effort: reasoningEffort };
          }
          modelSpec.options = options;
        } else {
          const budget = ANTHROPIC_THINKING_BUDGETS[reasoningEffort];
          if (budget !== undefined) {
            modelSpec.options = { thinking: { type: "enabled", budgetTokens: budget } };
          }
        }
      } else if (providerID === "openai") {
        modelSpec.options = { reasoningEffort, reasoningSummary: "auto" };
      }
    }

    body.model = modelSpec;
  }

  return body;
}

// ==================== OpenCode HTTP Client ====================

async function opencodeFetch(path, options = {}) {
  const url = `${OPENCODE_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  return res;
}

async function waitForOpenCode() {
  const startTime = Date.now();
  log("Waiting for OpenCode to be ready...");

  while (Date.now() - startTime < OPENCODE_READY_TIMEOUT_MS) {
    try {
      const res = await opencodeFetch("/session");
      if (res.ok) {
        log("OpenCode is ready");
        return true;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, OPENCODE_POLL_INTERVAL_MS));
  }

  log("OpenCode failed to become ready within timeout");
  return false;
}

async function detectOpenCodeSession() {
  if (opencodeSessionId) {
    log("Using provided OpenCode session ID", { opencodeSessionId });
    return opencodeSessionId;
  }

  log("Detecting OpenCode session...");
  const maxAttempts = 30;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await opencodeFetch("/session");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          opencodeSessionId = data[0].id;
          log("Detected OpenCode session", { opencodeSessionId });
          return opencodeSessionId;
        } else if (data && typeof data === "object") {
          const sessions = Object.values(data);
          if (sessions.length > 0) {
            opencodeSessionId = sessions[0].id;
            log("Detected OpenCode session", { opencodeSessionId });
            return opencodeSessionId;
          }
        }
      }
    } catch {
      // Not ready
    }
    await new Promise((r) => setTimeout(r, OPENCODE_POLL_INTERVAL_MS));
  }

  log("No OpenCode session detected, will create one");
  return null;
}

async function createOpenCodeSession() {
  log("Creating new OpenCode session...");
  try {
    const res = await opencodeFetch("/session", {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      opencodeSessionId = data.id;
      log("Created OpenCode session", { opencodeSessionId });
      return opencodeSessionId;
    }
    const text = await res.text();
    log("Failed to create OpenCode session", { status: res.status, body: text.slice(0, 200) });
    return null;
  } catch (err) {
    log("Error creating OpenCode session", { error: err.message });
    return null;
  }
}

// ==================== OpenCode SSE Event Translation ====================

/**
 * Transform an OpenCode message part into SandboxEvent(s).
 * Mirrors the Modal bridge's handle_part / _transform_part_to_event logic.
 */
function translatePart(part, delta, messageId, cumulativeText, emittedToolStates, isSubtask) {
  const events = [];
  const partType = part.type || "";
  const partId = part.id || "";

  if (partType === "text") {
    if (isSubtask) return events; // Don't forward child text tokens
    if (delta) {
      cumulativeText[partId] = (cumulativeText[partId] || "") + delta;
    } else {
      cumulativeText[partId] = part.text || "";
    }
    if (cumulativeText[partId]) {
      events.push({
        type: "token",
        content: cumulativeText[partId],
        messageId,
      });
    }
  } else if (partType === "tool") {
    const state = part.state || {};
    const status = state.status || "";
    const toolInput = state.input || {};
    const callId = part.callID || "";
    const partSessionId = part.sessionID || "";

    // Skip pending tools with no input
    if ((status === "pending" || status === "") && Object.keys(toolInput).length === 0) {
      return events;
    }

    const toolKey = `tool:${partSessionId}:${callId}:${status}`;
    if (!emittedToolStates.has(toolKey)) {
      emittedToolStates.add(toolKey);
      events.push({
        type: "tool_call",
        tool: part.tool || "",
        args: toolInput,
        callId,
        status,
        output: state.output || "",
        messageId,
      });
    }
  } else if (partType === "step-start") {
    events.push({
      type: "step_start",
      messageId,
    });
  } else if (partType === "step-finish") {
    events.push({
      type: "step_finish",
      cost: part.cost,
      tokens: part.tokens,
      reason: part.reason,
      messageId,
    });
  }

  if (isSubtask) {
    for (const ev of events) {
      ev.isSubtask = true;
    }
  }
  return events;
}

// ==================== Prompt Handling ====================

/**
 * Handle a prompt from the control plane.
 * Mirrors the Modal bridge's _stream_opencode_response_sse flow:
 * 1. Connect to SSE stream at GET /event
 * 2. Send prompt via POST /session/:id/prompt_async
 * 3. Translate and forward events
 * 4. Send execution_complete when session goes idle
 */
async function handlePrompt(messageId, content, model, reasoningEffort, attachments) {
  if (!opencodeSessionId) {
    opencodeSessionId = await detectOpenCodeSession();
  }
  if (!opencodeSessionId) {
    opencodeSessionId = await createOpenCodeSession();
  }
  if (!opencodeSessionId) {
    sendEvent({
      type: "error",
      error: "No OpenCode session available",
      messageId,
    });
    sendEvent({
      type: "execution_complete",
      messageId,
      success: false,
      error: "No OpenCode session available",
    });
    return;
  }

  inflightMessageId = messageId;
  const abortController = new AbortController();
  currentPromptAbortController = abortController;
  const signal = abortController.signal;

  // Generate ascending message ID for OpenCode correlation
  const openCodeMessageId = ascendingId();

  // State for event translation
  const cumulativeText = {};
  const emittedToolStates = new Set();
  const allowedAssistantMsgIds = new Set();
  const trackedChildSessionIds = new Set();
  let compactionOccurred = false;

  let hadError = false;
  let errorMessage = null;
  let sseReader = null;

  try {
    // Step 1: Connect to OpenCode SSE stream
    const sseUrl = `${OPENCODE_BASE_URL}/event`;
    log("Connecting to OpenCode SSE", { url: sseUrl });

    const sseRes = await fetch(sseUrl, {
      headers: { Accept: "text/event-stream" },
      signal,
    });

    if (!sseRes.ok) {
      throw new Error(`SSE connection failed: ${sseRes.status}`);
    }

    // Step 2: Send prompt via async endpoint
    const promptUrl = `${OPENCODE_BASE_URL}/session/${opencodeSessionId}/prompt_async`;
    const promptBody = buildPromptBody(
      content,
      openCodeMessageId,
      model,
      reasoningEffort,
      attachments
    );

    log("Sending prompt to OpenCode", {
      sessionId: opencodeSessionId,
      messageId,
      openCodeMessageId,
      contentLength: content.length,
      model: model || "default",
      reasoningEffort: reasoningEffort || "default",
    });

    const promptRes = await fetch(promptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(promptBody),
      signal,
    });

    if (!promptRes.ok && promptRes.status !== 204) {
      const errBody = await promptRes.text();
      throw new Error(`Async prompt failed: ${promptRes.status} - ${errBody}`);
    }

    // Step 3: Process SSE events
    const reader = sseRes.body.getReader();
    sseReader = reader;
    const decoder = new TextDecoder();
    let buffer = "";
    let lastEventTime = Date.now();
    let sseComplete = false;

    while (!signal.aborted && !sseComplete) {
      // Check inactivity timeout
      if (Date.now() - lastEventTime > SSE_INACTIVITY_TIMEOUT_MS) {
        log("SSE inactivity timeout");
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let eventType = "message";
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          eventData += line.slice(6);
        } else if (line === "" && eventData) {
          lastEventTime = Date.now();

          let parsed;
          try {
            parsed = JSON.parse(eventData);
          } catch {
            eventType = "message";
            eventData = "";
            continue;
          }

          const sseEventType = parsed.type || eventType;
          const props = parsed.properties || {};

          // Process the SSE event
          const result = processSSEEvent(
            sseEventType,
            props,
            messageId,
            openCodeMessageId,
            cumulativeText,
            emittedToolStates,
            allowedAssistantMsgIds,
            trackedChildSessionIds,
            compactionOccurred
          );
          if (result.compactionOccurred) compactionOccurred = true;

          if (result.events) {
            for (const ev of result.events) {
              sendEvent(ev);
              if (ev.type === "error") {
                hadError = true;
                errorMessage = ev.error;
              }
            }
          }

          if (result.done) {
            // session.idle or session.status idle — set flag to exit outer loop
            sseComplete = true;
            break;
          }

          eventType = "message";
          eventData = "";
        }
      }
    }
  } catch (err) {
    if (signal.aborted) {
      log("Prompt cancelled", { messageId });
      hadError = true;
      errorMessage = "Prompt was cancelled";
    } else {
      log("Prompt error", { messageId, error: err.message });
      hadError = true;
      errorMessage = err.message;

      sendEvent({
        type: "error",
        error: err.message,
        messageId,
      });
    }
  } finally {
    currentPromptAbortController = null;
    inflightMessageId = null;
    // Release the SSE stream to prevent resource leaks
    if (sseReader) {
      sseReader.cancel().catch(() => {});
    }
  }

  // Always send execution_complete
  sendEvent({
    type: "execution_complete",
    messageId,
    success: !hadError,
    ...(errorMessage ? { error: errorMessage } : {}),
  });

  log("Prompt complete", { messageId, success: !hadError });
}

/**
 * Process a single OpenCode SSE event and return translated SandboxEvents.
 * Returns { events: [...], done: boolean }
 */
function processSSEEvent(
  eventType,
  props,
  messageId,
  openCodeMessageId,
  cumulativeText,
  emittedToolStates,
  allowedAssistantMsgIds,
  trackedChildSessionIds,
  compactionOccurred
) {
  const events = [];

  if (eventType === "server.connected" || eventType === "server.heartbeat") {
    return { events, done: false };
  }

  // Handle session compaction — after compaction, parentID changes
  if (eventType === "session.compacted") {
    log("Session compacted, relaxing parentID matching");
    return { events, done: false, compactionOccurred: true };
  }

  // Track child sessions
  if (eventType === "session.created") {
    const info = props.info || {};
    const childId = info.id;
    const childParent = info.parentID;
    if (childId && childParent === opencodeSessionId) {
      trackedChildSessionIds.add(childId);
      log("Child session detected", { childSessionId: childId });
    }
    return { events, done: false };
  }

  const eventSessionId = props.sessionID || (props.part && props.part.sessionID);
  const isChild = eventSessionId && trackedChildSessionIds.has(eventSessionId);

  // Filter: only process events from our session or tracked children
  if (eventSessionId && eventSessionId !== opencodeSessionId && !isChild) {
    return { events, done: false };
  }

  if (eventType === "message.updated") {
    const info = props.info || {};
    const msgSessionId = info.sessionID;
    const ocMsgId = info.id || "";
    const parentId = info.parentID || "";
    const role = info.role || "";
    const isSummary = info.metadata?.summary === true;

    if (msgSessionId === opencodeSessionId) {
      const parentMatches = parentId === openCodeMessageId;
      // Accept if: parentID matches, OR compaction occurred (and not a summary message)
      if (
        role === "assistant" &&
        ocMsgId &&
        (parentMatches || (compactionOccurred && !isSummary))
      ) {
        allowedAssistantMsgIds.add(ocMsgId);
      }
    } else if (trackedChildSessionIds.has(msgSessionId)) {
      if (role === "assistant" && ocMsgId) {
        allowedAssistantMsgIds.add(ocMsgId);
      }
    }
    return { events, done: false };
  }

  if (eventType === "message.part.updated") {
    const part = props.part || {};
    const delta = props.delta;
    const ocMsgId = part.messageID || "";
    const partSessionId = part.sessionID || "";

    // Discover child sessions from task tool metadata
    if (part.tool === "task" && partSessionId === opencodeSessionId) {
      const metadata = part.metadata;
      const childSid = metadata && typeof metadata === "object" ? metadata.sessionId : null;
      if (childSid && !trackedChildSessionIds.has(childSid)) {
        trackedChildSessionIds.add(childSid);
        log("Child session detected from task metadata", { childSessionId: childSid });
      }
    }

    if (allowedAssistantMsgIds.has(ocMsgId)) {
      const isSubtask = trackedChildSessionIds.has(partSessionId);
      const translated = translatePart(
        part,
        delta,
        messageId,
        cumulativeText,
        emittedToolStates,
        isSubtask
      );
      events.push(...translated);
    }
    return { events, done: false };
  }

  if (eventType === "session.idle") {
    const idleSessionId = props.sessionID;
    if (idleSessionId === opencodeSessionId) {
      log("Session idle, prompt complete");
      return { events, done: true };
    }
    return { events, done: false };
  }

  // Note: session.status with type=idle is intentionally NOT handled here.
  // OpenCode sends it as current state on SSE connect, which would cause
  // premature exit on subsequent prompts. Only session.idle (transition event)
  // signals prompt completion.

  if (eventType === "session.error") {
    const errorSessionId = props.sessionID;
    if (errorSessionId === opencodeSessionId) {
      const errorObj = props.error || {};
      const errorMsg =
        typeof errorObj === "string"
          ? errorObj
          : errorObj.message || errorObj.msg || JSON.stringify(errorObj);
      events.push({
        type: "error",
        error: errorMsg || "Unknown error",
        messageId,
      });
    }
    return { events, done: false };
  }

  return { events, done: false };
}

// ==================== Heartbeat ====================

function startHeartbeat() {
  stopHeartbeat();

  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.ping();

    // Also send a heartbeat event that the control plane understands
    sendEvent({
      type: "heartbeat",
      status: "ready",
    });

    pongTimer = setTimeout(() => {
      log("Pong timeout, connection appears dead");
      ws?.terminate();
    }, PONG_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (pongTimer) {
    clearTimeout(pongTimer);
    pongTimer = null;
  }
}

// ==================== WebSocket Connection ====================

function connect() {
  if (shutdownRequested) return;

  const url = buildWebSocketUrl();
  log("Connecting to control plane", { url: url.replace(/token=[^&]+/, "token=***") });

  ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${SANDBOX_AUTH_TOKEN}`,
      "X-Sandbox-ID": SANDBOX_ID,
    },
  });

  ws.on("open", () => {
    log("Connected to control plane");
    reconnectAttempt = 0;
    startHeartbeat();

    // Send a ready event as a proper SandboxEvent
    sendEvent({
      type: "heartbeat",
      status: "ready",
    });
  });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(message);
    } catch (err) {
      log("Failed to parse message", { error: err.message });
    }
  });

  ws.on("pong", () => {
    if (pongTimer) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }
  });

  ws.on("close", (code, reason) => {
    log("Connection closed", { code, reason: reason.toString() });
    stopHeartbeat();
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    log("Connection error", { error: err.message });
  });
}

function scheduleReconnect() {
  if (shutdownRequested) return;

  const delayMs = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempt),
    RECONNECT_MAX_DELAY_MS
  );
  reconnectAttempt++;

  log("Scheduling reconnect", { delayMs, attempt: reconnectAttempt });
  setTimeout(() => connect(), delayMs);
}

// ==================== Message Handling ====================

async function handleMessage(message) {
  const type = message.type;

  switch (type) {
    case "prompt": {
      const messageId = message.messageId || message.message_id || "unknown";
      log("Received prompt", {
        contentLength: message.content?.length,
        messageId,
      });

      // Run prompt handling as background task (don't block WS listener)
      handlePrompt(
        messageId,
        message.content || "",
        message.model,
        message.reasoningEffort,
        message.attachments
      ).catch((err) => {
        log("Unhandled prompt error", { error: err.message, messageId });
        sendEvent({
          type: "execution_complete",
          messageId,
          success: false,
          error: err.message,
        });
      });
      break;
    }

    case "stop":
      log("Received stop signal");
      if (currentPromptAbortController) {
        currentPromptAbortController.abort();
        currentPromptAbortController = null;
      }
      break;

    case "shutdown":
      log("Received shutdown signal");
      shutdown();
      break;

    case "ack":
      // Acknowledgement from control plane
      break;

    case "push":
      log("Received push command (not yet implemented)");
      break;

    default:
      log("Unknown message type", { type });
  }
}

// ==================== Health Check Server ====================

const healthServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    const healthy = ws && ws.readyState === WebSocket.OPEN;
    res.writeHead(healthy ? 200 : 503);
    res.end(
      JSON.stringify({
        status: healthy ? "ok" : "unhealthy",
        bridge: ws ? ws.readyState : "null",
        opencode_session: opencodeSessionId,
        inflight_message: inflightMessageId,
      })
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(8080, () => {
  log("Health check server listening on port 8080");
});

// ==================== Shutdown ====================

function shutdown() {
  if (shutdownRequested) return;
  shutdownRequested = true;

  log("Shutting down bridge");
  stopHeartbeat();

  if (currentPromptAbortController) {
    currentPromptAbortController.abort();
    currentPromptAbortController = null;
  }

  if (ws) {
    ws.close(1000, "Bridge shutting down");
    ws = null;
  }

  healthServer.close();

  setTimeout(() => process.exit(0), 1000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Prevent silent crashes from unhandled rejections
process.on("unhandledRejection", (reason) => {
  log("Unhandled promise rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on("uncaughtException", (err) => {
  log("Uncaught exception", { error: err.message, stack: err.stack });
  // Give time for the log to flush before exiting
  setTimeout(() => process.exit(1), 500);
});

// ==================== Main ====================

async function main() {
  log("Bridge starting");

  const ready = await waitForOpenCode();
  if (!ready) {
    log("OpenCode not ready, starting bridge anyway (will connect when available)");
  }

  if (ready) {
    await detectOpenCodeSession();
  }

  connect();
}

main().catch((err) => {
  log("Bridge startup error", { error: err.message });
  process.exit(1);
});
