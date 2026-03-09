import { describe, it, expect, vi, beforeEach } from "vitest";
import { callbacksRouter } from "./callbacks";
import { Hono } from "hono";
import type { Env } from "./types";

// Mock linear-client to avoid real HTTP calls
vi.mock("./utils/linear-client", () => ({
  getLinearClient: vi.fn().mockResolvedValue({ apiKey: "mock-key" }),
  emitAgentActivity: vi.fn().mockResolvedValue(undefined),
  postIssueComment: vi.fn().mockResolvedValue({ success: true }),
  updateAgentSession: vi.fn().mockResolvedValue(undefined),
}));

import { emitAgentActivity } from "./utils/linear-client";

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret-key";

async function computeHmac(data: object, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(data)));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function createApp(envOverrides?: Partial<Env>) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/callbacks", callbacksRouter);

  const env: Partial<Env> = {
    INTERNAL_CALLBACK_SECRET: TEST_SECRET,
    WEB_APP_URL: "https://app.test.dev",
    ...envOverrides,
  };

  return { app, env };
}

async function makeRequest(
  app: Hono<{ Bindings: Env }>,
  path: string,
  body: unknown,
  env: Partial<Env>
) {
  const req = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return app.fetch(
    req,
    env as Env,
    {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("callbacksRouter /agent-update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for invalid payload (missing required fields)", async () => {
    const { app, env } = createApp();

    const response = await makeRequest(app, "/callbacks/agent-update", { bad: "data" }, env);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ error: "invalid payload" });
  });

  it("returns 400 when context is missing", async () => {
    const { app, env } = createApp();

    const payload = {
      sessionId: "sess-1",
      message: "Update",
      timestamp: Date.now(),
      signature: "abc",
      // context is missing
    };

    const response = await makeRequest(app, "/callbacks/agent-update", payload, env);
    expect(response.status).toBe(400);
  });

  it("returns 401 for invalid signature", async () => {
    const { app, env } = createApp();

    const payload = {
      sessionId: "sess-1",
      messageId: "msg-1",
      message: "Working on it...",
      screenshotUrl: null,
      timestamp: Date.now(),
      signature: "invalid-signature",
      context: {
        agentSessionId: "agent-sess-1",
        organizationId: "org-1",
        issueId: "issue-1",
      },
    };

    const response = await makeRequest(app, "/callbacks/agent-update", payload, env);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("emits agent activity with screenshot markdown when screenshotUrl is provided", async () => {
    const { app, env } = createApp();

    const payloadData = {
      sessionId: "sess-1",
      messageId: "msg-1",
      message: "Agent update",
      screenshotUrl: "https://example.com/screenshot.png",
      timestamp: Date.now(),
      context: {
        agentSessionId: "agent-sess-1",
        organizationId: "org-1",
        issueId: "issue-1",
      },
    };

    const signature = await computeHmac(payloadData, TEST_SECRET);
    const payload = { ...payloadData, signature };

    const response = await makeRequest(app, "/callbacks/agent-update", payload, env);
    expect(response.status).toBe(200);

    // Wait for background processing
    await vi.waitFor(() => {
      expect(emitAgentActivity).toHaveBeenCalled();
    });

    const call = vi.mocked(emitAgentActivity).mock.calls[0];
    expect(call[1]).toBe("agent-sess-1");
    const content = call[2] as { type: string; body: string };
    expect(content.type).toBe("action");
    expect(content.body).toContain("Agent update");
    expect(content.body).toContain("![Screenshot](https://example.com/screenshot.png)");
  });

  it("emits agent activity without screenshot when screenshotUrl is absent", async () => {
    const { app, env } = createApp();

    const payloadData = {
      sessionId: "sess-1",
      messageId: "msg-1",
      message: "Just a text update",
      screenshotUrl: null,
      timestamp: Date.now(),
      context: {
        agentSessionId: "agent-sess-1",
        organizationId: "org-1",
        issueId: "issue-1",
      },
    };

    const signature = await computeHmac(payloadData, TEST_SECRET);
    const payload = { ...payloadData, signature };

    const response = await makeRequest(app, "/callbacks/agent-update", payload, env);
    expect(response.status).toBe(200);

    await vi.waitFor(() => {
      expect(emitAgentActivity).toHaveBeenCalled();
    });

    const call = vi.mocked(emitAgentActivity).mock.calls[0];
    const content = call[2] as { type: string; body: string };
    expect(content.body).toBe("Just a text update");
    expect(content.body).not.toContain("![Screenshot]");
  });

  it("skips when agentSessionId is missing from context", async () => {
    const { app, env } = createApp();

    const payloadData = {
      sessionId: "sess-1",
      messageId: "msg-1",
      message: "Update",
      screenshotUrl: null,
      timestamp: Date.now(),
      context: {
        // agentSessionId is missing
        organizationId: "org-1",
        issueId: "issue-1",
      },
    };

    const signature = await computeHmac(payloadData, TEST_SECRET);
    const payload = { ...payloadData, signature };

    const response = await makeRequest(app, "/callbacks/agent-update", payload, env);
    expect(response.status).toBe(200);

    // Give background task a tick to run
    await new Promise((r) => setTimeout(r, 50));

    expect(emitAgentActivity).not.toHaveBeenCalled();
  });
});
