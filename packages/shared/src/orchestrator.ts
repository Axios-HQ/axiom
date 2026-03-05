/**
 * Symphony Orchestrator
 * Compliant with Symphony spec Section 7 & 8
 *
 * Core orchestration logic for issue dispatch, retry, and reconciliation.
 */

import type {
  Issue,
  OrchestratorState,
  RunningEntry,
  RetryEntry,
  CodexTotals,
} from "./types/symphony";

/**
 * Default retry delays
 * Spec: Section 8.4 - Retry and Backoff
 */
const CONTINUATION_RETRY_DELAY_MS = 1000; // Short delay for continuation
const INITIAL_RETRY_DELAY_MS = 10000; // 10 seconds for first failure retry
const RETRY_BACKOFF_MULTIPLIER = 2; // Exponential backoff: 10s, 20s, 40s, etc.

/**
 * Sort issues for dispatch
 * Spec: Section 8.2 - Sorting order
 * 1. priority ascending (lower numbers first)
 * 2. created_at oldest first
 * 3. identifier lexicographic tie-breaker
 */
export function sortIssuesForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    // Priority: lower numbers = higher priority, nulls go last
    if (a.priority !== null && b.priority !== null) {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
    } else if (a.priority !== null) {
      return -1; // a has priority, b doesn't, a wins
    } else if (b.priority !== null) {
      return 1; // b has priority, a doesn't, b wins
    }

    // created_at: oldest first
    const aCreated = a.created_at ?? Number.MAX_SAFE_INTEGER;
    const bCreated = b.created_at ?? Number.MAX_SAFE_INTEGER;

    if (aCreated !== bCreated) {
      return aCreated - bCreated;
    }

    // Lexicographic tie-breaker
    return a.identifier.localeCompare(b.identifier);
  });
}

/**
 * Check if an issue is dispatch-eligible
 * Spec: Section 8.2 - Candidate Selection Rules
 */
export function isDispatchEligible(
  issue: Issue,
  state: OrchestratorState,
  activeStates: string[],
  terminalStates: string[]
): { eligible: true } | { eligible: false; reason: string } {
  // Must have required fields
  if (!issue.id || !issue.identifier || !issue.title) {
    return {
      eligible: false,
      reason: "Issue missing required fields (id, identifier, title)",
    };
  }

  // Normalize state for comparison
  const normalizedIssueState = issue.state.trim().toLowerCase();
  const normalizedActiveStates = activeStates.map((s) => s.trim().toLowerCase());
  const normalizedTerminalStates = terminalStates.map((s) => s.trim().toLowerCase());

  // Must be in active state and not in terminal state
  if (!normalizedActiveStates.includes(normalizedIssueState)) {
    return {
      eligible: false,
      reason: `Issue state "${issue.state}" is not in active states`,
    };
  }

  if (normalizedTerminalStates.includes(normalizedIssueState)) {
    return {
      eligible: false,
      reason: `Issue state "${issue.state}" is in terminal states`,
    };
  }

  // Must not be already running
  if (issue.id in state.running) {
    return {
      eligible: false,
      reason: "Issue is already running",
    };
  }

  // Must not be already claimed (in retry queue)
  if (state.claimed.has(issue.id)) {
    return {
      eligible: false,
      reason: "Issue claim is already reserved",
    };
  }

  // Blocker rule for Todo state
  // Spec: Section 8.2 - If in Todo, do not dispatch when any blocker is non-terminal
  if (normalizedIssueState === "todo") {
    for (const blocker of issue.blocked_by) {
      if (blocker.state && !normalizedTerminalStates.includes(blocker.state.trim().toLowerCase())) {
        return {
          eligible: false,
          reason: `Issue is in Todo but has non-terminal blocker: ${blocker.identifier}`,
        };
      }
    }
  }

  return { eligible: true };
}

/**
 * Check concurrency constraints
 * Spec: Section 8.3 - Concurrency Control
 */
export function hasAvailableSlots(
  state: OrchestratorState,
  issue: Issue | null,
  agentConfig: {
    max_concurrent_agents: number;
    max_concurrent_agents_by_state: Record<string, number>;
  }
): boolean {
  // Global concurrency check
  const runningCount = Object.keys(state.running).length;
  const globalSlots = Math.max(agentConfig.max_concurrent_agents - runningCount, 0);

  if (globalSlots === 0) {
    return false;
  }

  // Per-state concurrency check (if applicable)
  if (issue) {
    const normalizedState = issue.state.trim().toLowerCase();
    const stateLimit = agentConfig.max_concurrent_agents_by_state[normalizedState];

    if (stateLimit !== undefined) {
      // Count running issues in this state
      const runningInState = Object.values(state.running).filter(
        (entry) => entry.issue.state.trim().toLowerCase() === normalizedState
      ).length;

      return runningInState < stateLimit;
    }
  }

  return true;
}

