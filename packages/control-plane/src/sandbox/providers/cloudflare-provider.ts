/**
 * Cloudflare Sandbox provider implementation.
 *
 * Wraps the Cloudflare Sandbox SDK binding to implement the SandboxProvider interface,
 * enabling sandboxed dev environments on Cloudflare's container runtime.
 */

import {
  SandboxProviderError,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type SnapshotConfig,
  type SnapshotResult,
} from "../provider";

// ==================== Cloudflare Sandbox SDK Types ====================

/** Serialized backup handle stored as the snapshot imageId. */
export interface DirectoryBackup {
  /** R2 key or opaque identifier for the squashfs backup */
  id: string;
  /** Directory that was backed up */
  dir: string;
  /** Backup name */
  name: string;
  /** TTL in seconds that was requested */
  ttlSeconds: number;
}

/** A running Cloudflare sandbox container instance. */
export interface CloudflareSandboxInstance {
  /** Unique container ID */
  id: string;
  /** Create a squashfs directory backup stored in R2. */
  createBackup(opts: {
    dir: string;
    name: string;
    ttl: number;
  }): Promise<DirectoryBackup>;
  /** Restore a previously created backup as a FUSE overlay mount. */
  restoreBackup(backup: DirectoryBackup): Promise<void>;
}

/** Cloudflare Sandbox SDK binding available via env. */
export interface CloudflareSandboxBinding {
  /** Create a new container. */
  create(opts: {
    image: string;
    env?: Record<string, string>;
  }): Promise<CloudflareSandboxInstance>;
  /** Get a handle to an existing container by ID. */
  get(id: string): CloudflareSandboxInstance;
  /** Destroy a running container. */
  destroy(id: string): Promise<void>;
}

// ==================== Constants ====================

/** Default container image for Cloudflare sandboxes. */
const DEFAULT_SANDBOX_IMAGE = "open-inspect/sandbox:latest";

/** Default backup TTL in seconds (3 days). */
const BACKUP_TTL_SECONDS = 259200;

/** Directory inside the container to back up / restore. */
const REPO_DIR = "/home/user/repo";

// ==================== Provider ====================

/**
 * Cloudflare Sandbox provider.
 *
 * Implements the SandboxProvider interface using the Cloudflare Sandbox SDK
 * binding. Containers run on Cloudflare's edge, with squashfs-based snapshots
 * stored in R2 and restored via FUSE overlay mounts.
 */
export class CloudflareSandboxProvider implements SandboxProvider {
  readonly name = "cloudflare";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: true,
    supportsRestore: true,
    supportsWarm: false,
  };

  constructor(private readonly binding: CloudflareSandboxBinding) {}

  /**
   * Create a new sandbox container via the Cloudflare Sandbox SDK.
   */
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
        ...(config.opencodeSessionId
          ? { OPENCODE_SESSION_ID: config.opencodeSessionId }
          : {}),
        ...(config.userEnvVars ?? {}),
      };

      const instance = await this.binding.create({
        image: DEFAULT_SANDBOX_IMAGE,
        env,
      });

      return {
        sandboxId: config.sandboxId,
        providerObjectId: instance.id,
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

  /**
   * Take a filesystem snapshot of the sandbox repo directory.
   *
   * Creates a squashfs backup of /home/user/repo stored in R2.
   * The serialized DirectoryBackup handle is returned as the imageId.
   */
  async takeSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      const instance = this.binding.get(config.providerObjectId);

      const backup = await instance.createBackup({
        dir: REPO_DIR,
        name: `snapshot-${config.sessionId}-${config.reason}`,
        ttl: BACKUP_TTL_SECONDS,
      });

      return {
        success: true,
        imageId: JSON.stringify(backup),
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) {
        throw error;
      }
      throw SandboxProviderError.fromFetchError("Failed to take snapshot", error);
    }
  }

  /**
   * Restore a sandbox from a previously taken snapshot.
   *
   * Creates a fresh container, then mounts the squashfs backup as a
   * read-only FUSE lower layer with copy-on-write upper.
   */
  async restoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    try {
      const backupHandle: DirectoryBackup = JSON.parse(config.snapshotImageId);

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
        ...(config.userEnvVars ?? {}),
      };

      const instance = await this.binding.create({
        image: DEFAULT_SANDBOX_IMAGE,
        env,
      });

      await instance.restoreBackup(backupHandle);

      return {
        success: true,
        sandboxId: config.sandboxId,
        providerObjectId: instance.id,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) {
        throw error;
      }

      // Check for invalid JSON parse errors (bad snapshot data)
      if (error instanceof SyntaxError) {
        throw new SandboxProviderError(
          `Invalid snapshot data: ${error.message}`,
          "permanent",
          error
        );
      }

      throw SandboxProviderError.fromFetchError(
        "Failed to restore sandbox from snapshot",
        error
      );
    }
  }
}

/**
 * Create a Cloudflare sandbox provider.
 *
 * @param binding - Cloudflare Sandbox SDK binding from env
 * @returns CloudflareSandboxProvider instance
 */
export function createCloudflareProvider(
  binding: CloudflareSandboxBinding
): CloudflareSandboxProvider {
  return new CloudflareSandboxProvider(binding);
}
