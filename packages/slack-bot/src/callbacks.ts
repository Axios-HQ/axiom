/**
 * Callback handlers for control-plane notifications.
 */

import { Hono } from "hono";
import type { Env, CompletionCallback, AgentUpdateCallback } from "./types";
import { extractAgentResponse } from "./completion/extractor";
import { buildCompletionBlocks, getFallbackText } from "./completion/blocks";
import { postMessage, removeReaction } from "./utils/slack-client";
import { timingSafeEqual } from "@open-inspect/shared";
import { createLogger } from "./logger";

const log = createLogger("callback");

async function clearThinkingReaction(
  env: Env,
  channel: string,
  reactionMessageTs: string,
  traceId?: string
): Promise<void> {
  const reactionResult = await removeReaction(
    env.SLACK_BOT_TOKEN,
    channel,
    reactionMessageTs,
    "eyes"
  );

  if (!reactionResult.ok && reactionResult.error !== "no_reaction") {
    log.warn("slack.reaction.remove", {
      trace_id: traceId,
      channel,
      message_ts: reactionMessageTs,
      reaction: "eyes",
      slack_error: reactionResult.error,
    });
  }
}

/**
 * Verify internal callback signature using shared secret.
 * Prevents external callers from forging completion callbacks.
 */
async function verifyCallbackSignature(
  payload: CompletionCallback | AgentUpdateCallback,
  secret: string
): Promise<boolean> {
  const { signature, ...data } = payload;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureData = encoder.encode(JSON.stringify(data));
  const expectedSig = await crypto.subtle.sign("HMAC", key, signatureData);
  const expectedHex = Array.from(new Uint8Array(expectedSig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqual(signature, expectedHex);
}

/**
 * Validate callback payload shape.
 */
function isValidPayload(payload: unknown): payload is CompletionCallback {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.sessionId === "string" &&
    typeof p.messageId === "string" &&
    typeof p.success === "boolean" &&
    typeof p.timestamp === "number" &&
    typeof p.signature === "string" &&
    p.context !== null &&
    typeof p.context === "object" &&
    typeof (p.context as Record<string, unknown>).channel === "string" &&
    typeof (p.context as Record<string, unknown>).threadTs === "string"
  );
}

export const callbacksRouter = new Hono<{ Bindings: Env }>();

/**
 * Callback endpoint for session completion notifications.
 */
callbacksRouter.post("/complete", async (c) => {
  const startTime = Date.now();
  // Use trace_id from control-plane if present, otherwise generate one
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const payload = await c.req.json();

  // Validate payload shape
  if (!isValidPayload(payload)) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/complete",
      http_status: 400,
      outcome: "rejected",
      reject_reason: "invalid_payload",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "invalid payload" }, 400);
  }

  // Verify signature (prevents external forgery)
  if (!c.env.INTERNAL_CALLBACK_SECRET) {
    log.error("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/complete",
      http_status: 500,
      outcome: "error",
      reject_reason: "secret_not_configured",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "not configured" }, 500);
  }

  const isValid = await verifyCallbackSignature(payload, c.env.INTERNAL_CALLBACK_SECRET);
  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/complete",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      session_id: payload.sessionId,
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  // Process in background
  c.executionCtx.waitUntil(handleCompletionCallback(payload, c.env, traceId));

  log.info("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: "/callbacks/complete",
    http_status: 200,
    session_id: payload.sessionId,
    message_id: payload.messageId,
    duration_ms: Date.now() - startTime,
  });

  return c.json({ ok: true });
});

/**
 * Callback endpoint for mid-session agent updates (screenshots, progress).
 */
