import { describe, expect, it } from "vitest";
import { formatAgentResponse } from "./extractor";
import type { AgentResponse } from "../types";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    textContent: "",
    toolCalls: [],
    artifacts: [],
    success: true,
    ...overrides,
  };
}

// ─── formatAgentResponse – screenshot artifacts ──────────────────────────────

describe("formatAgentResponse – screenshot artifacts", () => {
  it("includes markdown image for a screenshot artifact with label", () => {
    const result = formatAgentResponse(
      makeResponse({
        artifacts: [
          { type: "screenshot", url: "https://example.com/shot.png", label: "Login page" },
        ],
      })
    );
    expect(result).toContain("![Login page](https://example.com/shot.png)");
  });

  it('uses default alt text "Screenshot" when label is missing', () => {
    const result = formatAgentResponse(
      makeResponse({
        artifacts: [{ type: "screenshot", url: "https://example.com/shot.png", label: "" }],
      })
    );
    expect(result).toContain("![Screenshot](https://example.com/shot.png)");
  });

  it("renders multiple screenshot artifacts as separate markdown images", () => {
    const result = formatAgentResponse(
      makeResponse({
        artifacts: [
          { type: "screenshot", url: "https://example.com/a.png", label: "First" },
          { type: "screenshot", url: "https://example.com/b.png", label: "Second" },
        ],
      })
    );
    expect(result).toContain("![First](https://example.com/a.png)");
    expect(result).toContain("![Second](https://example.com/b.png)");
  });

  it("excludes screenshot artifacts that have no url", () => {
    const result = formatAgentResponse(
      makeResponse({
        artifacts: [{ type: "screenshot", url: "", label: "No URL" }],
      })
    );
    expect(result).not.toContain("![No URL]");
  });

  it("does not include non-screenshot artifacts as images", () => {
    const result = formatAgentResponse(
      makeResponse({
        artifacts: [{ type: "pr", url: "https://github.com/pr/1", label: "PR #1" }],
      })
    );
    expect(result).not.toContain("![");
  });
});
