import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock fetchWithTimeout before importing the module under test
vi.mock("../auth/github-app", () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from "../auth/github-app";
import { resolveGitHubUserById, resolveGitHubUserByEmail } from "./github-user-resolver";

const mockFetch = vi.mocked(fetchWithTimeout);

/** Helper to create a mock Response. */
function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveGitHubUserById", () => {
  it("returns user when GitHub API responds 200", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, { login: "octocat", id: 1, name: "The Octocat" })
    );

    const result = await resolveGitHubUserById("1");

    expect(result).toEqual({ login: "octocat", id: 1, name: "The Octocat" });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/user/1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github.v3+json",
        }),
      }),
      10_000
    );
  });

  it("returns null when user not found (404)", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(404, { message: "Not Found" }));

    const result = await resolveGitHubUserById("999999999");

    expect(result).toBeNull();
  });

  it("returns null on server error (500)", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(500, { message: "Internal Server Error" }));

    const result = await resolveGitHubUserById("1");

    expect(result).toBeNull();
  });

  it("returns null on rate limit (403)", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(403, { message: "API rate limit exceeded" }));

    const result = await resolveGitHubUserById("1");

    expect(result).toBeNull();
  });

  it("passes Authorization header when token is provided", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, { login: "octocat", id: 1, name: null }));

    await resolveGitHubUserById("1", "ghp_test_token");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/user/1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_test_token",
        }),
      }),
      10_000
    );
  });

  it("does not include Authorization header when no token", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, { login: "octocat", id: 1, name: null }));

    await resolveGitHubUserById("1");

    const calledHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(calledHeaders).not.toHaveProperty("Authorization");
  });

  it("handles user with null name", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, { login: "ghost", id: 10137, name: null }));

    const result = await resolveGitHubUserById("10137");

    expect(result).toEqual({ login: "ghost", id: 10137, name: null });
  });
});

describe("resolveGitHubUserByEmail", () => {
  it("returns user when search finds exactly one result", async () => {
    // First call: search
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, {
        total_count: 1,
        items: [{ login: "octocat", id: 1 }],
      })
    );
    // Second call: profile fetch for name
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, { login: "octocat", id: 1, name: "The Octocat" })
    );

    const result = await resolveGitHubUserByEmail("octocat@github.com");

    expect(result).toEqual({ login: "octocat", id: 1, name: "The Octocat" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Verify search query
    expect(mockFetch.mock.calls[0][0]).toContain(
      "search/users?q=octocat%40github.com%20in%3Aemail"
    );
    // Verify profile fetch
    expect(mockFetch.mock.calls[1][0]).toBe("https://api.github.com/users/octocat");
  });

  it("returns null when no users found", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, { total_count: 0, items: [] }));

    const result = await resolveGitHubUserByEmail("nobody@example.com");

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns first result when multiple matches (best match)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, {
        total_count: 3,
        items: [
          { login: "best-match", id: 100 },
          { login: "other1", id: 101 },
          { login: "other2", id: 102 },
        ],
      })
    );
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, { login: "best-match", id: 100, name: "Best Match" })
    );

    const result = await resolveGitHubUserByEmail("shared@example.com");

    expect(result).toEqual({ login: "best-match", id: 100, name: "Best Match" });
  });

  it("returns null on search API error", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(403, { message: "API rate limit exceeded" }));

    const result = await resolveGitHubUserByEmail("octocat@github.com");

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to search data when profile fetch fails", async () => {
    // Search succeeds
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, {
        total_count: 1,
        items: [{ login: "octocat", id: 1 }],
      })
    );
    // Profile fetch fails
    mockFetch.mockResolvedValueOnce(mockResponse(500, { message: "Internal Server Error" }));

    const result = await resolveGitHubUserByEmail("octocat@github.com");

    expect(result).toEqual({ login: "octocat", id: 1, name: null });
  });

  it("passes Authorization header when token is provided", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, { total_count: 1, items: [{ login: "octocat", id: 1 }] })
    );
    mockFetch.mockResolvedValueOnce(mockResponse(200, { login: "octocat", id: 1, name: null }));

    await resolveGitHubUserByEmail("octocat@github.com", "ghp_test_token");

    // Both calls should have the token
    for (const call of mockFetch.mock.calls) {
      const headers = call[1].headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ghp_test_token");
    }
  });
});