/**
 * Calculate retry backoff delay
 * Spec: Section 8.4 - Backoff formula
 */
export function calculateRetryDelay(
  attempt: number,
  maxRetryBackoffMs: number,
  isContinuation: boolean = false
): number {
  if (isContinuation) {
    return CONTINUATION_RETRY_DELAY_MS;
  }

  // Formula: min(10000 * 2^(attempt - 1), maxRetryBackoffMs)
  const normalizedAttempt = Math.max(1, attempt);
  const baseDelay =
    INITIAL_RETRY_DELAY_MS * Math.pow(RETRY_BACKOFF_MULTIPLIER, normalizedAttempt - 1);
  return Math.min(baseDelay, maxRetryBackoffMs);
}

/**
 * Create a running entry for dispatched issue
 * Spec: Section 16.4 - Dispatch One Issue
 */
export function createRunningEntry(issue: Issue, attempt: number | null): RunningEntry {
  return {
    identifier: issue.identifier,
    issue,
    session_id: null,
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
    retry_attempt: attempt,
    started_at: Date.now(),
  };
}

/**
 * Dispatch an issue (add to running)
 * Spec: Section 16.4 - Dispatch One Issue
 */
export function dispatchIssue(
  issue: Issue,
  state: OrchestratorState,
  attempt: number | null
): OrchestratorState {
  const newState = { ...state };

  const running = { ...newState.running };
  running[issue.id] = createRunningEntry(issue, attempt);
  newState.running = running;

  const claimed = new Set(newState.claimed);
  claimed.add(issue.id);
  newState.claimed = claimed;

  const retryAttempts = { ...newState.retry_attempts };
  delete retryAttempts[issue.id];
  newState.retry_attempts = retryAttempts;

  return newState;
}

/**
 * Schedule a retry for an issue
 * Spec: Section 8.4 - Retry entry creation
 */
export function scheduleRetry(
  state: OrchestratorState,
  issueId: string,
  identifier: string,
  attempt: number,
  maxRetryBackoffMs: number,
  isContinuation: boolean = false,
  error?: string
): OrchestratorState {
  const newState = { ...state };

  // Cancel any existing retry timer for this issue (implicit in our in-memory design)

  // Calculate due time
  const delay = calculateRetryDelay(attempt, maxRetryBackoffMs, isContinuation);
  const dueAtMs = Date.now() + delay;

  // Store retry entry
  const retryAttempts = { ...newState.retry_attempts };
  retryAttempts[issueId] = {
    issue_id: issueId,
    identifier,
    attempt,
    due_at_ms: dueAtMs,
    error,
  };
  newState.retry_attempts = retryAttempts;

  // Ensure claimed set includes this issue
  const claimed = new Set(newState.claimed);
  claimed.add(issueId);
  newState.claimed = claimed;

  return newState;
}

/**
 * Handle worker exit (normal)
 * Spec: Section 16.6 - Worker Exit and Retry Handling
 */
export function handleWorkerExitNormal(
  state: OrchestratorState,
  issueId: string,
  maxRetryBackoffMs: number
): OrchestratorState {
  let newState = { ...state };

  // Remove from running
  const running = { ...newState.running };
  const runningEntry = running[issueId];

  if (!runningEntry) {
    return newState; // Already gone
  }

  delete running[issueId];
  newState.running = running;

  // Add to runtime seconds
  const elapsedSeconds = (Date.now() - runningEntry.started_at) / 1000;
  const codexTotals: CodexTotals = {
    ...newState.codex_totals,
    seconds_running: newState.codex_totals.seconds_running + elapsedSeconds,
  };
  newState.codex_totals = codexTotals;

  // Mark as completed (bookkeeping)
  const completed = new Set(newState.completed);
  completed.add(issueId);
  newState.completed = completed;

  // Schedule short continuation retry (attempt 1)
  newState = scheduleRetry(
    newState,
    issueId,
    runningEntry.identifier,
    1,
    maxRetryBackoffMs,
    true // isContinuation
  );

  return newState;
}

/**
 * Handle worker exit (abnormal - error, timeout, stall)
 * Spec: Section 16.6 - Worker Exit and Retry Handling
 */
