/**
 * OrchestratorEventLogger - Structured logging for Symphony state transitions.
 *
 * Provides context-aware logging with issue_id, attempt, outcome fields.
 * Integrates with control-plane Logger interface for consistent log output.
 *
 * Reference: Symphony spec §16 (Observability)
 */

export interface OrchestratorEventLoggerDeps {
  issueId: string;
  attempt?: number;
  workflowId?: string;
}

export interface LogContext {
  issueId: string;
  attempt?: number;
  workflowId?: string;
  [key: string]: unknown;
}

/**
 * Structured logger for Symphony orchestrator events.
 * Provides context-aware logging with issue tracking.
 */
export class OrchestratorEventLogger {
  private readonly issueId: string;
  private readonly attempt?: number;
  private readonly workflowId?: string;

  constructor(deps: OrchestratorEventLoggerDeps) {
    this.issueId = deps.issueId;
    this.attempt = deps.attempt;
    this.workflowId = deps.workflowId;
  }

  private buildContext(extra?: Record<string, unknown>): LogContext {
    return {
      issueId: this.issueId,
      ...(this.attempt !== undefined && { attempt: this.attempt }),
      ...(this.workflowId !== undefined && { workflowId: this.workflowId }),
      ...extra,
    };
  }

  /**
   * Log a dispatch event.
   * Called when an issue is eligible for dispatch.
   */
  dispatchStarted(extra?: Record<string, unknown>): LogContext {
    return {
      ...this.buildContext(extra),
      event: "dispatch_started",
      timestamp: Date.now(),
    };
  }

  /**
   * Log successful dispatch.
   * Called when session is created and prompt sent.
   */
  dispatchSuccess(sessionId: string, extra?: Record<string, unknown>): LogContext {
    return {
      ...this.buildContext(extra),
      event: "dispatch_success",
      sessionId,
      timestamp: Date.now(),
    };
  }

  /**
   * Log dispatch failure.
   * Called when session creation or prompt send fails.
   */
  dispatchFailed(error: string, extra?: Record<string, unknown>): LogContext {
    return {
      ...this.buildContext(extra),
      event: "dispatch_failed",
      error,
      timestamp: Date.now(),
    };
  }

  /**
   * Log issue moved to running state.
   * Called after successful dispatch.
   */
  runningStateTransition(sessionId: string, extra?: Record<string, unknown>): LogContext {
    return {
      ...this.buildContext(extra),
      event: "running_state_transition",
      sessionId,
      timestamp: Date.now(),
    };
  }

  /**
   * Log successful completion.
   * Called when session completes successfully.
   */
  completionSuccess(
    sessionId: string,
    tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number },
    extra?: Record<string, unknown>
  ): LogContext {
    return {
      ...this.buildContext(extra),
      event: "completion_success",
      sessionId,
      ...(tokenUsage && { tokenUsage }),
      timestamp: Date.now(),
    };
  }

  /**
   * Log failed run and retry scheduling.
   * Called when session fails and retry is scheduled.
   */
  retryScheduled(
    error: string,
    nextAttempt: number,
    backoffMs: number,
    extra?: Record<string, unknown>
  ): LogContext {
    return {
      ...this.buildContext(extra),
      event: "retry_scheduled",
      error,
      nextAttempt,
      backoffMs,
      timestamp: Date.now(),
    };
  }

  /**
   * Log max retries exceeded.
   * Called when issue fails and no more retries are available.
   */
  maxRetriesExceeded(
    error: string,
    totalAttempts: number,
    extra?: Record<string, unknown>
  ): LogContext {
    return {
      ...this.buildContext(extra),
      event: "max_retries_exceeded",
      error,
      totalAttempts,
      timestamp: Date.now(),
    };
  }

  /**
   * Log issue moved to terminal state.
   * Called during reconciliation when issue enters terminal state (e.g., "done").
   */
  terminalStateDetected(
    issueState: string,
    outcome: "success" | "cancelled" | "skipped",
    extra?: Record<string, unknown>
  ): LogContext {
    return {
      ...this.buildContext(extra),
      event: "terminal_state_detected",
      issueState,
      outcome,
      timestamp: Date.now(),
    };
  }

  /**
   * Log reconciliation event.
   * Called when orchestrator checks issue state and updates internal state.
   */
  reconciliation(checked: number, updated: number, extra?: Record<string, unknown>): LogContext {
    return {
      ...this.buildContext(extra),
      event: "reconciliation",
      checked,
      updated,
      timestamp: Date.now(),
    };
  }

  /**
   * Log an informational event.
   */
  info(message: string, extra?: Record<string, unknown>): LogContext {
    return {
      ...this.buildContext(extra),
      level: "info",
      message,
      timestamp: Date.now(),
    };
  }

  /**
   * Log a warning event.
   */
  warn(message: string, extra?: Record<string, unknown>): LogContext {
    return {
      ...this.buildContext(extra),
      level: "warn",
      message,
      timestamp: Date.now(),
    };
  }

  /**
   * Log an error event.
   */
  error(message: string, error?: Error | string, extra?: Record<string, unknown>): LogContext {
    return {
      ...this.buildContext(extra),
      level: "error",
      message,
      ...(error && { error: typeof error === "string" ? error : error.message }),
      timestamp: Date.now(),
    };
  }

  /**
   * Log a debug event.
   */
  debug(message: string, extra?: Record<string, unknown>): LogContext {
    return {
      ...this.buildContext(extra),
      level: "debug",
      message,
      timestamp: Date.now(),
    };
  }
}
