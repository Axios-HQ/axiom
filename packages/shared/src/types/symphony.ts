/**
 * Symphony specification types and domain models
 * Based on https://github.com/openai/symphony/blob/main/SPEC.md
 */

// ─── Workflow Definition ──────────────────────────────────────────────────────

export interface WorkflowConfig {
  tracker?: TrackerConfig;
  polling?: PollingConfig;
  workspace?: WorkspaceConfig;
  hooks?: HooksConfig;
  agent?: AgentConfig;
  codex?: CodexConfig;
  server?: ServerConfig;
  [key: string]: unknown; // Extensions
}

export interface TrackerConfig {
  kind: "linear"; // Currently only Linear supported
  endpoint?: string; // Default: https://api.linear.app/graphql
  api_key?: string; // Literal or $VAR_NAME
  project_slug: string; // Required for dispatch
  active_states?: string[] | string; // Default: ["Todo", "In Progress"]
  terminal_states?: string[] | string; // Default: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]
}

export interface PollingConfig {
  interval_ms?: number | string; // Default: 30000
}

export interface WorkspaceConfig {
  root?: string; // Path or $VAR, default: system-temp/symphony_workspaces
}

export interface HooksConfig {
  after_create?: string; // Shell script, runs only on new workspace
  before_run?: string; // Shell script, runs before each attempt
  after_run?: string; // Shell script, runs after each attempt
  before_remove?: string; // Shell script, runs before deletion
  timeout_ms?: number; // Default: 60000
}

export interface AgentConfig {
  max_concurrent_agents?: number | string; // Default: 10
  max_turns?: number; // Default: 20
  max_retry_backoff_ms?: number | string; // Default: 300000 (5 min)
  max_concurrent_agents_by_state?: Record<string, number>; // State -> limit
}

export interface CodexConfig {
  command?: string; // Default: "codex app-server"
  approval_policy?: string; // Codex AskForApproval value
  thread_sandbox?: string; // Codex SandboxMode value
  turn_sandbox_policy?: string; // Codex SandboxPolicy value
  turn_timeout_ms?: number; // Default: 3600000 (1 hour)
  read_timeout_ms?: number; // Default: 5000
  stall_timeout_ms?: number; // Default: 300000 (5 min)
}

export interface ServerConfig {
  port?: number | string; // Optional HTTP server port
}

export interface WorkflowDefinition {
  config: WorkflowConfig;
  prompt_template: string; // Trimmed Markdown body
}

// ─── Issue Normalization ──────────────────────────────────────────────────────

export interface IssueBlocker {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string; // Human-readable key (e.g., "ABC-123")
  title: string;
  description: string | null;
  priority: number | null; // Lower = higher priority
  state: string; // Current tracker state name
  branch_name: string | null;
  url: string | null;
  labels: string[]; // Normalized to lowercase
  blocked_by: IssueBlocker[];
  created_at: number | null; // UTC timestamp (ms)
  updated_at: number | null; // UTC timestamp (ms)
}

// ─── Workspace Model ──────────────────────────────────────────────────────────

export interface Workspace {
  path: string;
  workspace_key: string; // Sanitized issue identifier
  created_now: boolean; // True if newly created in this call
}

// ─── Run Attempt ──────────────────────────────────────────────────────────────

export type RunAttemptStatus =
  | "PreparingWorkspace"
  | "BuildingPrompt"
  | "LaunchingAgentProcess"
  | "InitializingSession"
  | "StreamingTurn"
  | "Finishing"
  | "Succeeded"
  | "Failed"
  | "TimedOut"
  | "Stalled"
  | "CanceledByReconciliation";

export interface RunAttempt {
  issue_id: string;
  issue_identifier: string;
  attempt: number | null; // null for first run, >= 1 for retries
  workspace_path: string;
  started_at: number; // UTC timestamp (ms)
  status: RunAttemptStatus;
  error?: string;
}

// ─── Live Session (Agent Session Metadata) ────────────────────────────────────

export interface LiveSession {
  session_id: string; // <thread_id>-<turn_id>
  thread_id: string;
  turn_id: string;
  codex_app_server_pid: string | null;
  last_codex_event: string | null; // Event enum
  last_codex_timestamp: number | null; // UTC timestamp (ms)
  last_codex_message: string | null; // Summarized payload
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  turn_count: number; // Number of turns started within current worker lifetime
}

// ─── Retry Entry ──────────────────────────────────────────────────────────────

export interface RetryEntry {
  issue_id: string;
  identifier: string; // Human-readable issue ID
  attempt: number; // 1-based for retry queue
  due_at_ms: number; // Monotonic clock timestamp (ms)
  timer_handle?: unknown; // Runtime-specific
  error?: string;
}

