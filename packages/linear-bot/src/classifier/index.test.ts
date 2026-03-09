/**
 * Tests for the Linear bot repository classifier.
 *
 * Covers:
 * - Positive match: high-confidence LLM classification picks the correct repo
 * - Low-confidence fallback: needsClarification returned instead of creating session
 * - Medium-confidence with alternatives: treated as needsClarification
 * - Wrong-repo regression: LLM returns a repo ID not in the available list → treated as needsClarification
 * - Single-repo shortcut: skips LLM entirely
 * - No-repos shortcut: returns needsClarification immediately
 * - API error handling: falls back to needsClarification with alternatives
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RepoConfig } from "../types";

// Hoist mocks so they are available before imports
const { mockFetch, mockGetAvailableRepos, mockBuildRepoDescriptions } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetAvailableRepos: vi.fn(),
  mockBuildRepoDescriptions: vi.fn(),
}));

vi.stubGlobal("fetch", mockFetch);

vi.mock("./repos", () => ({
  getAvailableRepos: mockGetAvailableRepos,
  buildRepoDescriptions: mockBuildRepoDescriptions,
}));

import { classifyRepo } from "./index";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TEST_REPOS: RepoConfig[] = [
  {
    id: "acme/backend",
    owner: "acme",
    name: "backend",
    fullName: "acme/backend",
    displayName: "backend",
    description: "Backend API service (Node.js, REST)",
    defaultBranch: "main",
    private: true,
    aliases: ["api", "server"],
    keywords: ["node", "api", "postgres"],
  },
  {
    id: "acme/frontend",
    owner: "acme",
    name: "frontend",
    fullName: "acme/frontend",
    displayName: "frontend",
    description: "React web application",
    defaultBranch: "main",
    private: true,
    aliases: ["web", "ui"],
    keywords: ["react", "typescript", "ui"],
  },
];

const TEST_ENV = {
  ANTHROPIC_API_KEY: "test-api-key",
} as Env;

function makeAnthropicSuccess(
  repoId: string | null,
  confidence: string,
  reasoning: string,
  alternatives: string[] = []
): Response {
  return {
    ok: true,
    json: async () => ({
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "classify_repository",
          input: { repoId, confidence, reasoning, alternatives },
        },
      ],
    }),
  } as unknown as Response;
}

function makeAnthropicError(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: async () => body,
  } as unknown as Response;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("classifyRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue(TEST_REPOS);
    mockBuildRepoDescriptions.mockResolvedValue(
      "- acme/backend: Backend API service\n- acme/frontend: React web application"
    );
  });

  // ── Positive match ────────────────────────────────────────────────────────

  it("returns the matched repo when LLM returns high confidence", async () => {
    mockFetch.mockResolvedValue(
      makeAnthropicSuccess("acme/backend", "high", "Issue mentions API endpoint fix.", [])
    );

    const result = await classifyRepo(
      TEST_ENV,
      "Fix broken API endpoint",
      "The /users endpoint returns 500 on invalid input.",
      ["bug"],
      null,
      "trace-1"
    );

    expect(result.repo?.fullName).toBe("acme/backend");
    expect(result.confidence).toBe("high");
    expect(result.needsClarification).toBe(false);
    expect(result.alternatives).toBeUndefined();
  });

  it("matches by fullName case-insensitively", async () => {
    mockFetch.mockResolvedValue(
      makeAnthropicSuccess("ACME/BACKEND", "high", "Uppercase repo ID still resolves.", [])
    );

    const result = await classifyRepo(TEST_ENV, "Backend bug", null, [], null);

    expect(result.repo?.fullName).toBe("acme/backend");
    expect(result.needsClarification).toBe(false);
  });

  // ── Low-confidence fallback ───────────────────────────────────────────────

  it("sets needsClarification when confidence is low", async () => {
    mockFetch.mockResolvedValue(
      makeAnthropicSuccess("acme/backend", "low", "Unclear which service this belongs to.", [
        "acme/frontend",
      ])
    );

    const result = await classifyRepo(
      TEST_ENV,
      "Something is broken",
      "Not sure which service.",
      [],
      null,
      "trace-2"
    );

    expect(result.needsClarification).toBe(true);
    expect(result.confidence).toBe("low");
    expect(result.repo?.fullName).toBe("acme/backend");
  });

  it("sets needsClarification when confidence is medium with alternatives", async () => {
    mockFetch.mockResolvedValue(
      makeAnthropicSuccess("acme/frontend", "medium", "Could be frontend or backend.", [
        "acme/backend",
      ])
    );

    const result = await classifyRepo(
      TEST_ENV,
      "UI button doesn't work",
      "Clicking the submit button causes an error.",
      ["bug"],
      null
    );

    expect(result.needsClarification).toBe(true);
    expect(result.confidence).toBe("medium");
    expect(result.repo?.fullName).toBe("acme/frontend");
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives![0].fullName).toBe("acme/backend");
  });

  it("does NOT set needsClarification for medium confidence with no alternatives", async () => {
    mockFetch.mockResolvedValue(
      makeAnthropicSuccess("acme/frontend", "medium", "Likely frontend.", [])
    );

    const result = await classifyRepo(TEST_ENV, "UI issue", null, [], null);

    expect(result.needsClarification).toBe(false);
    expect(result.confidence).toBe("medium");
  });

  // ── Wrong-repo regression ─────────────────────────────────────────────────

  it("sets needsClarification when LLM returns a repo ID not in available list", async () => {
    mockFetch.mockResolvedValue(
      makeAnthropicSuccess(
        "acme/nonexistent",
        "high",
        "This repo was hallucinated by the model.",
        []
      )
    );

    const result = await classifyRepo(
      TEST_ENV,
      "Fix issue in nonexistent repo",
      null,
      [],
      null,
      "trace-regression"
    );

    expect(result.repo).toBeNull();
    expect(result.needsClarification).toBe(true);
    // The LLM confidence field is still returned as-is
    expect(result.confidence).toBe("high");
  });

  it("sets needsClarification when LLM returns null repoId", async () => {
    mockFetch.mockResolvedValue(
      makeAnthropicSuccess(null, "low", "Cannot determine repo.", ["acme/backend", "acme/frontend"])
    );

    const result = await classifyRepo(TEST_ENV, "Some vague issue", null, [], null);

    expect(result.repo).toBeNull();
    expect(result.needsClarification).toBe(true);
    expect(result.alternatives).toHaveLength(2);
  });

  // ── Single-repo shortcut ──────────────────────────────────────────────────

  it("returns the single repo with high confidence without calling the LLM", async () => {
    mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);

    const result = await classifyRepo(TEST_ENV, "Any issue title", null, [], null);

    expect(result.repo?.fullName).toBe("acme/backend");
    expect(result.confidence).toBe("high");
    expect(result.needsClarification).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── No-repos shortcut ─────────────────────────────────────────────────────

  it("returns needsClarification immediately when no repos are available", async () => {
    mockGetAvailableRepos.mockResolvedValue([]);

    const result = await classifyRepo(TEST_ENV, "Any issue title", null, [], null);

    expect(result.repo).toBeNull();
    expect(result.needsClarification).toBe(true);
    expect(result.confidence).toBe("low");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── API error handling ────────────────────────────────────────────────────

  it("returns needsClarification with alternatives when Anthropic API returns an error", async () => {
    mockFetch.mockResolvedValue(makeAnthropicError(500, "Internal Server Error"));

    const result = await classifyRepo(TEST_ENV, "Fix the thing", null, [], null, "trace-api-error");

    expect(result.repo).toBeNull();
    expect(result.needsClarification).toBe(true);
    expect(result.confidence).toBe("low");
    expect(result.alternatives).toHaveLength(2);
  });

  it("returns needsClarification when fetch throws a network error", async () => {
    mockFetch.mockRejectedValue(new Error("network failure"));

    const result = await classifyRepo(TEST_ENV, "Fix the thing", null, [], null);

    expect(result.repo).toBeNull();
    expect(result.needsClarification).toBe(true);
    expect(result.alternatives).toHaveLength(2);
  });

  it("caps alternatives at 5 repos on error", async () => {
    const manyRepos: RepoConfig[] = Array.from({ length: 8 }, (_, i) => ({
      id: `acme/repo${i}`,
      owner: "acme",
      name: `repo${i}`,
      fullName: `acme/repo${i}`,
      displayName: `repo${i}`,
      description: `Repo ${i}`,
      defaultBranch: "main",
      private: false,
    }));
    mockGetAvailableRepos.mockResolvedValue(manyRepos);
    mockFetch.mockRejectedValue(new Error("network failure"));

    const result = await classifyRepo(TEST_ENV, "Fix the thing", null, [], null);

    expect(result.alternatives).toHaveLength(5);
  });

  // ── Alternatives deduplication ────────────────────────────────────────────

  it("excludes the matched repo from alternatives", async () => {
    mockFetch.mockResolvedValue(
      makeAnthropicSuccess(
        "acme/backend",
        "medium",
        "Probably backend.",
        // LLM mistakenly includes matched repo in alternatives
        ["acme/backend", "acme/frontend"]
      )
    );

    const result = await classifyRepo(TEST_ENV, "Backend issue", null, [], null);

    expect(result.repo?.fullName).toBe("acme/backend");
    expect(result.alternatives?.map((r) => r.fullName)).not.toContain("acme/backend");
    expect(result.alternatives?.map((r) => r.fullName)).toContain("acme/frontend");
  });
});
