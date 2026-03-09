import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubTokenRefreshService } from "./github-token-refresh-service";
import type { Logger } from "../logger";

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger()),
  };
}

describe("GitHubTokenRefreshService", () => {
  const mockGetCachedInstallationToken = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a fresh token when GitHub App is configured", async () => {
    mockGetCachedInstallationToken.mockResolvedValue("ghs_fresh_token_123");

    const service = new GitHubTokenRefreshService(
      {
        appId: "12345",
        privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
        installationId: "67890",
      },
      undefined,
      createLogger()
    );

    const result = await service.refresh(mockGetCachedInstallationToken);

    expect(result).toEqual({ ok: true, token: "ghs_fresh_token_123" });
    expect(mockGetCachedInstallationToken).toHaveBeenCalledWith(
      {
        appId: "12345",
        privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
        installationId: "67890",
      },
      undefined,
      undefined
    );
  });

  it("returns error when GitHub App credentials are missing", async () => {
    const service = new GitHubTokenRefreshService(null, undefined, createLogger());
    const result = await service.refresh(mockGetCachedInstallationToken);

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "GitHub App not configured",
    });
    expect(mockGetCachedInstallationToken).not.toHaveBeenCalled();
  });

  it("returns error when token generation fails", async () => {
    mockGetCachedInstallationToken.mockRejectedValue(new Error("GitHub API down"));

    const service = new GitHubTokenRefreshService(
      {
        appId: "12345",
        privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
        installationId: "67890",
      },
      undefined,
      createLogger()
    );

    const result = await service.refresh(mockGetCachedInstallationToken);

    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "GitHub token refresh failed",
    });
  });
});
