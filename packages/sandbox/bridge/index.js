/**
 * WebSocket bridge from sandbox container to control plane SessionAgent.
 *
 * Establishes outbound WebSocket to control plane and proxies events
 * between OpenCode (local HTTP) and the control plane.
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

// ==================== State ====================

let ws = null;
let heartbeatTimer = null;
let pongTimer = null;
let reconnectAttempt = 0;
let shutdownRequested = false;
let opencodeSessionId = process.env.OPENCODE_SESSION_ID || null;
let sseAbortController = null;
let currentMessageId = null;

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
  return `${url}/sessions/${SESSION_ID}/sandbox/ws?sandboxId=${SANDBOX_ID}&token=${SANDBOX_AUTH_TOKEN}`;
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
        // OpenCode returns session list or session object
        if (Array.isArray(data) && data.length > 0) {
          opencodeSessionId = data[0].id;
          log("Detected OpenCode session", { opencodeSessionId });
          return opencodeSessionId;
        } else if (data && typeof data === "object") {
          // May return a map of sessions
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

  log("No OpenCode session detected, will create on first prompt");
  return null;
}

async function sendPromptToOpenCode(content, messageId, sessionConfig) {
  if (!opencodeSessionId) {
    // Try to detect or wait for a session
    opencodeSessionId = await detectOpenCodeSession();
    if (!opencodeSessionId) {
      log("No OpenCode session available, cannot send prompt");
      return false;
    }
  }

  currentMessageId = messageId;

  try {
    const body = {
      role: "user",
      parts: [{ type: "text", text: content }],
    };

    log("Sending prompt to OpenCode", {
      sessionId: opencodeSessionId,
      messageId,
      contentLength: content.length,
    });

    const res = await opencodeFetch(`/session/${opencodeSessionId}/message`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      log("Failed to send prompt to OpenCode", {
        status: res.status,
        body: text.slice(0, 200),
      });
      return false;
    }

    return true;
  } catch (err) {
    log("Error sending prompt to OpenCode", {
      error: err.message,
    });
    return false;
  }
}

async function cancelCurrentMessage() {
  if (!opencodeSessionId || !currentMessageId) {
    return;
  }

  try {
    await opencodeFetch(`/session/${opencodeSessionId}/message/${currentMessageId}/cancel`, {
      method: "POST",
    });
    log("Cancelled current message", { messageId: currentMessageId });
  } catch (err) {
    log("Error cancelling message", { error: err.message });
  }
}

// ==================== SSE Event Streaming ====================

let sseEventCounter = 0;

function startSSEPolling() {
  if (!opencodeSessionId) {
    log("No OpenCode session yet, deferring SSE polling");
    return;
  }

  stopSSEPolling();
  sseAbortController = new AbortController();

  log("Starting SSE event polling", { opencodeSessionId });

  pollSSE(sseAbortController.signal).catch((err) => {
    if (!shutdownRequested) {
      log("SSE polling error, will restart", { error: err.message });
      // Restart after a delay
      setTimeout(() => startSSEPolling(), 5000);
    }
  });
}

function stopSSEPolling() {
  if (sseAbortController) {
    sseAbortController.abort();
    sseAbortController = null;
  }
}

async function pollSSE(signal) {
  const url = `${OPENCODE_BASE_URL}/session/${opencodeSessionId}/events`;
  log("Connecting to OpenCode SSE", { url });

  while (!signal.aborted) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal,
      });

      if (!res.ok) {
        log("SSE connection failed", { status: res.status });
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
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
            // End of event - forward to control plane
            try {
              const parsed = JSON.parse(eventData);
              forwardEventToControlPlane(eventType, parsed);
            } catch {
              // Non-JSON event data, forward as-is
              forwardEventToControlPlane(eventType, { raw: eventData });
            }
            eventType = "message";
            eventData = "";
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      log("SSE stream error", { error: err.message });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function forwardEventToControlPlane(eventType, data) {
  const ackId = `ack_${Date.now()}_${++sseEventCounter}`;

  sendMessage({
    type: "sandbox:event",
    sandboxId: SANDBOX_ID,
    sessionId: SESSION_ID,
    event: {
      type: eventType,
      ...data,
    },
    ackId,
    timestamp: Date.now(),
  });
}

// ==================== Heartbeat ====================

function startHeartbeat() {
  stopHeartbeat();

  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.ping();

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

  ws = new WebSocket(url);

  ws.on("open", () => {
    log("Connected to control plane");
    reconnectAttempt = 0;
    startHeartbeat();

    sendMessage({
      type: "sandbox:connected",
      sandboxId: SANDBOX_ID,
      sessionId: SESSION_ID,
      timestamp: Date.now(),
    });

    // Send ready status
    sendMessage({
      type: "sandbox:status",
      sandboxId: SANDBOX_ID,
      status: "ready",
      timestamp: Date.now(),
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

function sendMessage(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("Cannot send message, WebSocket not open", { type: message.type });
    return;
  }
  ws.send(JSON.stringify(message));
}

async function handleMessage(message) {
  const type = message.type;

  switch (type) {
    case "prompt": {
      log("Received prompt", {
        contentLength: message.content?.length,
        messageId: message.messageId,
      });

      // Send running status
      sendMessage({
        type: "sandbox:status",
        sandboxId: SANDBOX_ID,
        status: "running",
        timestamp: Date.now(),
      });

      // Start SSE polling if not already started
      if (!sseAbortController && opencodeSessionId) {
        startSSEPolling();
      }

      const success = await sendPromptToOpenCode(
        message.content,
        message.messageId,
        message.sessionConfig
      );

      if (!success) {
        // Report error back
        sendMessage({
          type: "sandbox:event",
          sandboxId: SANDBOX_ID,
          event: {
            type: "error",
            error: "Failed to send prompt to OpenCode",
            messageId: message.messageId,
          },
          timestamp: Date.now(),
        });
      }

      // If we just got our first session, start SSE
      if (opencodeSessionId && !sseAbortController) {
        startSSEPolling();
      }
      break;
    }

    case "stop":
      log("Received stop signal");
      await cancelCurrentMessage();
      break;

    case "shutdown":
      log("Received shutdown signal");
      shutdown();
      break;

    case "ack":
      // Acknowledgement from control plane for an event we sent
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
  stopSSEPolling();

  if (ws) {
    sendMessage({
      type: "sandbox:disconnecting",
      sandboxId: SANDBOX_ID,
      sessionId: SESSION_ID,
      timestamp: Date.now(),
    });
    ws.close(1000, "Bridge shutting down");
    ws = null;
  }

  healthServer.close();

  // Give a moment for the close to send, then exit
  setTimeout(() => process.exit(0), 1000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ==================== Main ====================

async function main() {
  log("Bridge starting");

  // Wait for OpenCode to be ready
  const ready = await waitForOpenCode();
  if (!ready) {
    log("OpenCode not ready, starting bridge anyway (will connect when available)");
  }

  // Try to detect existing session
  if (ready) {
    await detectOpenCodeSession();
  }

  // Connect to control plane
  connect();

  // Start SSE polling if we have a session
  if (opencodeSessionId) {
    startSSEPolling();
  }
}

main().catch((err) => {
  log("Bridge startup error", { error: err.message });
  process.exit(1);
});