callbacksRouter.post("/agent-update", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const payload = await c.req.json();

  // Validate payload
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.sessionId !== "string" ||
    typeof payload.message !== "string" ||
    typeof payload.timestamp !== "number" ||
    typeof payload.signature !== "string" ||
    !payload.context ||
    typeof payload.context !== "object" ||
    typeof payload.context.channel !== "string"
  ) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/agent-update",
      http_status: 400,
      outcome: "rejected",
      reject_reason: "invalid_payload",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "invalid payload" }, 400);
  }

  if (!c.env.INTERNAL_CALLBACK_SECRET) {
    return c.json({ error: "not configured" }, 500);
  }

  const isValid = await verifyCallbackSignature(
    payload as AgentUpdateCallback,
    c.env.INTERNAL_CALLBACK_SECRET
  );
  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/agent-update",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      session_id: payload.sessionId,
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  // Process in background
  c.executionCtx.waitUntil(
    handleAgentUpdateCallback(payload as AgentUpdateCallback, c.env, traceId)
  );

  return c.json({ ok: true });
});

/**
 * Handle agent update callback - post screenshot/progress to Slack thread.
 */
async function handleAgentUpdateCallback(
  payload: AgentUpdateCallback,
  env: Env,
  traceId?: string
): Promise<void> {
  const startTime = Date.now();
  const { context } = payload;

  try {
    const blocks: Array<Record<string, unknown>> = [];

    // Add message text
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\u{1F4F8} *Agent update:*\n${payload.message}`,
      },
    });

    // Add screenshot image if present
    if (payload.screenshotUrl) {
      blocks.push({
        type: "image",
        image_url: payload.screenshotUrl,
        alt_text: "Screenshot",
      });
    }

    await postMessage(env.SLACK_BOT_TOKEN, context.channel, payload.message, {
      thread_ts: context.threadTs,
      blocks,
    });

    log.info("callback.agent_update", {
      trace_id: traceId,
      session_id: payload.sessionId,
      has_screenshot: Boolean(payload.screenshotUrl),
      outcome: "success",
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    log.error("callback.agent_update", {
      trace_id: traceId,
      session_id: payload.sessionId,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      duration_ms: Date.now() - startTime,
    });
  }
}

/**
 * Handle completion callback - fetch events and post to Slack.
 */
async function handleCompletionCallback(
  payload: CompletionCallback,
  env: Env,
  traceId?: string
): Promise<void> {
  const startTime = Date.now();
  const { sessionId, context } = payload;
  const base = {
    trace_id: traceId,
    session_id: sessionId,
    message_id: payload.messageId,
    channel: context.channel,
  };

  try {
    // Fetch events to build response (filtered by messageId directly)
    const agentResponse = await extractAgentResponse(env, sessionId, payload.messageId, traceId);

    // Check if extraction succeeded (has content or was explicitly successful)
    if (!agentResponse.textContent && agentResponse.toolCalls.length === 0 && !payload.success) {
      log.error("callback.complete", {
        ...base,
        outcome: "error",
        error_message: "empty_agent_response",
        duration_ms: Date.now() - startTime,
      });
      await postMessage(
        env.SLACK_BOT_TOKEN,
        context.channel,
        "The agent completed but I couldn't retrieve the response. Please check the web UI for details.",
        {
          thread_ts: context.threadTs,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: ":warning: The agent completed but I couldn't retrieve the response.",
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "View Session" },
                  url: `${env.WEB_APP_URL}/session/${sessionId}`,
                  action_id: "view_session",
                },
              ],
            },
          ],
        }
      );

      if (context.reactionMessageTs) {
        await clearThinkingReaction(env, context.channel, context.reactionMessageTs, traceId);
      }
      return;
    }

    // Build and post completion message
    const blocks = buildCompletionBlocks(sessionId, agentResponse, context, env.WEB_APP_URL);

    await postMessage(env.SLACK_BOT_TOKEN, context.channel, getFallbackText(agentResponse), {
      thread_ts: context.threadTs,
      blocks,
    });

    if (context.reactionMessageTs) {
      await clearThinkingReaction(env, context.channel, context.reactionMessageTs, traceId);
    }

    log.info("callback.complete", {
      ...base,
      outcome: "success",
      agent_success: payload.success,
      tool_call_count: agentResponse.toolCalls.length,
      artifact_count: agentResponse.artifacts.length,
      has_text: Boolean(agentResponse.textContent),
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    log.error("callback.complete", {
      ...base,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      duration_ms: Date.now() - startTime,
    });
    // Don't throw - this is fire-and-forget
  }
}
