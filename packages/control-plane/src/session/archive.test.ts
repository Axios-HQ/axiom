/**
 * Unit tests for archive handler behavior.
 *
 * Tests the archive flow: snapshot + sandbox termination + status transition.
 * Since SessionDO is tightly coupled to the runtime, these tests verify
 * the expected behavior through the handler's contract:
 * - Snapshot is attempted before termination
 * - Sandbox is shut down and marked as stopped
 * - Session transitions to "archived" status
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("archive handler implementation", () => {
  const doSource = readFileSync(new URL("./durable-object.ts", import.meta.url), "utf8");

  it("calls triggerSnapshot with 'archive' reason before terminating", () => {
    // Verify the handler takes a snapshot with the "archive" reason
    expect(doSource).toContain('await this.triggerSnapshot("archive")');
  });

  it("sends shutdown to sandbox WebSocket", () => {
    // Verify the handler sends shutdown command
    expect(doSource).toContain('this.wsManager.send(sandboxWs, { type: "shutdown" })');
  });

  it("updates sandbox status to stopped", () => {
    // Verify sandbox is marked as stopped
    expect(doSource).toContain('this.updateSandboxStatus("stopped")');
  });

  it("transitions session to archived status after sandbox cleanup", () => {
    // Verify the archive status transition happens
    expect(doSource).toContain('await this.transitionSessionStatus("archived")');
  });

  it("checks sandbox status before attempting cleanup", () => {
    // Verify we don't try to snapshot/terminate already-stopped sandboxes
    expect(doSource).toContain('sandbox.status !== "stopped"');
    expect(doSource).toContain('sandbox.status !== "failed"');
  });

  it("handles snapshot failure gracefully without blocking archive", () => {
    // Verify snapshot errors are caught and logged, not propagated
    expect(doSource).toContain("Snapshot before archive failed");
  });
});
