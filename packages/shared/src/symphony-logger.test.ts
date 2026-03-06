import { describe, it, expect } from "vitest";
import { OrchestratorEventLogger } from "./symphony-logger";

describe("OrchestratorEventLogger", () => {
  it("creates logger with required issue ID", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-123" });
    expect(logger).toBeDefined();
  });

  it("includes issue ID in all log contexts", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-123", attempt: 1 });
    const context = logger.info("test message");
    expect(context.issueId).toBe("LIN-123");
    expect(context.attempt).toBe(1);
  });

  it("logs dispatch started event", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-456" });
    const context = logger.dispatchStarted({ priority: "high" });
    expect(context.event).toBe("dispatch_started");
    expect(context.issueId).toBe("LIN-456");
    expect(context.priority).toBe("high");
    expect(context.timestamp).toBeGreaterThan(0);
  });

  it("logs dispatch success with session ID", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-789" });
    const context = logger.dispatchSuccess("session-abc");
    expect(context.event).toBe("dispatch_success");
    expect(context.sessionId).toBe("session-abc");
  });

  it("logs dispatch failure with error", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-101" });
    const context = logger.dispatchFailed("Connection timeout");
    expect(context.event).toBe("dispatch_failed");
    expect(context.error).toBe("Connection timeout");
  });

  it("logs completion success with token usage", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-202", attempt: 2 });
    const tokenUsage = { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 };
    const context = logger.completionSuccess("session-def", tokenUsage);
    expect(context.event).toBe("completion_success");
    expect(context.tokenUsage).toEqual(tokenUsage);
    expect(context.attempt).toBe(2);
  });

  it("logs retry scheduled event", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-303" });
    const context = logger.retryScheduled("API rate limit", 2, 5000);
    expect(context.event).toBe("retry_scheduled");
    expect(context.nextAttempt).toBe(2);
    expect(context.backoffMs).toBe(5000);
    expect(context.error).toBe("API rate limit");
  });

  it("logs max retries exceeded", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-404" });
    const context = logger.maxRetriesExceeded("Persistent failure", 3);
    expect(context.event).toBe("max_retries_exceeded");
    expect(context.totalAttempts).toBe(3);
  });

  it("logs terminal state detection", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-505" });
    const context = logger.terminalStateDetected("done", "success");
    expect(context.event).toBe("terminal_state_detected");
    expect(context.issueState).toBe("done");
    expect(context.outcome).toBe("success");
  });

  it("logs reconciliation event with counts", () => {
    const logger = new OrchestratorEventLogger({ issueId: "orchestra", workflowId: "wf-123" });
    const context = logger.reconciliation(10, 2);
    expect(context.event).toBe("reconciliation");
    expect(context.timestamp).toBeGreaterThan(0);
  });

  it("logs info level message", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-606" });
    const context = logger.info("Issue dispatched successfully");
    expect(context.level).toBe("info");
    expect(context.message).toBe("Issue dispatched successfully");
  });

  it("logs warn level message", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-707" });
    const context = logger.warn("Slow response from API");
    expect(context.level).toBe("warn");
    expect(context.message).toBe("Slow response from API");
  });

  it("logs error with Error object", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-808" });
    const error = new Error("Network failure");
    const context = logger.error("Dispatch failed", error);
    expect(context.level).toBe("error");
    expect(context.error).toBe("Network failure");
  });

  it("logs debug level message", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-909" });
    const context = logger.debug("Evaluating dispatch eligibility");
    expect(context.level).toBe("debug");
    expect(context.message).toBe("Evaluating dispatch eligibility");
  });

  it("includes workflow ID when provided", () => {
    const logger = new OrchestratorEventLogger({
      issueId: "LIN-999",
      workflowId: "wf-example",
    });
    const context = logger.info("test");
    expect(context.workflowId).toBe("wf-example");
  });

  it("omits optional fields when not provided", () => {
    const logger = new OrchestratorEventLogger({ issueId: "LIN-111" });
    const context = logger.info("test");
    expect(context.attempt).toBeUndefined();
    expect(context.workflowId).toBeUndefined();
  });
});