// ─── Rate Limit Tracking ──────────────────────────────────────────────────────

export interface CodexRateLimits {
  [key: string]: unknown; // Latest rate-limit snapshot from agent events
}

export interface CodexTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

// ─── Orchestrator Runtime State ───────────────────────────────────────────────

export interface RunningEntry {
  worker_handle?: unknown;
  monitor_handle?: unknown;
  identifier: string;
  issue: Issue;
  session_id: string | null;
  codex_app_server_pid: string | null;
  last_codex_message: string | null;
  last_codex_event: string | null;
  last_codex_timestamp: number | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  retry_attempt: number | null;
  started_at: number; // UTC timestamp (ms)
}

export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Record<string, RunningEntry>; // issue_id -> entry
  claimed: Set<string>; // issue IDs reserved/running/retrying
  retry_attempts: Record<string, RetryEntry>; // issue_id -> retry entry
  completed: Set<string>; // issue IDs (bookkeeping)
  codex_totals: CodexTotals;
  codex_rate_limits: CodexRateLimits | null;
}

// ─── Tracker Candidate Query Result ───────────────────────────────────────────

export interface CandidateIssuesResult {
  issues: Issue[];
  hasMore: boolean;
  endCursor?: string;
}

// ─── Validation Result ────────────────────────────────────────────────────────

export type ValidationErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "template_parse_error"
  | "template_render_error"
  | "unsupported_tracker_kind"
  | "missing_tracker_api_key"
  | "missing_tracker_project_slug"
  | "missing_codex_command";

export interface ValidationError {
  code: ValidationErrorCode;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; error: ValidationError };

// ─── Workflow Errors ──────────────────────────────────────────────────────────

export type WorkflowError =
  | { type: "missing_workflow_file" }
  | { type: "workflow_parse_error"; message: string }
  | { type: "workflow_front_matter_not_a_map" }
  | { type: "template_parse_error"; message: string }
  | { type: "template_render_error"; message: string };

// ─── Prompt Template Rendering ────────────────────────────────────────────────

export interface PromptRenderContext {
  issue: Issue;
  attempt: number | null;
}

export type PromptRenderResult = { ok: true; prompt: string } | { ok: false; error: WorkflowError };

// ─── Observability ───────────────────────────────────────────────────────────

export interface StructuredLogContext {
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface RuntimeSnapshot {
  generated_at: string; // ISO 8601 timestamp
  counts: {
    running: number;
    retrying: number;
  };
  running: Array<{
    issue_id: string;
    issue_identifier: string;
    state: string;
    session_id: string | null;
    turn_count: number;
    last_event: string | null;
    last_message: string | null;
    started_at: string; // ISO 8601 timestamp
    last_event_at: string | null; // ISO 8601 timestamp
    tokens: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };
  }>;
  retrying: Array<{
    issue_id: string;
    issue_identifier: string;
    attempt: number;
    due_at: string; // ISO 8601 timestamp
    error: string | null;
  }>;
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    seconds_running: number;
  };
  rate_limits: CodexRateLimits | null;
}

// ─── API Response Types ───────────────────────────────────────────────────────

export interface StateApiResponse {
  generated_at: string;
  counts: {
    running: number;
    retrying: number;
  };
  running: Array<{
    issue_id: string;
    issue_identifier: string;
    state: string;
    session_id: string | null;
    turn_count: number;
    last_event: string | null;
    last_message: string | null;
    started_at: string;
    last_event_at: string | null;
    tokens: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };
  }>;
  retrying: Array<{
    issue_id: string;
    issue_identifier: string;
    attempt: number;
    due_at: string;
    error: string | null;
  }>;
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    seconds_running: number;
  };
  rate_limits: CodexRateLimits | null;
}

export interface IssueDetailApiResponse {
  issue_identifier: string;
  issue_id: string;
  status: "unclaimed" | "running" | "retrying" | "released";
  workspace: {
    path: string;
  };
  attempts: {
    restart_count: number;
    current_retry_attempt: number | null;
  };
  running: RunningEntry | null;
  retry: RetryEntry | null;
  logs: {
    codex_session_logs: Array<{
      label: string;
      path: string;
      url: string | null;
    }>;
  };
  recent_events: Array<{
    at: string; // ISO 8601 timestamp
    event: string;
    message: string;
  }>;
  last_error: string | null;
  tracked: Record<string, unknown>;
}

export interface RefreshApiResponse {
  queued: boolean;
  coalesced: boolean;
  requested_at: string; // ISO 8601 timestamp
  operations: string[];
}
