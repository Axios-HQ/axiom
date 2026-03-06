import {
  applyRunnerUsageEvent,
  type JsonRpcNotification,
  type RunnerUsageEvent,
} from "./agent-runner-protocol";
import type { CodexTotals } from "./types/symphony";

export interface NormalizedRunnerEvent {
  type: string;
  message?: string;
  usage?: RunnerUsageEvent;
  payload: Record<string, unknown>;
}

const EVENT_METHODS = new Set(["event", "runner/event", "codex/event", "notification"]);

export function normalizeRunnerNotification(
  notification: JsonRpcNotification
): NormalizedRunnerEvent | null {
  const params = isRecord(notification.params) ? notification.params : null;
  if (!params) {
    return null;
  }

  if (EVENT_METHODS.has(notification.method)) {
    const type = typeof params.type === "string" ? params.type : null;
    if (!type) {
      return null;
    }

    return {
      type,
      message: typeof params.message === "string" ? params.message : undefined,
      usage: extractUsage(params),
      payload: params,
    };
  }

  return {
    type: notification.method,
    message: typeof params.message === "string" ? params.message : undefined,
    usage: extractUsage(params),
    payload: params,
  };
}

export class RunnerTokenTracker {
  private totals: CodexTotals;
  private previous: RunnerUsageEvent;

  constructor(initialTotals?: CodexTotals) {
    this.totals =
      initialTotals ??
      ({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        seconds_running: 0,
      } satisfies CodexTotals);
    this.previous = {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };
  }

  ingestUsage(usage: RunnerUsageEvent | undefined): CodexTotals {
    const result = applyRunnerUsageEvent(this.totals, usage, this.previous);
    this.totals = result.totals;
    this.previous = result.nextReported;
    return this.totals;
  }

  ingestNotification(notification: JsonRpcNotification): CodexTotals {
    const normalized = normalizeRunnerNotification(notification);
    return this.ingestUsage(normalized?.usage);
  }

  getTotals(): CodexTotals {
    return this.totals;
  }
}

function extractUsage(params: Record<string, unknown>): RunnerUsageEvent | undefined {
  const usage = isRecord(params.usage)
    ? params.usage
    : isRecord(params.tokens)
      ? params.tokens
      : null;

  if (!usage) {
    return undefined;
  }

  return {
    input_tokens: asNumberOrUndefined(usage.input_tokens),
    output_tokens: asNumberOrUndefined(usage.output_tokens),
    total_tokens: asNumberOrUndefined(usage.total_tokens),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
