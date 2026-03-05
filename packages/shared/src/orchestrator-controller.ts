/**
 * Symphony Orchestrator Controller for scheduling and state management
 * Can be used in control-plane or any execution environment
 * Spec: Section 7, 8, 16
 */

import type { Issue, OrchestratorState, WorkflowDefinition, CodexTotals } from "./types/symphony";
import {
  sortIssuesForDispatch,
  isDispatchEligible,
  hasAvailableSlots,
  dispatchIssue,
  handleWorkerExitNormal,
  handleWorkerExitAbnormal,
  getRunnableRetries,
  updateRunningEntryFromCodexEvent,
  releaseClaim,
  terminateRunningIssue,
} from "./orchestrator";
import type { getEffectiveConfig } from "./workflow-loader";
import { validateDispatchConfig } from "./workflow-loader";

/**
 * Logger interface (injectable)
 */
export interface SymphonyLogger {
  info: (msg: string, ctx: Record<string, unknown>) => void;
  error: (msg: string, ctx: Record<string, unknown>) => void;
  warn: (msg: string, ctx: Record<string, unknown>) => void;
  debug: (msg: string, ctx: Record<string, unknown>) => void;
}

/**
 * Default logger
 */
export const defaultLogger: SymphonyLogger = {
  info: (msg, ctx) => console.log(`[INFO] ${msg}`, ctx),
  error: (msg, ctx) => console.error(`[ERROR] ${msg}`, ctx),
  warn: (msg, ctx) => console.warn(`[WARN] ${msg}`, ctx),
  debug: (msg, ctx) => console.debug(`[DEBUG] ${msg}`, ctx),
};

/**
 * Events emitted by the controller
 */
export interface OrchestratorEvent {
  type: "workflow_loaded" | "dispatch" | "worker_exit" | "state_changed" | "tick" | "error";
  data: Record<string, unknown>;
}

/**
 * Controller for managing orchestrator state and lifecycle
 * Separated from time-based scheduling (which is environment-specific)
 */
export class OrchestratorController {
  private state: OrchestratorState;
  private workflow: WorkflowDefinition | null = null;
  private logger: SymphonyLogger;
  private listeners: Array<(event: OrchestratorEvent) => void> = [];

