/**
 * OrchestratorObservability - Event logging and metrics for orchestrator state transitions.
 *
 * Tracks and logs all orchestrator lifecycle events:
 * - Dispatch eligibility checks and outcomes
 * - Retry scheduling and execution
 * - Issue reconciliation and terminal state detection
 * - Token usage and completion outcomes
 *
 * Reference: Symphony spec §16 (Observability)
 */

import type { OrchestratorState } from "./types/symphony";

/**
 * Observability event for orchestrator operations.
 * Represents a single state transition or outcome in the orchestration lifecycle.
 */
export interface ObservabilityEvent {
  type:
    | "dispatch_check"
    | "dispatch_executed"
    | "retry_processed"
    | "reconciliation_run"
    | "issue_completed"
    | "error";
  issueId: string;
  timestamp: number;
  duration?: number;
  outcome?: "success" | "failed" | "skipped" | "retry_scheduled";
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Statistics for a single orchestrator cycle.
 */
export interface CycleStats {
  cycleStartTime: number;
  candidateFetched: number;
  eligible: number;
  dispatched: number;
  retriesProcessed: number;
  reconciled: number;
  errors: number;
  duration: number;
}

/**
 * Aggregator for observability events during orchestrator operations.
 * Used to collect, track, and export metrics from the orchestrator state machine.
 */
export class OrchestratorObservability {
  private readonly events: ObservabilityEvent[] = [];
  private readonly cycleStartTime: number;

  constructor() {
    this.cycleStartTime = Date.now();
  }

  /**
   * Record a dispatch eligibility check.
   * Called for each candidate when evaluating dispatch eligibility (spec §5).
   */
  recordDispatchCheck(issueId: string, eligible: boolean, reason?: string): void {
    this.events.push({
      type: "dispatch_check",
      issueId,
      timestamp: Date.now(),
      outcome: eligible ? "success" : "skipped",
      metadata: reason ? { reason } : undefined,
    });
  }

  /**
   * Record a successful dispatch event.
   * Called when issue is dispatched and session created (spec §6).
   */
  recordDispatchExecuted(
    issueId: string,
    sessionId: string,
    duration: number,
    tokenBudget?: { available: number; estimated: number }
  ): void {
    this.events.push({
      type: "dispatch_executed",
      issueId,
      timestamp: Date.now(),
      duration,
      outcome: "success",
      metadata: {
        sessionId,
        ...(tokenBudget && { tokenBudget }),
      },
    });
  }

  /**
   * Record a failed dispatch attempt.
   * Called when dispatch fails and error is recorded.
   */
  recordDispatchError(issueId: string, error: string, duration: number): void {
    this.events.push({
      type: "dispatch_executed",
      issueId,
      timestamp: Date.now(),
      duration,
      outcome: "failed",
      error,
    });
  }

  /**
   * Record retry processing.
   * Called when orchestrator evaluates retry queue and schedules retries (spec §11).
   */
  recordRetryProcessed(
    issueId: string,
    nextRetryAt: number,
    attempt: number,
    backoffMs: number
  ): void {
    this.events.push({
      type: "retry_processed",
      issueId,
      timestamp: Date.now(),
      outcome: "retry_scheduled",
      metadata: {
        attempt,
        backoffMs,
        nextRetryAt,
      },
    });
  }

  /**
   * Record max retries exceeded.
   * Called when issue exhausts all retry attempts.
   */
  recordMaxRetriesExceeded(issueId: string, totalAttempts: number, error: string): void {
    this.events.push({
      type: "retry_processed",
      issueId,
      timestamp: Date.now(),
      outcome: "failed",
      error: `Max retries (${totalAttempts}) exceeded: ${error}`,
    });
  }

  /**
   * Record reconciliation check.
   * Called during reconciliation cycle (spec §14.3).
   */
  recordReconciliationRun(
    checked: number,
    updated: number,
    transitioned: Record<string, string>,
    duration: number
  ): void {
    this.events.push({
      type: "reconciliation_run",
      issueId: "orchestra", // Aggregate event
      timestamp: Date.now(),
      duration,
      outcome: "success",
      metadata: {
        checked,
        updated,
        transitioned,
      },
    });
  }

  /**
   * Record issue completion.
   * Called when issue reaches terminal state with outcome.
   */
  recordIssueCompleted(
    issueId: string,
    outcome: "success" | "failed" | "skipped",
    tokenUsage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    },
    duration?: number
  ): void {
    this.events.push({
      type: "issue_completed",
      issueId,
      timestamp: Date.now(),
      duration,
      outcome,
      metadata: tokenUsage ? { tokenUsage } : undefined,
    });
  }

  /**
   * Record an orchestrator error.
   * Called when an unexpected error occurs during orchestration.
   */
  recordError(issueId: string, error: string): void {
    this.events.push({
      type: "error",
      issueId,
      timestamp: Date.now(),
      error,
    });
  }

  /**
   * Get all recorded events.
   */
  getEvents(): ObservabilityEvent[] {
    return [...this.events];
  }

  /**
   * Get statistics for the current cycle.
   */
  getCycleStats(): CycleStats {
    const now = Date.now();
    const dispatchChecks = this.events.filter((e) => e.type === "dispatch_check");
    const dispatched = this.events.filter(
      (e) => e.type === "dispatch_executed" && e.outcome === "success"
    );
    const retries = this.events.filter(
      (e) => e.type === "retry_processed" && e.outcome === "retry_scheduled"
    );
    const reconciliation = this.events.filter((e) => e.type === "reconciliation_run");
    const errors = this.events.filter((e) => e.type === "error");

    return {
      cycleStartTime: this.cycleStartTime,
      candidateFetched: dispatchChecks.length,
      eligible: dispatchChecks.filter((e) => e.outcome === "success").length,
      dispatched: dispatched.length,
      retriesProcessed: retries.length,
      reconciled: reconciliation.length,
      errors: errors.length,
      duration: now - this.cycleStartTime,
    };
  }

  /**
   * Clear all recorded events.
   * Typically called after persisting events to a log sink.
   */
  clear(): void {
    this.events.length = 0;
  }

  /**
   * Summary of observability events for logging.
   * Used to log cycle completion with key metrics.
   */
  getSummary(): {
    events: number;
    dispatched: number;
    retries: number;
    errors: number;
    duration: number;
  } {
    const stats = this.getCycleStats();
    return {
      events: this.events.length,
      dispatched: stats.dispatched,
      retries: stats.retriesProcessed,
      errors: stats.errors,
      duration: stats.duration,
    };
  }
}

/**
 * Integration hook to log orchestrator state snapshots.
 * Useful for debugging and monitoring orchestrator health.
 */
export function logOrchestratorSnapshot(state: OrchestratorState): Record<string, unknown> {
  return {
    runningCount: Object.keys(state.running).length,
    claimedCount: state.claimed.size,
    retryQueueLength: Object.keys(state.retry_attempts).length,
    completedCount: state.completed.size,
    pollIntervalMs: state.poll_interval_ms,
    maxConcurrentAgents: state.max_concurrent_agents,
    codexTotals: state.codex_totals,
  };
}