export function handleWorkerExitAbnormal(
  state: OrchestratorState,
  issueId: string,
  maxRetryBackoffMs: number,
  reason: string
): OrchestratorState {
  let newState = { ...state };

  // Remove from running
  const running = { ...newState.running };
  const runningEntry = running[issueId];

  if (!runningEntry) {
    return newState; // Already gone
  }

  delete running[issueId];
  newState.running = running;

  // Add to runtime seconds
  const elapsedSeconds = (Date.now() - runningEntry.started_at) / 1000;
  const codexTotals: CodexTotals = {
    ...newState.codex_totals,
    seconds_running: newState.codex_totals.seconds_running + elapsedSeconds,
  };
  newState.codex_totals = codexTotals;

  // Calculate next attempt number
  const currentAttempt = runningEntry.retry_attempt ?? 0;
  const nextAttempt = currentAttempt + 1;

  // Schedule exponential backoff retry
  newState = scheduleRetry(
    newState,
    issueId,
    runningEntry.identifier,
    nextAttempt,
    maxRetryBackoffMs,
    false, // not continuation
    reason
  );

  return newState;
}

/**
 * Release a claim on an issue
 * Spec: Section 7.1 - Released state
 */
export function releaseClaim(state: OrchestratorState, issueId: string): OrchestratorState {
  const newState = { ...state };

  const claimed = new Set(newState.claimed);
  claimed.delete(issueId);
  newState.claimed = claimed;

  const retryAttempts = { ...newState.retry_attempts };
  delete retryAttempts[issueId];
  newState.retry_attempts = retryAttempts;

  return newState;
}

/**
 * Terminate a running issue
 * Used by reconciliation
 */
export function terminateRunningIssue(
  state: OrchestratorState,
  issueId: string,
  _cleanupWorkspace: boolean
): OrchestratorState {
  const newState = { ...state };

  // Remove from running
  const running = { ...newState.running };
  const runningEntry = running[issueId];

  if (runningEntry) {
    delete running[issueId];
    newState.running = running;

    // Add to runtime seconds
    const elapsedSeconds = (Date.now() - runningEntry.started_at) / 1000;
    const codexTotals: CodexTotals = {
      ...newState.codex_totals,
      seconds_running: newState.codex_totals.seconds_running + elapsedSeconds,
    };
    newState.codex_totals = codexTotals;
  }

  const claimed = new Set(newState.claimed);
  claimed.delete(issueId);
  newState.claimed = claimed;

  const retryAttempts = { ...newState.retry_attempts };
  delete retryAttempts[issueId];
  newState.retry_attempts = retryAttempts;

  // Note: cleanupWorkspace parameter indicates to caller that workspace should be deleted
  // The actual cleanup is handled by the workspace manager in the reconciliation caller

  return newState;
}

/**
 * Get runnable retries (due now)
 */
export function getRunnableRetries(
  state: OrchestratorState
): { issueId: string; retry: RetryEntry }[] {
  const now = Date.now();
  const runnable: { issueId: string; retry: RetryEntry }[] = [];

  for (const [issueId, retry] of Object.entries(state.retry_attempts)) {
    if (retry.due_at_ms <= now) {
      runnable.push({ issueId, retry });
    }
  }

  return runnable;
}

/**
 * Check if there's stall timeout
 * Spec: Section 8.5 - Stall detection
 */
export function checkForStall(entry: RunningEntry, stallTimeoutMs: number): boolean {
  if (stallTimeoutMs <= 0) {
    return false; // Stall detection disabled
  }

  const lastTimestamp = entry.last_codex_timestamp || entry.started_at;
  const elapsedMs = Date.now() - lastTimestamp;

  return elapsedMs > stallTimeoutMs;
}

/**
 * Update running entry with codex event data
 */
export function updateRunningEntryFromCodexEvent(
  entry: RunningEntry,
  event: {
    type: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    message?: string;
  }
): RunningEntry {
  const updated = { ...entry };

  updated.last_codex_event = event.type;
  updated.last_codex_timestamp = Date.now();
  updated.last_codex_message = event.message || null;

  // Update token counts if present
  if (event.usage) {
    if (event.usage.input_tokens !== undefined) {
      updated.codex_input_tokens = event.usage.input_tokens;
    }
    if (event.usage.output_tokens !== undefined) {
      updated.codex_output_tokens = event.usage.output_tokens;
    }
    if (event.usage.total_tokens !== undefined) {
      updated.codex_total_tokens = event.usage.total_tokens;
    }
  }

  return updated;
}
