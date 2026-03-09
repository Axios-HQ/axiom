import { describe, it, expect, vi, beforeEach } from "vitest";
import { callbacksRouter } from "./callbacks";
import { Hono } from "hono";
import type { Env } from "./types";

// Mock slack-client to avoid real HTTP calls
vi.mock("./utils/slack-client", () => ({
  postMessage: vi.fn().mockResolvedValue({ ok: true }),
  removeReaction: vi.fn().mockResolvedValue({ ok: true }),
}));

import { postMessage } from "./utils/slack-client";

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
    SLACK_BOT_TOKEN: "xoxb-test-token",
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
  return app.fetch(req, env as Env, { waitUntil: vi.fn(), passThroughOnException: vi.fn() });
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

  it("returns 400 when message field is missing", async () => {
    const { app, env } = createApp();

    const payload = {
      sessionId: "sess-1",
      // message is missing
      timestamp: Date.now(),
      signature: "abc",
      context: { channel: "C123" },
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
      context: { channel: "C123", threadTs: "1234.5678" },
    };

    const response = await makeRequest(app, "/callbacks/agent-update", payload, env);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("posts message with image block when screenshotUrl is provided", async () => {
    const { app, env } = createApp();

    const payloadData = {
      sessionId: "sess-1",
      messageId: "msg-1",
      message: "Agent update",
      screenshotUrl: "https://example.com/screenshot.png",
      timestamp: Date.now(),
      context: { channel: "C123", threadTs: "1234.5678" },
    };

    const signature = await computeHmac(payloadData, TEST_SECRET);
    const payload = { ...payloadData, signature };

    const response = await makeRequest(app, "/callbacks/agent-update", payload, env);
    expect(response.status).toBe(200);

    // Wait for background processing
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalled();
    });

    const call = vi.mocked(postMessage).mock.calls[0];
    expect(call[0]).toBe("xoxb-test-token");
    expect(call[1]).toBe("C123");

    const options = call[3] as { thread_ts?: string; blocks?: Array<Record<string, unknown>> };
    expect(options.thread_ts).toBe("1234.5678");

    const blocks = options.blocks!;
    const imageBlock = blocks.find((b) => b.type === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.image_url).toBe("https://example.com/screenshot.png");
    expect(imageBlock!.alt_text).toBe("Screenshot");
  });

  it("posts message without image block when no screenshotUrl", async () => {
    const { app, env } = createApp();

    const payloadData = {
      sessionId: "sess-1",
      messageId: "msg-1",
      message: "Just a text update",
      screenshotUrl: null,
      timestamp: Date.now(),
      context: { channel: "C123", threadTs: "1234.5678" },
    };

    const signature = await computeHmac(payloadData, TEST_SECRET);
    const payload = { ...payloadData, signature };

    const response = await makeRequest(app, "/callbacks/agent-update", payload, env);
    expect(response.status).toBe(200);

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalled();
    });

    const call = vi.mocked(postMessage).mock.calls[0];
    const options = call[3] as { blocks?: Array<Record<string, unknown>> };
    const blocks = options.blocks!;
    const imageBlock = blocks.find((b) => b.type === "image");
    expect(imageBlock).toBeUndefined();

    // Should still have the section block with message text
    const sectionBlock = blocks.find((b) => b.type === "section");
    expect(sectionBlock).toBeDefined();
  });
});
