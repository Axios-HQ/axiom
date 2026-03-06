import { describe, expect, it } from "vitest";
import {
  applyRunnerUsageEvent,
  toRunnerInitializeParams,
  validateRunnerPolicyConfig,
  type RunnerUsageEvent,
} from "./agent-runner-protocol";

describe("agent-runner-protocol", () => {
  it("maps codex policy config to initialize params", () => {
    const params = toRunnerInitializeParams({
      approval_policy: "on-request",
      thread_sandbox: "workspace-write",
      turn_sandbox_policy: "allow-network",
    });

    expect(params).toEqual({
      protocolVersion: "1.0",
      approvalPolicy: "on-request",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: "allow-network",
    });
  });

  it("applies incremental usage updates with zero-safe accounting", () => {
    const previousReported: RunnerUsageEvent = {
      input_tokens: 5,
      output_tokens: 10,
      total_tokens: 15,
    };

    const result = applyRunnerUsageEvent(
      {
        input_tokens: 100,
        output_tokens: 200,
        total_tokens: 300,
        seconds_running: 0,
      },
      {
        input_tokens: 0,
        output_tokens: 12,
        total_tokens: 27,
      },
      previousReported
    );

    expect(result.totals).toEqual({
      input_tokens: 95,
      output_tokens: 202,
      total_tokens: 312,
      seconds_running: 0,
    });
    expect(result.nextReported).toEqual({
      input_tokens: 0,
      output_tokens: 12,
      total_tokens: 27,
    });
  });

  it("validates approval and sandbox policies", () => {
    const valid = validateRunnerPolicyConfig({
      approval_policy: "on-request",
      thread_sandbox: "workspace-write",
      turn_sandbox_policy: "allow-network",
    });
    expect(valid.ok).toBe(true);

    const invalid = validateRunnerPolicyConfig({
      approval_policy: "invalid",
      thread_sandbox: null,
      turn_sandbox_policy: null,
    });
    expect(invalid).toEqual({
      ok: false,
      error: "Unsupported approval policy: invalid",
    });
  });
});