  constructor(logger?: SymphonyLogger) {
    this.logger = logger || defaultLogger;

    // Initialize state
    this.state = {
      poll_interval_ms: 30000,
      max_concurrent_agents: 10,
      running: {},
      claimed: new Set(),
      retry_attempts: {},
      completed: new Set(),
      codex_totals: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        seconds_running: 0,
      },
      codex_rate_limits: null,
    };
  }

  /**
   * Set workflow and apply configuration
   */
  setWorkflow(
    workflow: WorkflowDefinition,
    effectiveConfig: ReturnType<typeof getEffectiveConfig>
  ): { ok: true } | { ok: false; error: string } {
    // Validate configuration
    const validation = validateDispatchConfig(workflow.config);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }

    this.workflow = workflow;

    // Update state with new config
    this.state.poll_interval_ms = effectiveConfig.polling.interval_ms;
    this.state.max_concurrent_agents = effectiveConfig.agent.max_concurrent_agents;

    this.logger.info("Workflow configured", {
      poll_interval_ms: this.state.poll_interval_ms,
      max_concurrent_agents: this.state.max_concurrent_agents,
    });

    this.emit({
      type: "workflow_loaded",
      data: {
        poll_interval_ms: this.state.poll_interval_ms,
      },
    });

    return { ok: true };
  }

  /**
   * Get current state
   */
  getState(): OrchestratorState {
    return this.state;
  }

  /**
   * Process a polling tick with candidates
   * Called by external poller (control-plane, etc.)
   * Returns issues to dispatch
   */
  processTick(
    candidates: Issue[],
    config: {
      active_states: string[];
      terminal_states: string[];
      agent: {
        max_concurrent_agents: number;
        max_concurrent_agents_by_state: Record<string, number>;
      };
    }
  ): { toDispatch: Issue[]; newState: OrchestratorState } {
    const toDispatch: Issue[] = [];

    // Sort candidates
    const sorted = sortIssuesForDispatch(candidates);

    // Try to dispatch each
    for (const issue of sorted) {
      if (!hasAvailableSlots(this.state, issue, config.agent)) {
        break; // No more slots
      }

      const eligible = isDispatchEligible(
        issue,
        this.state,
        config.active_states,
        config.terminal_states
      );

      if (!eligible.eligible) {
        this.logger.debug("Issue not eligible", {
          issue_id: issue.id,
          reason: eligible.reason,
        });
        continue;
      }

      // Mark for dispatch
      this.state = dispatchIssue(issue, this.state, null);
      toDispatch.push(issue);

      this.logger.info("Issue marked for dispatch", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      });

      this.emit({
        type: "dispatch",
        data: {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
        },
      });
    }

    this.emit({
      type: "tick",
      data: {
        candidates_count: candidates.length,
        dispatched_count: toDispatch.length,
        running_count: Object.keys(this.state.running).length,
      },
    });

    return { toDispatch, newState: this.state };
  }

  /**
   * Process retries ready to run
   * Returns retries that are due and eligible
   */
  processRetries(
    config: {
      active_states: string[];
      agent: {
        max_concurrent_agents: number;
        max_concurrent_agents_by_state: Record<string, number>;
      };
    },
    issueResolver: (issueId: string) => Issue | null
  ): { toRetry: Array<{ issue: Issue; retry_attempt: number }>; newState: OrchestratorState } {
    const toRetry: Array<{ issue: Issue; retry_attempt: number }> = [];
    const runnableRetries = getRunnableRetries(this.state);

    for (const { issueId, retry } of runnableRetries) {
      if (!hasAvailableSlots(this.state, null, config.agent)) {
        break;
      }

      const issue = issueResolver(issueId);
      if (!issue) {
        // Issue not found, release claim
        this.state = releaseClaim(this.state, issueId);
        this.logger.info("Retry eligible but issue not found, releasing claim", {
          issue_id: issueId,
        });
        continue;
      }

      // Check if still active
      const normalizedState = issue.state.trim().toLowerCase();
      if (!config.active_states.map((s) => s.trim().toLowerCase()).includes(normalizedState)) {
        this.state = releaseClaim(this.state, issueId);
        this.logger.info("Retry eligible but issue no longer active, releasing claim", {
          issue_id: issueId,
          state: issue.state,
        });
        continue;
      }

      // Mark for dispatch
      this.state = dispatchIssue(issue, this.state, retry.attempt);
      toRetry.push({ issue, retry_attempt: retry.attempt });

      this.logger.info("Retry marked for dispatch", {
        issue_id: issueId,
        attempt: retry.attempt,
      });
    }

    return { toRetry, newState: this.state };
  }

  /**
   * Report worker exit
   */
  reportWorkerExit(
    issueId: string,
    outcome: "success" | "failure" | "timeout" | "stall",
    maxRetryBackoffMs: number,
    error?: string
  ): OrchestratorState {
    if (!(issueId in this.state.running)) {
      this.logger.warn("Worker exit for non-running issue", {
        issue_id: issueId,
        outcome,
      });
      return this.state;
    }

    if (outcome === "success") {
      this.state = handleWorkerExitNormal(this.state, issueId, maxRetryBackoffMs);
    } else {
      this.state = handleWorkerExitAbnormal(
        this.state,
        issueId,
        maxRetryBackoffMs,
        error || outcome
      );
    }

    this.logger.info("Worker exit processed", {
      issue_id: issueId,
      outcome,
    });

    this.emit({
      type: "worker_exit",
      data: {
        issue_id: issueId,
        outcome,
      },
    });

    this.emit({
      type: "state_changed",
      data: { state: this.state },
    });

    return this.state;
  }

  /**
   * Reconcile running issues
   * Caller provides fresh state from tracker
   */
  reconcileRunning(
    issueStates: Map<string, string>,
    config: {
      active_states: string[];
      terminal_states: string[];
    }
  ): {
    toCleanup: string[];
    newState: OrchestratorState;
  } {
    const toCleanup: string[] = [];

    for (const issueId of Object.keys(this.state.running)) {
      const newState = issueStates.get(issueId);

      if (!newState) {
        // Issue no longer exists
        this.state = terminateRunningIssue(this.state, issueId, false);
        this.logger.info("Running issue no longer exists", { issue_id: issueId });
        continue;
      }

      const normalizedState = newState.trim().toLowerCase();
      const isTerminal = config.terminal_states
        .map((s) => s.trim().toLowerCase())
        .includes(normalizedState);
      const isActive = config.active_states
        .map((s) => s.trim().toLowerCase())
        .includes(normalizedState);

      if (isTerminal) {
        this.state = terminateRunningIssue(this.state, issueId, true);
        toCleanup.push(issueId);
        this.logger.info("Running issue reached terminal state", {
          issue_id: issueId,
          state: newState,
        });
      } else if (!isActive) {
        this.state = terminateRunningIssue(this.state, issueId, false);
        this.logger.info("Running issue no longer in active state", {
          issue_id: issueId,
          state: newState,
        });
      }
    }

    this.emit({
      type: "state_changed",
      data: { state: this.state },
    });

    return { toCleanup, newState: this.state };
  }

  /**
   * Report codex event (token updates, messages, etc.)
   */
  reportCodexEvent(
    issueId: string,
    event: {
      type: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      };
      message?: string;
    }
  ): void {
    if (!(issueId in this.state.running)) {
      return;
    }

    const entry = this.state.running[issueId];
    this.state.running[issueId] = updateRunningEntryFromCodexEvent(entry, event);

    // Track tokens
    if (event.usage?.total_tokens) {
      const delta = event.usage.total_tokens - entry.last_reported_total_tokens;
      if (delta > 0) {
        const codexTotals: CodexTotals = {
          ...this.state.codex_totals,
          total_tokens: this.state.codex_totals.total_tokens + delta,
          input_tokens:
            this.state.codex_totals.input_tokens +
            (event.usage.input_tokens
              ? event.usage.input_tokens - entry.last_reported_input_tokens
              : 0),
          output_tokens:
            this.state.codex_totals.output_tokens +
            (event.usage.output_tokens
              ? event.usage.output_tokens - entry.last_reported_output_tokens
              : 0),
        };
        this.state.codex_totals = codexTotals;
        this.state.running[issueId].last_reported_total_tokens = event.usage.total_tokens;
        this.state.running[issueId].last_reported_input_tokens = event.usage.input_tokens || 0;
        this.state.running[issueId].last_reported_output_tokens = event.usage.output_tokens || 0;
      }
    }
  }

  /**
   * Get snapshot for observability/monitoring
   */
  getSnapshot() {
    return {
      generated_at: new Date().toISOString(),
      counts: {
        running: Object.keys(this.state.running).length,
        retrying: Object.keys(this.state.retry_attempts).length,
      },
      running: Object.entries(this.state.running).map(([_id, entry]) => ({
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        state: entry.issue.state,
        session_id: entry.session_id,
        last_event: entry.last_codex_event,
        last_message: entry.last_codex_message,
        started_at: new Date(entry.started_at).toISOString(),
        last_event_at: entry.last_codex_timestamp
          ? new Date(entry.last_codex_timestamp).toISOString()
          : null,
        tokens: {
          input_tokens: entry.codex_input_tokens,
          output_tokens: entry.codex_output_tokens,
          total_tokens: entry.codex_total_tokens,
        },
      })),
      retrying: Object.entries(this.state.retry_attempts).map(([_id, retry]) => ({
        issue_id: retry.issue_id,
        issue_identifier: retry.identifier,
        attempt: retry.attempt,
        due_at: new Date(retry.due_at_ms).toISOString(),
        error: retry.error || null,
      })),
      codex_totals: this.state.codex_totals,
      rate_limits: this.state.codex_rate_limits,
    };
  }

  /**
   * Subscribe to events
   */
  on(listener: (event: OrchestratorEvent) => void): () => void {
    this.listeners.push(listener);
    // Return unsubscribe function
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Emit event to all listeners
   */
  private emit(event: OrchestratorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error("Event listener error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
