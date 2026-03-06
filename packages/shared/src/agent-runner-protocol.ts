import type { CodexTotals } from "./types/symphony";

export type JsonRpcId = number | string;

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: TResult;
  error?: JsonRpcError;
}

export interface RunnerUsageEvent {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface RunnerInitializeParams {
  protocolVersion: string;
  approvalPolicy: string | null;
  threadSandbox: string | null;
  turnSandboxPolicy: string | null;
}

export interface RunnerInitializeResult {
  protocolVersion: string;
  serverName?: string;
  serverVersion?: string;
  capabilities?: Record<string, unknown>;
}

export interface RunnerPolicyConfig {
  approval_policy: string | null;
  thread_sandbox: string | null;
  turn_sandbox_policy: string | null;
}

export type RunnerApprovalPolicy =
  | "never"
  | "on-failure"
  | "on-request"
  | "untrusted"
  | "on"
  | "off";

export type RunnerThreadSandbox = "read-only" | "workspace-write" | "danger-full-access";

export type RunnerTurnSandboxPolicy = "allow-network" | "deny-network" | "allow" | "deny";

const VALID_APPROVAL_POLICIES: ReadonlySet<string> = new Set([
  "never",
  "on-failure",
  "on-request",
  "untrusted",
  "on",
  "off",
]);

const VALID_THREAD_SANDBOXES: ReadonlySet<string> = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

const VALID_TURN_SANDBOX_POLICIES: ReadonlySet<string> = new Set([
  "allow-network",
  "deny-network",
  "allow",
  "deny",
]);

export function toRunnerInitializeParams(config: RunnerPolicyConfig): RunnerInitializeParams {
  return {
    protocolVersion: "1.0",
    approvalPolicy: config.approval_policy,
    threadSandbox: config.thread_sandbox,
    turnSandboxPolicy: config.turn_sandbox_policy,
  };
}

export function validateRunnerPolicyConfig(
  config: RunnerPolicyConfig
): { ok: true } | { ok: false; error: string } {
  if (config.approval_policy !== null && !VALID_APPROVAL_POLICIES.has(config.approval_policy)) {
    return {
      ok: false,
      error: `Unsupported approval policy: ${config.approval_policy}`,
    };
  }

  if (config.thread_sandbox !== null && !VALID_THREAD_SANDBOXES.has(config.thread_sandbox)) {
    return {
      ok: false,
      error: `Unsupported thread sandbox: ${config.thread_sandbox}`,
    };
  }

  if (
    config.turn_sandbox_policy !== null &&
    !VALID_TURN_SANDBOX_POLICIES.has(config.turn_sandbox_policy)
  ) {
    return {
      ok: false,
      error: `Unsupported turn sandbox policy: ${config.turn_sandbox_policy}`,
    };
  }

  return { ok: true };
}

export function applyRunnerUsageEvent(
  totals: CodexTotals,
  usage: RunnerUsageEvent | undefined,
  previousReported: RunnerUsageEvent
): { totals: CodexTotals; nextReported: RunnerUsageEvent } {
  if (!usage || usage.total_tokens === undefined) {
    return {
      totals,
      nextReported: previousReported,
    };
  }

  const nextTotal = usage.total_tokens;
  const prevTotal = previousReported.total_tokens ?? 0;
  const totalDelta = nextTotal - prevTotal;

  if (totalDelta <= 0) {
    return {
      totals,
      nextReported: {
        input_tokens: usage.input_tokens ?? previousReported.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? previousReported.output_tokens ?? 0,
        total_tokens: nextTotal,
      },
    };
  }

  const nextInput = usage.input_tokens ?? previousReported.input_tokens ?? 0;
  const nextOutput = usage.output_tokens ?? previousReported.output_tokens ?? 0;
  const prevInput = previousReported.input_tokens ?? 0;
  const prevOutput = previousReported.output_tokens ?? 0;

  return {
    totals: {
      ...totals,
      total_tokens: totals.total_tokens + totalDelta,
      input_tokens: totals.input_tokens + (nextInput - prevInput),
      output_tokens: totals.output_tokens + (nextOutput - prevOutput),
    },
    nextReported: {
      input_tokens: nextInput,
      output_tokens: nextOutput,
      total_tokens: nextTotal,
    },
  };
}
