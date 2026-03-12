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

  constructor(
    private readonly namespace: DurableObjectNamespace,
    private readonly llmApiKeys: Record<string, string> = {}
  ) {}

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
        // Worker-level LLM keys (equivalent to Modal's llm-api-keys secret).
        // Placed before userEnvVars so user/repo secrets can override.
        ...this.llmApiKeys,
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
        const isRetryable = res.status >= 500 || res.status === 429;
        throw new SandboxProviderError(
          `Failed to start container: ${res.status} ${body}`,
          isRetryable ? "transient" : "permanent"
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
/**
 * Create a Cloudflare sandbox provider.
 * Extracts LLM API keys from worker env vars to inject into containers
 * (equivalent to Modal's llm-api-keys secret).
 */
export function createCloudflareProvider(
  namespace: DurableObjectNamespace,
  workerEnv?: { ANTHROPIC_API_KEY?: string; OPENAI_API_KEY?: string }
): CloudflareSandboxProvider {
  const llmApiKeys: Record<string, string> = {};
  if (workerEnv?.ANTHROPIC_API_KEY) {
    llmApiKeys.ANTHROPIC_API_KEY = workerEnv.ANTHROPIC_API_KEY;
  }
  if (workerEnv?.OPENAI_API_KEY) {
    llmApiKeys.OPENAI_API_KEY = workerEnv.OPENAI_API_KEY;
  }
  return new CloudflareSandboxProvider(namespace, llmApiKeys);
}
