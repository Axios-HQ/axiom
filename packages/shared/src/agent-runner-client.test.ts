import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunnerClient } from "./agent-runner-client";

function createMockRunnerScript(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-client-test-"));
  const scriptPath = join(dir, "runner.js");
  writeFileSync(scriptPath, contents, "utf8");
  return scriptPath;
}

describe("AgentRunnerClient", () => {
  it("launches process and performs initialize handshake", async () => {
    const scriptPath = createMockRunnerScript(`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "1.0", serverName: "mock-runner" } }) + "\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "token", usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } }) + "\\n");
  }
  if (req.method === "shutdown") {
    process.exit(0);
  }
});
setInterval(() => {}, 1000);
`);

    const client = new AgentRunnerClient({
      command: "node",
      args: [scriptPath],
      policy: {
        approval_policy: "never",
        thread_sandbox: "workspace-write",
        turn_sandbox_policy: "allow-network",
      },
    });

    const initialize = await client.launch();
    expect(initialize.protocolVersion).toBe("1.0");
    expect(initialize.serverName).toBe("mock-runner");

    const notification = await client.waitForNotification(500);
    expect(notification.method).toBe("event");

    await client.shutdown();
    rmSync(dirname(scriptPath), { recursive: true, force: true });
  });

  it("times out when initialize response never arrives", async () => {
    const scriptPath = createMockRunnerScript(`
setInterval(() => {}, 1000);
`);

    const client = new AgentRunnerClient({
      command: "node",
      args: [scriptPath],
      policy: {
        approval_policy: null,
        thread_sandbox: null,
        turn_sandbox_policy: null,
      },
      handshakeTimeoutMs: 50,
    });

    await expect(client.launch()).rejects.toThrow("JSON-RPC request timed out");
    await client.shutdown();
    rmSync(dirname(scriptPath), { recursive: true, force: true });
  });
});
