/**
 * WebSocket bridge from sandbox container to control plane SessionAgent.
 *
 * Establishes an outbound WebSocket connection from the container to the
 * control plane Durable Object, enabling bidirectional communication:
 *
 * - Upstream (container -> control plane): agent events, heartbeats
 * - Downstream (control plane -> container): prompts, commands, stop signals
 *
 * The bridge reconnects automatically on connection loss with exponential backoff.
 */

import WebSocket from "ws";

// ==================== Configuration ====================

const CONTROL_PLANE_URL = requireEnv("CONTROL_PLANE_URL");
const SESSION_ID = requireEnv("SESSION_ID");
const SANDBOX_ID = requireEnv("SANDBOX_ID");
const SANDBOX_AUTH_TOKEN = requireEnv("SANDBOX_AUTH_TOKEN");

/** Initial reconnect delay in milliseconds. */
const RECONNECT_BASE_DELAY_MS = 1000;

/** Maximum reconnect delay in milliseconds. */
const RECONNECT_MAX_DELAY_MS = 30000;

/** Heartbeat interval in milliseconds. */
const HEARTBEAT_INTERVAL_MS = 15000;

/** How long to wait for a pong before considering connection dead. */
const PONG_TIMEOUT_MS = 10000;

// ==================== State ====================

let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pongTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let shutdownRequested = false;

// ==================== Helpers ====================

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[bridge] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function log(message: string, data?: Record<string, unknown>): void {
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

function buildWebSocketUrl(): string {
  // Convert HTTP(S) URL to WS(S) URL and append sandbox path
  const url = CONTROL_PLANE_URL.replace(/^http/, "ws");
  return `${url}/sessions/${SESSION_ID}/sandbox/ws?sandboxId=${SANDBOX_ID}&token=${SANDBOX_AUTH_TOKEN}`;
}

// ==================== Heartbeat ====================

function startHeartbeat(): void {
  stopHeartbeat();

  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Send ping
    ws.ping();

    // Set pong timeout
    pongTimer = setTimeout(() => {
      log("Pong timeout, connection appears dead");
      ws?.terminate();
    }, PONG_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (pongTimer) {
    clearTimeout(pongTimer);
    pongTimer = null;
  }
}

// ==================== Connection ====================

function connect(): void {
  if (shutdownRequested) {
    return;
  }

  const url = buildWebSocketUrl();
  log("Connecting to control plane", { url: url.replace(/token=[^&]+/, "token=***") });

  ws = new WebSocket(url);

  ws.on("open", () => {
    log("Connected to control plane");
    reconnectAttempt = 0;
    startHeartbeat();

    // Send initial registration
    sendMessage({
      type: "sandbox:connected",
      sandboxId: SANDBOX_ID,
      sessionId: SESSION_ID,
      timestamp: Date.now(),
    });
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(message);
    } catch (err) {
      log("Failed to parse message", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  ws.on("pong", () => {
    // Clear pong timeout on successful pong
    if (pongTimer) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }
  });

  ws.on("close", (code: number, reason: Buffer) => {
    log("Connection closed", { code, reason: reason.toString() });
    stopHeartbeat();
    scheduleReconnect();
  });

  ws.on("error", (err: Error) => {
    log("Connection error", { error: err.message });
    // The 'close' event will fire after this, triggering reconnect
  });
}

function scheduleReconnect(): void {
  if (shutdownRequested) {
    return;
  }

  const delayMs = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempt),
    RECONNECT_MAX_DELAY_MS
  );
  reconnectAttempt++;

  log("Scheduling reconnect", { delayMs, attempt: reconnectAttempt });

  setTimeout(() => {
    connect();
  }, delayMs);
}

// ==================== Message Handling ====================

function sendMessage(message: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("Cannot send message, WebSocket not open", { type: message.type as string });
    return;
  }

  ws.send(JSON.stringify(message));
}

function handleMessage(message: Record<string, unknown>): void {
  const type = message.type as string;

  switch (type) {
    case "prompt":
      log("Received prompt", { promptLength: (message.content as string)?.length });
      // Forward to OpenCode agent via stdin or local IPC
      // Implementation depends on OpenCode's IPC mechanism
      break;

    case "stop":
      log("Received stop signal");
      // Signal OpenCode to stop current execution
      break;

    case "snapshot":
      log("Received snapshot request");
      // Snapshot is handled at the container level by the control plane
      break;

    default:
      log("Unknown message type", { type });
  }
}

// ==================== Shutdown ====================

function shutdown(): void {
  if (shutdownRequested) {
    return;
  }
  shutdownRequested = true;

  log("Shutting down bridge");
  stopHeartbeat();

  if (ws) {
    // Send graceful disconnect
    sendMessage({
      type: "sandbox:disconnecting",
      sandboxId: SANDBOX_ID,
      sessionId: SESSION_ID,
      timestamp: Date.now(),
    });

    ws.close(1000, "Bridge shutting down");
    ws = null;
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ==================== Start ====================

log("Bridge starting");
connect();
