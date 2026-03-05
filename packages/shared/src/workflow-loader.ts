/**
 * Workflow loader for parsing WORKFLOW.md files
 * Compliant with Symphony spec Section 5
 */

import type { WorkflowDefinition, WorkflowConfig, WorkflowError } from "./types/symphony";

/**
 * Parses YAML front matter and extracts the prompt body
 *
 * Spec: Section 5.2 - File Format
 * - If file starts with ---, parse lines until the next --- as YAML front matter
 * - Remaining lines become the prompt body
 * - If front matter is absent, treat entire file as prompt body with empty config
 * - YAML front matter must decode to a map/object; non-map YAML is an error
 * - Prompt body is trimmed before use
 */
export function parseWorkflowFile(content: string): WorkflowDefinition | WorkflowError {
  const lines = content.split("\n");

  // Check if file starts with front matter delimiter
  if (!lines[0]?.startsWith("---")) {
    // No front matter, entire content is prompt
    return {
      config: {},
      prompt_template: content.trim(),
    };
  }

  // Find closing front matter delimiter
  let frontMatterEndIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.startsWith("---")) {
      frontMatterEndIndex = i;
      break;
    }
  }

  if (frontMatterEndIndex === -1) {
    return {
      type: "workflow_parse_error",
      message: "Front matter not closed (missing closing ---).",
    };
  }

  // Extract and parse front matter
  const frontMatterLines = lines.slice(1, frontMatterEndIndex);
  const frontMatterContent = frontMatterLines.join("\n");

  let config: WorkflowConfig;
  try {
    config = parseYAMLFrontMatter(frontMatterContent);
  } catch (err) {
    return {
      type: "workflow_parse_error",
      message: `Failed to parse YAML front matter: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Validate front matter is a map
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return {
      type: "workflow_front_matter_not_a_map",
    };
  }

  // Extract prompt body (everything after closing ---)
  const promptLines = lines.slice(frontMatterEndIndex + 1);
  const prompt_template = promptLines.join("\n").trim();

  return {
    config,
    prompt_template,
  };
}

/**
 * Simple YAML parser for front matter
 * Handles basic YAML syntax: key: value pairs and simple nested objects
 */
function parseYAMLFrontMatter(content: string): WorkflowConfig {
  const result: WorkflowConfig = {};

  if (!content.trim()) {
    return result;
  }

  const lines = content.split("\n");
  let currentKey: string | null = null;
  let currentNested: Record<string, unknown> | null = null;
  let currentList: unknown[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Get indent level
    const indent = line.match(/^(\s*)/)?.[1].length || 0;

    // Top-level key: value
    if (indent === 0) {
      const match = line.match(/^(\w+)\s*:\s*(.*)/);
      if (match) {
        // Save previous key/nested/list
        if (currentKey) {
          if (currentNested) {
            result[currentKey] = currentNested;
            currentNested = null;
          } else if (currentList) {
            result[currentKey] = currentList;
            currentList = null;
          }
        }

        currentKey = match[1];
        const value = match[2]?.trim() || "";

        if (value === "") {
          // Will be nested or list
          currentNested = {};
          currentList = null;
        } else if (value.startsWith("[")) {
          // Inline list
          const listStr = value.replace(/[[\]]/g, "");
          result[currentKey] = listStr.split(",").map((item) => item.trim());
          currentKey = null;
        } else {
          // Simple value
          result[currentKey] = parseValue(value);
          currentKey = null;
        }
      }
    } else if (indent > 0 && currentKey) {
      // Nested content under current key
      const match = line.match(/^(\s*)(\w+)\s*:\s*(.*)/);
      if (match) {
        const nestedKey = match[2];
        const nestedValue = match[3]?.trim() || "";

        if (!currentNested && !currentList) {
          currentNested = {};
        }

        if (currentNested) {
          if (nestedValue === "" && trimmed.endsWith("-")) {
            // Start of a list
            if (!currentList) {
              currentList = [];
              currentNested[nestedKey] = currentList;
            }
          } else if (nestedValue.startsWith("[")) {
            // Inline list
            const listStr = nestedValue.replace(/[[\]]/g, "");
            currentNested[nestedKey] = listStr.split(",").map((item) => item.trim());
          } else {
            currentNested[nestedKey] = parseValue(nestedValue);
          }
        }
      } else if (trimmed.startsWith("-") && currentList) {
        // List item
        const item = trimmed.replace(/^\s*-\s*/, "").trim();
        if (item) {
          currentList.push(parseValue(item));
        }
      }
    }
  }

  // Save final key/nested/list
  if (currentKey) {
    if (currentNested && Object.keys(currentNested).length > 0) {
      result[currentKey] = currentNested;
    } else if (currentList) {
      result[currentKey] = currentList;
    }
  }

  return result;
}

/**
 * Parse individual YAML values
 */
function parseValue(value: string): unknown {
  if (!value) return null;

  // String values
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  // Boolean values
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "null" || value === "~") return null;

  // Numeric values
  const numVal = Number(value);
  if (!Number.isNaN(numVal) && value !== "") {
    return numVal;
  }

  // Default: return as string
  return value;
}

/**
 * Validate workflow configuration
 * Spec: Section 6.3 - Dispatch Preflight Validation
 */
export function validateDispatchConfig(config: WorkflowConfig):
  | {
      ok: true;
    }
  | { ok: false; error: string } {
  // tracker.kind is required and must be "linear"
  if (!config.tracker?.kind) {
    return {
      ok: false,
      error: "tracker.kind is required and must be present",
    };
  }

  if (config.tracker.kind !== "linear") {
    return {
      ok: false,
      error: `tracker.kind "${config.tracker.kind}" is not supported (only "linear" is currently supported)`,
    };
  }

  // tracker.api_key is required (after $ resolution)
  const apiKey = resolveEnvVar(config.tracker.api_key || "LINEAR_API_KEY");
  if (!apiKey) {
    return {
      ok: false,
      error:
        "tracker.api_key is required and must be present (set LINEAR_API_KEY env var or provide tracker.api_key in WORKFLOW.md)",
    };
  }

  // tracker.project_slug is required for Linear
  if (!config.tracker.project_slug) {
    return {
      ok: false,
      error: "tracker.project_slug is required for tracker.kind=linear",
    };
  }

  // codex.command must be present and non-empty
  const codexCommand = config.codex?.command || "codex app-server";
  if (!codexCommand || typeof codexCommand !== "string") {
    return {
      ok: false,
      error: "codex.command must be a non-empty string",
    };
  }

  return { ok: true };
}

/**
 * Resolve environment variable syntax
 * Spec: Section 6.1 - $VAR_NAME expansion
 */
export function resolveEnvVar(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  // If value starts with $, resolve the env var
  if (value.startsWith("$")) {
    const varName = value.slice(1);
    const resolved = process.env[varName] || "";
    return resolved || null;
  }

  return value;
}

/**
 * Expand path syntax
 * Spec: Section 6.1 - ~ and $VAR expansion for paths
 */
export function expandPath(pathStr: string | undefined): string | null {
  if (!pathStr) {
    return null;
  }

  let expanded = pathStr;

  // ~ expansion (home directory)
  if (expanded.startsWith("~")) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
    expanded = homeDir + expanded.slice(1);
  }

  // $VAR expansion for paths
  if (expanded.includes("$")) {
    const parts = expanded.split(/(\$\w+)/);
    expanded = parts
      .map((part) => {
        if (part.startsWith("$")) {
          const varName = part.slice(1);
          return process.env[varName] || part;
        }
        return part;
      })
      .join("");
  }

  return expanded;
}

/**
 * Get default workspace root
 * Spec: Section 5.3.3 - workspace.root default
 */
export function getDefaultWorkspaceRoot(): string {
  const tmpDir = process.env.TMPDIR || process.env.TMP || "/tmp";
  return `${tmpDir}/symphony_workspaces`;
}

/**
 * Normalize active/terminal states (trim + lowercase)
 * Spec: Section 4.2 - Normalized Issue State
 */
export function normalizeStates(states: string | string[] | undefined): string[] {
  if (!states) {
    return [];
  }

  const stateArray = Array.isArray(states) ? states : states.split(",").map((s) => s.trim());

  return stateArray.filter((s) => s).map((s) => s.trim().toLowerCase());
}

/**
 * Get effective configuration with defaults applied
 * Spec: Section 5.3 - Front Matter Schema with defaults
 */
export function getEffectiveConfig(workflowConfig: WorkflowConfig): {
  tracker: {
    kind: "linear";
    endpoint: string;
    api_key: string;
    project_slug: string;
    active_states: string[];
    terminal_states: string[];
  };
  polling: {
    interval_ms: number;
  };
  workspace: {
    root: string;
  };
  hooks: {
    after_create: string | null;
    before_run: string | null;
    after_run: string | null;
    before_remove: string | null;
    timeout_ms: number;
  };
  agent: {
    max_concurrent_agents: number;
    max_turns: number;
    max_retry_backoff_ms: number;
    max_concurrent_agents_by_state: Record<string, number>;
  };
  codex: {
    command: string;
    approval_policy: string | null;
    thread_sandbox: string | null;
    turn_sandbox_policy: string | null;
    turn_timeout_ms: number;
    read_timeout_ms: number;
    stall_timeout_ms: number;
  };
} {
  // Tracker config
  const trackerEndpoint = workflowConfig.tracker?.endpoint || "https://api.linear.app/graphql";
  const trackerApiKey =
    resolveEnvVar(workflowConfig.tracker?.api_key || process.env.LINEAR_API_KEY) || "";
  const trackerProjectSlug = workflowConfig.tracker?.project_slug || "";
  const activeStates = normalizeStates(
    workflowConfig.tracker?.active_states || ["Todo", "In Progress"]
  );
  const terminalStates = normalizeStates(
    workflowConfig.tracker?.terminal_states || [
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]
  );

  // Polling config
  const pollingIntervalMs = parseIntConfig(workflowConfig.polling?.interval_ms, 30000);

  // Workspace config
  const workspaceRoot = expandPath(workflowConfig.workspace?.root) || getDefaultWorkspaceRoot();

  // Hooks config
  const hooksTimeoutMs = parseIntConfig(workflowConfig.hooks?.timeout_ms, 60000);
  const hooksConfig = {
    after_create: workflowConfig.hooks?.after_create || null,
    before_run: workflowConfig.hooks?.before_run || null,
    after_run: workflowConfig.hooks?.after_run || null,
    before_remove: workflowConfig.hooks?.before_remove || null,
    timeout_ms: Math.max(hooksTimeoutMs, 1), // Prevent non-positive values
  };

  // Agent config
  const maxConcurrentAgents = parseIntConfig(workflowConfig.agent?.max_concurrent_agents, 10);
  const maxTurns = parseIntConfig(workflowConfig.agent?.max_turns, 20);
  const maxRetryBackoffMs = parseIntConfig(workflowConfig.agent?.max_retry_backoff_ms, 300000);

  // Per-state concurrency limits (normalize state names)
  const maxConcurrentByState: Record<string, number> = {};
  if (workflowConfig.agent?.max_concurrent_agents_by_state) {
    for (const [state, limit] of Object.entries(
      workflowConfig.agent.max_concurrent_agents_by_state
    )) {
      const normalizedState = state.trim().toLowerCase();
      const numLimit = Number(limit);
      if (!Number.isNaN(numLimit) && numLimit > 0) {
        maxConcurrentByState[normalizedState] = numLimit;
      }
    }
  }

  // Codex config
  const codexCommand = workflowConfig.codex?.command || "codex app-server";
  const codexTurnTimeoutMs = parseIntConfig(workflowConfig.codex?.turn_timeout_ms, 3600000);
  const codexReadTimeoutMs = parseIntConfig(workflowConfig.codex?.read_timeout_ms, 5000);
  const codexStallTimeoutMs = parseIntConfig(workflowConfig.codex?.stall_timeout_ms, 300000);

  return {
    tracker: {
      kind: "linear" as const,
      endpoint: trackerEndpoint,
      api_key: trackerApiKey,
      project_slug: trackerProjectSlug,
      active_states: activeStates,
      terminal_states: terminalStates,
    },
    polling: {
      interval_ms: pollingIntervalMs,
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks: hooksConfig,
    agent: {
      max_concurrent_agents: maxConcurrentAgents,
      max_turns: maxTurns,
      max_retry_backoff_ms: maxRetryBackoffMs,
      max_concurrent_agents_by_state: maxConcurrentByState,
    },
    codex: {
      command: codexCommand,
      approval_policy: workflowConfig.codex?.approval_policy || null,
      thread_sandbox: workflowConfig.codex?.thread_sandbox || null,
      turn_sandbox_policy: workflowConfig.codex?.turn_sandbox_policy || null,
      turn_timeout_ms: codexTurnTimeoutMs,
      read_timeout_ms: codexReadTimeoutMs,
      stall_timeout_ms: codexStallTimeoutMs,
    },
  };
}

/**
 * Parse integer config value with default
 */
function parseIntConfig(value: number | string | undefined, defaultValue: number): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  const num = Number(value);
  return Number.isNaN(num) ? defaultValue : num;
}
