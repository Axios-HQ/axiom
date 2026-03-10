/**
 * Cloudflare Containers sandbox provider.
 *
 * Uses Cloudflare Containers (Durable Objects that wrap Docker containers)
 * for sandboxed dev environments. Each sandbox is a SandboxContainer DO
 * instance accessed via DurableObjectNamespace.
 */

import {
  SandboxProviderError,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type CreateSandboxConfig,
  type CreateSandboxResult,
} from "../provider";

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly name = "cloudflare";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false, // Phase 1: no snapshots (add later with R2)
    supportsRestore: false,
    supportsWarm: false,
  };

  constructor(private readonly namespace: DurableObjectNamespace) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const env: Record<string, string> = {
        SESSION_ID: config.sessionId,
        SANDBOX_ID: config.sandboxId,
        REPO_OWNER: config.repoOwner,
        REPO_NAME: config.repoName,
        CONTROL_PLANE_URL: config.controlPlaneUrl,
        SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
        LLM_PROVIDER: config.provider,
        LLM_MODEL: config.model,
        ...(config.branch ? { GIT_BRANCH: config.branch } : {}),
        ...(config.repoImageId ? { REPO_IMAGE_ID: config.repoImageId } : {}),
        ...(config.repoImageSha ? { REPO_IMAGE_SHA: config.repoImageSha } : {}),
        ...(config.opencodeSessionId ? { OPENCODE_SESSION_ID: config.opencodeSessionId } : {}),
        ...(config.userEnvVars ?? {}),
      };

      const id = this.namespace.idFromName(config.sandboxId);
      const stub = this.namespace.get(id);

      const res = await stub.fetch(
        new Request("http://container/_sandbox/configure", {
          method: "POST",
          body: JSON.stringify(env),
          headers: { "Content-Type": "application/json" },
        })
      );

      if (!res.ok) {
        const body = await res.text();
        throw new SandboxProviderError(
          `Failed to start container: ${res.status} ${body}`,
          "permanent"
        );
      }

      return {
        sandboxId: config.sandboxId,
        providerObjectId: id.toString(),
        status: "created",
        createdAt: Date.now(),
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) {
        throw error;
      }
      throw SandboxProviderError.fromFetchError("Failed to create sandbox", error);
    }
  }
}

/**
 * Create a Cloudflare sandbox provider.
 */
export function createCloudflareProvider(
  namespace: DurableObjectNamespace
): CloudflareSandboxProvider {
  return new CloudflareSandboxProvider(namespace);
}
