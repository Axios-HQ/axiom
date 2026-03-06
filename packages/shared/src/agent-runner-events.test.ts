import { describe, expect, it } from "vitest";
import { normalizeRunnerNotification, RunnerTokenTracker } from "./agent-runner-events";
import type { JsonRpcNotification } from "./agent-runner-protocol";

describe("agent-runner-events", () => {
  it("normalizes event notifications and extracts usage", () => {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "step_finish",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
        },
      },
    };

    const normalized = normalizeRunnerNotification(notification);
    expect(normalized?.type).toBe("step_finish");
    expect(normalized?.usage?.total_tokens).toBe(30);
  });

  it("tracks token totals across notification stream", () => {
    const tracker = new RunnerTokenTracker();
    tracker.ingestNotification({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "token",
        usage: {
          input_tokens: 5,
          output_tokens: 10,
          total_tokens: 15,
        },
      },
    });

    tracker.ingestNotification({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "token",
        usage: {
          input_tokens: 0,
          output_tokens: 12,
          total_tokens: 20,
        },
      },
    });

    expect(tracker.getTotals()).toEqual({
      input_tokens: 0,
      output_tokens: 12,
      total_tokens: 20,
      seconds_running: 0,
    });
  });
});
