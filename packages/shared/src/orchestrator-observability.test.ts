import { describe, it, expect } from "vitest";
import { OrchestratorObservability, logOrchestratorSnapshot } from "./orchestrator-observability";
import type { OrchestratorState } from "./types/symphony";

describe("OrchestratorObservability", () => {
  it("records dispatch check events", () => {
    const obs = new OrchestratorObservability();
    obs.recordDispatchCheck("LIN-123", true, "All concurrency limits OK");
    obs.recordDispatchCheck("LIN-456", false, "Max concurrent agents reached");

    const events = obs.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "dispatch_check",
      issueId: "LIN-123",
      outcome: "success",
    });
    expect(events[1]).toMatchObject({
      type: "dispatch_check",
      issueId: "LIN-456",
      outcome: "skipped",
    });
  });

  it("records dispatch execution", () => {
    const obs = new OrchestratorObservability();
    obs.recordDispatchExecuted("LIN-123", "session-abc", 250, {
      available: 10000,
      estimated: 2000,
    });

    const events = obs.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "dispatch_executed",
      issueId: "LIN-123",
      outcome: "success",
      duration: 250,
      metadata: {
        sessionId: "session-abc",
        tokenBudget: { available: 10000, estimated: 2000 },
      },
    });
  });

  it("records dispatch errors", () => {
    const obs = new OrchestratorObservability();
    obs.recordDispatchError("LIN-789", "Session creation failed", 100);

    const events = obs.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "dispatch_executed",
      outcome: "failed",
      error: "Session creation failed",
    });
  });

  it("records retry processing", () => {
    const obs = new OrchestratorObservability();
    const nextRetryAt = Date.now() + 5000;
    obs.recordRetryProcessed("LIN-456", nextRetryAt, 2, 5000);

    const events = obs.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "retry_processed",
      issueId: "LIN-456",
      outcome: "retry_scheduled",
      metadata: {
        attempt: 2,
        backoffMs: 5000,
        nextRetryAt,
      },
    });
  });

  it("records max retries exceeded", () => {
    const obs = new OrchestratorObservability();
    obs.recordMaxRetriesExceeded("LIN-999", 3, "Persistent API timeout");

    const events = obs.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "retry_processed",
      outcome: "failed",
      error: "Max retries (3) exceeded: Persistent API timeout",
    });
  });

  it("records reconciliation", () => {
    const obs = new OrchestratorObservability();
    const transitioned = { "LIN-123": "completed", "LIN-456": "failed" };
    obs.recordReconciliationRun(10, 2, transitioned, 150);

    const events = obs.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "reconciliation_run",
      outcome: "success",
      duration: 150,
      metadata: {
        checked: 10,
        updated: 2,
        transitioned,
      },
    });
  });

  it("records issue completion", () => {
    const obs = new OrchestratorObservability();
    const tokenUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
    };
    obs.recordIssueCompleted("LIN-789", "success", tokenUsage, 5000);

    const events = obs.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "issue_completed",
      issueId: "LIN-789",
      outcome: "success",
      duration: 5000,
      metadata: { tokenUsage },
    });
  });

  it("records errors", () => {
    const obs = new OrchestratorObservability();
    obs.recordError("LIN-000", "Unexpected orchestrator error");

    const events = obs.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      issueId: "LIN-000",
      error: "Unexpected orchestrator error",
    });
  });

  it("computes cycle statistics", () => {
    const obs = new OrchestratorObservability();

    // Record some events
    obs.recordDispatchCheck("LIN-1", true);
    obs.recordDispatchCheck("LIN-2", true);
    obs.recordDispatchCheck("LIN-3", false);
    obs.recordDispatchExecuted("LIN-1", "session-1", 100);
    obs.recordRetryProcessed("LIN-4", Date.now() + 5000, 2, 5000);
    obs.recordReconciliationRun(5, 1, { "LIN-4": "retry" }, 50);

    const stats = obs.getCycleStats();
    expect(stats.candidateFetched).toBe(3);
    expect(stats.eligible).toBe(2);
    expect(stats.dispatched).toBe(1);
    expect(stats.retriesProcessed).toBe(1);
    expect(stats.reconciled).toBe(1);
    expect(stats.duration).toBeGreaterThanOrEqual(0);
  });

  it("returns summary statistics", () => {
    const obs = new OrchestratorObservability();
    obs.recordDispatchCheck("LIN-1", true);
    obs.recordDispatchExecuted("LIN-1", "session-1", 100);
    obs.recordDispatchError("LIN-2", "Error", 50);

    const summary = obs.getSummary();
    expect(summary.events).toBe(3);
    expect(summary.dispatched).toBe(1);
    expect(summary.errors).toBe(0); // recordError not called
    expect(summary.retries).toBe(0);
    expect(summary.duration).toBeGreaterThanOrEqual(0);
  });

  it("clears all events", () => {
    const obs = new OrchestratorObservability();
    obs.recordDispatchCheck("LIN-1", true);
    obs.recordDispatchExecuted("LIN-1", "session-1", 100);

    expect(obs.getEvents()).toHaveLength(2);

    obs.clear();
    expect(obs.getEvents()).toHaveLength(0);
  });

  it("snapshot includes key metrics", () => {
    // Create a minimal state object that passes type checks
    const state = {
      poll_interval_ms: 30000,
      max_concurrent_agents: 10,
      running: {
        "LIN-1": {
          identifier: "LIN-1",
          issue: {
            id: "LIN-1",
            identifier: "LIN-1",
            title: "Test issue",
            description: null,
            priority: 1,
            state: "todo",
            branch_name: null,
            url: "https://example.com",
            labels: [],
            blocked_by: [],
            created_at: 0,
            updated_at: 0,
          },
          session_id: "s1",
          codex_app_server_pid: null,
          last_codex_message: null,
          last_codex_event: null,
          last_codex_timestamp: null,
          codex_input_tokens: 0,
          codex_output_tokens: 0,
          codex_total_tokens: 0,
          last_reported_input_tokens: 0,
          last_reported_output_tokens: 0,
          last_reported_total_tokens: 0,
          retry_attempt: null,
          started_at: 0,
        },
      },
      claimed: new Set(["LIN-1", "LIN-2"]),
      retry_attempts: {
        "LIN-3": {
          issue_id: "LIN-3",
          identifier: "LIN-3",
          attempt: 2,
          due_at_ms: Date.now() + 5000,
        },
      },
      completed: new Set(["LIN-4", "LIN-5"]),
      codex_totals: {
        input_tokens: 10000,
        output_tokens: 5000,
        total_tokens: 15000,
        seconds_running: 30,
      },
      codex_rate_limits: null,
    } as OrchestratorState;

    const snapshot = logOrchestratorSnapshot(state);
    expect(snapshot.runningCount).toBe(1);
    expect(snapshot.claimedCount).toBe(2);
    expect(snapshot.retryQueueLength).toBe(1);
    expect(snapshot.completedCount).toBe(2);
    expect(snapshot.pollIntervalMs).toBe(30000);
    expect(snapshot.maxConcurrentAgents).toBe(10);
  });
});
