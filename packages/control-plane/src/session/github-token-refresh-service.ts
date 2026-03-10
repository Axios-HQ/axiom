import type { GitHubAppConfig, InstallationTokenCacheBindings } from "../auth/github-app";
import type { Logger } from "../logger";

export type GitHubTokenRefreshResult =
  | { ok: true; token: string }
  | { ok: false; status: number; error: string };

/**
 * Refreshes GitHub App installation tokens for sandbox use.
 * Called when git operations need fresh credentials (tokens expire after 1 hour).
 */
export class GitHubTokenRefreshService {
  constructor(
    private readonly config: GitHubAppConfig | null,
    private readonly cacheEnv: InstallationTokenCacheBindings | undefined,
    private readonly log: Logger
  ) {}

  async refresh(
    getCachedInstallationToken: (
      config: GitHubAppConfig,
      env?: InstallationTokenCacheBindings,
      options?: { forceRefresh?: boolean }
    ) => Promise<string>
  ): Promise<GitHubTokenRefreshResult> {
    if (!this.config) {
      return { ok: false, status: 404, error: "GitHub App not configured" };
    }

    try {
      const token = await getCachedInstallationToken(this.config, this.cacheEnv, undefined);

      this.log.info("GitHub token refreshed");
      return { ok: true, token };
    } catch (e) {
      this.log.error("GitHub token refresh failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, status: 502, error: "GitHub token refresh failed" };
    }
  }
}
