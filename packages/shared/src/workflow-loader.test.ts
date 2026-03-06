/**
 * Tests for workflow loader
 * Validates Symphony spec compliance
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseWorkflowFile,
  validateDispatchConfig,
  resolveEnvVar,
  normalizeStates,
  getEffectiveConfig,
} from "./workflow-loader";

describe("Workflow Loader", () => {
  beforeEach(() => {
    delete process.env.LINEAR_API_KEY;
  });

  describe("parseWorkflowFile", () => {
    it("should parse workflow with YAML front matter", () => {
      const content = `---
tracker:
  kind: linear
  project_slug: MY_PROJECT
polling:
  interval_ms: 30000
---
You are working on an issue.`;

      const result = parseWorkflowFile(content);

      if ("type" in result) {
        throw new Error("Expected valid workflow");
      }

      expect(result.config.tracker?.kind).toBe("linear");
      expect(result.config.polling?.interval_ms).toBe(30000);
      expect(result.prompt_template).toBe("You are working on an issue.");
    });

    it("should handle workflow without front matter", () => {
      const content = "Just a simple prompt.";
      const result = parseWorkflowFile(content);

      if ("type" in result) {
        throw new Error("Expected valid workflow");
      }

      expect(result.config).toEqual({});
      expect(result.prompt_template).toBe("Just a simple prompt.");
    });

    it("should error on unclosed front matter", () => {
      const content = `---
tracker:
  kind: linear

Just prompt`;

      const result = parseWorkflowFile(content);

      if (!("type" in result)) {
        throw new Error("Expected error");
      }

      expect(result.type).toBe("workflow_parse_error");
    });
  });

  describe("validateDispatchConfig", () => {
    it("should reject missing tracker.kind", () => {
      const result = validateDispatchConfig({});
      expect(result.ok).toBe(false);
      expect((result as any).error).toContain("tracker.kind");
    });

    it("should reject unsupported tracker kind", () => {
      const result = validateDispatchConfig({
        tracker: { kind: "jira" as any, project_slug: "TEST" },
      });
      expect(result.ok).toBe(false);
      expect((result as any).error).toContain("not supported");
    });

    it("should reject missing api_key", () => {
      delete process.env.LINEAR_API_KEY;
      const result = validateDispatchConfig({
        tracker: { kind: "linear", project_slug: "TEST" } as any,
      });
      expect(result.ok).toBe(false);
      expect((result as any).error).toContain("api_key");
    });

    it("should reject missing project_slug for linear", () => {
      process.env.LINEAR_API_KEY = "test-key";
      const result = validateDispatchConfig({
        tracker: { kind: "linear" } as any,
      });
      expect(result.ok).toBe(false);
      expect((result as any).error).toContain("project_slug");
      delete process.env.LINEAR_API_KEY;
    });

    it("should accept valid minimal config", () => {
      process.env.LINEAR_API_KEY = "test-key";
      const result = validateDispatchConfig({
        tracker: { kind: "linear", project_slug: "TEST" },
      });
      expect(result.ok).toBe(true);
      delete process.env.LINEAR_API_KEY;
    });
  });

  describe("resolveEnvVar", () => {
    it("should resolve $VAR syntax", () => {
      process.env.TEST_VAR = "resolved";
      const result = resolveEnvVar("$TEST_VAR");
      expect(result).toBe("resolved");
      delete process.env.TEST_VAR;
    });

    it("should return literal string if not $VAR", () => {
      const result = resolveEnvVar("literal-value");
      expect(result).toBe("literal-value");
    });

    it("should return null for undefined", () => {
      const result = resolveEnvVar(undefined);
      expect(result).toBeNull();
    });

    it("should return null for empty $VAR", () => {
      const result = resolveEnvVar("$UNDEFINED_VAR_XYZ");
      expect(result).toBeNull();
    });
  });

  describe("normalizeStates", () => {
    it("should normalize string to lowercase array", () => {
      const result = normalizeStates("Todo, In Progress");
      expect(result).toEqual(["todo", "in progress"]);
    });

    it("should normalize array of strings", () => {
      const result = normalizeStates(["Todo", "DONE"]);
      expect(result).toEqual(["todo", "done"]);
    });

    it("should return empty array for undefined", () => {
      const result = normalizeStates(undefined);
      expect(result).toEqual([]);
    });
  });

  describe("getEffectiveConfig", () => {
    beforeEach(() => {
      process.env.LINEAR_API_KEY = "test-key";
    });

    afterEach(() => {
      delete process.env.LINEAR_API_KEY;
    });

    it("should apply defaults", () => {
      const config = getEffectiveConfig({
        tracker: { kind: "linear", project_slug: "TEST" },
      });

      expect(config.polling.interval_ms).toBe(30000);
      expect(config.hooks.timeout_ms).toBe(60000);
      expect(config.agent.max_concurrent_agents).toBe(10);
      expect(config.agent.max_turns).toBe(20);
      expect(config.codex.command).toBe("codex app-server");
      expect(config.codex.turn_timeout_ms).toBe(3600000);
      expect(config.tracker.endpoint).toBe("https://api.linear.app/graphql");
    });

    it("should use configured values over defaults", () => {
      const config = getEffectiveConfig({
        tracker: { kind: "linear", project_slug: "TEST" },
        polling: { interval_ms: 60000 },
        hooks: { timeout_ms: 120000 },
        agent: { max_concurrent_agents: 5 },
      });

      expect(config.polling.interval_ms).toBe(60000);
      expect(config.hooks.timeout_ms).toBe(120000);
      expect(config.agent.max_concurrent_agents).toBe(5);
    });

    it("should normalize active and terminal states", () => {
      const config = getEffectiveConfig({
        tracker: {
          kind: "linear",
          project_slug: "TEST",
          active_states: ["TODO", "In Progress"],
          terminal_states: ["Done", "CANCELLED"],
        },
      });

      expect(config.tracker.active_states).toEqual(["todo", "in progress"]);
      expect(config.tracker.terminal_states).toEqual(["done", "cancelled"]);
    });
  });
});
