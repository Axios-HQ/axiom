/**
 * Unit tests for CloudflareSandboxProvider.
 *
 * Tests sandbox creation, snapshot, restore, and error classification.
 */

import { describe, it, expect, vi } from "vitest";
import { CloudflareSandboxProvider } from "./cloudflare-provider";
import { SandboxProviderError } from "../provider";
import type {
  CloudflareSandboxBinding,
  CloudflareSandboxInstance,
  DirectoryBackup,
} from "./cloudflare-provider";

// ==================== Mock Factories ====================

function createMockInstance(
  overrides: Partial<CloudflareSandboxInstance> = {}
): CloudflareSandboxInstance {
  return {
    id: "cf-container-123",
    createBackup: vi.fn(async () => ({
      id: "backup-abc",
      dir: "/home/user/repo",
      name: "snapshot-session-123-test",
      ttlSeconds: 259200,
    })),
    restoreBackup: vi.fn(async () => {}),
    ...overrides,
  };
}

function createMockBinding(
  overrides: Partial<{
    create: CloudflareSandboxBinding["create"];
    get: CloudflareSandboxBinding["get"];
    destroy: CloudflareSandboxBinding["destroy"];
  }> = {}
): CloudflareSandboxBinding {
  const instance = createMockInstance();
  return {
    create: vi.fn(async () => instance),
    get: vi.fn(() => instance),
    destroy: vi.fn(async () => {}),
    ...overrides,
  };
}

const testConfig = {
  sessionId: "test-session",
  sandboxId: "sandbox-123",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "auth-token",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

const testRestoreConfig = {
  snapshotImageId: JSON.stringify({
    id: "backup-abc",
    dir: "/home/user/repo",
    name: "snapshot-session-123-test",
    ttlSeconds: 259200,
  } satisfies DirectoryBackup),
  sessionId: "test-session",
  sandboxId: "sandbox-456",
  sandboxAuthToken: "auth-token",
  controlPlaneUrl: "https://control-plane.test",
  repoOwner: "testowner",
  repoName: "testrepo",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

// ==================== Tests ====================

describe("CloudflareSandboxProvider", () => {
  describe("capabilities", () => {
    it("reports correct capabilities", () => {
      const binding = createMockBinding();
      const provider = new CloudflareSandboxProvider(binding);

      expect(provider.name).toBe("cloudflare");
      expect(provider.capabilities.supportsSnapshots).toBe(true);
      expect(provider.capabilities.supportsRestore).toBe(true);
      expect(provider.capabilities.supportsWarm).toBe(false);
    });
  });

  describe("createSandbox", () => {
    it("returns correct result on success", async () => {
      const instance = createMockInstance({ id: "cf-container-xyz" });
      const binding = createMockBinding({
        create: vi.fn(async () => instance),
      });
      const provider = new CloudflareSandboxProvider(binding);

      const result = await provider.createSandbox(testConfig);

      expect(result.sandboxId).toBe("sandbox-123");
      expect(result.providerObjectId).toBe("cf-container-xyz");
      expect(result.status).toBe("created");
      expect(result.createdAt).toBeGreaterThan(0);
    });

    it("passes environment variables to binding.create", async () => {
      const createFn = vi.fn(async () => createMockInstance());
      const binding = createMockBinding({ create: createFn });
      const provider = new CloudflareSandboxProvider(binding);

      await provider.createSandbox({
        ...testConfig,
        branch: "feature-branch",
        userEnvVars: { API_KEY: "secret-key" },
        opencodeSessionId: "ocode-session-1",
      });

      expect(createFn).toHaveBeenCalledOnce();
      const callArgs = createFn.mock.calls[0][0];
      expect(callArgs.env).toMatchObject({
        SESSION_ID: "test-session",
        SANDBOX_ID: "sandbox-123",
        REPO_OWNER: "testowner",
        REPO_NAME: "testrepo",
        CONTROL_PLANE_URL: "https://control-plane.test",
        SANDBOX_AUTH_TOKEN: "auth-token",
        LLM_PROVIDER: "anthropic",
        LLM_MODEL: "anthropic/claude-sonnet-4-5",
        GIT_BRANCH: "feature-branch",
        OPENCODE_SESSION_ID: "ocode-session-1",
        API_KEY: "secret-key",
      });
    });

    it("omits optional env vars when not provided", async () => {
      const createFn = vi.fn(async () => createMockInstance());
      const binding = createMockBinding({ create: createFn });
      const provider = new CloudflareSandboxProvider(binding);

      await provider.createSandbox(testConfig);

      const callArgs = createFn.mock.calls[0][0];
      expect(callArgs.env).not.toHaveProperty("GIT_BRANCH");
      expect(callArgs.env).not.toHaveProperty("REPO_IMAGE_ID");
      expect(callArgs.env).not.toHaveProperty("REPO_IMAGE_SHA");
      expect(callArgs.env).not.toHaveProperty("OPENCODE_SESSION_ID");
    });

    it("throws SandboxProviderError on failure", async () => {
      const binding = createMockBinding({
        create: vi.fn(async () => {
          throw new Error("Container creation failed");
        }),
      });
      const provider = new CloudflareSandboxProvider(binding);

      await expect(provider.createSandbox(testConfig)).rejects.toThrow(SandboxProviderError);
    });

    it("classifies network errors as transient", async () => {
      const binding = createMockBinding({
        create: vi.fn(async () => {
          throw new Error("fetch failed");
        }),
      });
      const provider = new CloudflareSandboxProvider(binding);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });

    it("classifies unknown errors as permanent", async () => {
      const binding = createMockBinding({
        create: vi.fn(async () => {
          throw new Error("Invalid configuration");
        }),
      });
      const provider = new CloudflareSandboxProvider(binding);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
      }
    });

    it("re-throws SandboxProviderError without wrapping", async () => {
      const original = new SandboxProviderError("Already wrapped", "transient");
      const binding = createMockBinding({
        create: vi.fn(async () => {
          throw original;
        }),
      });
      const provider = new CloudflareSandboxProvider(binding);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBe(original);
      }
    });
  });

  describe("takeSnapshot", () => {
    it("returns serialized backup handle as imageId", async () => {
      const backup: DirectoryBackup = {
        id: "backup-xyz",
        dir: "/home/user/repo",
        name: "snapshot-session-1-inactivity",
        ttlSeconds: 259200,
      };
      const instance = createMockInstance({
        createBackup: vi.fn(async () => backup),
      });
      const binding = createMockBinding({
        get: vi.fn(() => instance),
      });
      const provider = new CloudflareSandboxProvider(binding);

      const result = await provider.takeSnapshot({
        providerObjectId: "cf-container-123",
        sessionId: "session-1",
        reason: "inactivity",
      });

      expect(result.success).toBe(true);
      expect(result.imageId).toBe(JSON.stringify(backup));

      // Verify the serialized imageId can be parsed back
      const parsed = JSON.parse(result.imageId!);
      expect(parsed.id).toBe("backup-xyz");
      expect(parsed.dir).toBe("/home/user/repo");
    });

    it("calls createBackup with correct parameters", async () => {
      const createBackupFn = vi.fn(async () => ({
        id: "backup-1",
        dir: "/home/user/repo",
        name: "snapshot-sess-test",
        ttlSeconds: 259200,
      }));
      const instance = createMockInstance({ createBackup: createBackupFn });
      const binding = createMockBinding({
        get: vi.fn(() => instance),
      });
      const provider = new CloudflareSandboxProvider(binding);

      await provider.takeSnapshot({
        providerObjectId: "cf-obj-1",
        sessionId: "sess",
        reason: "execution_complete",
      });

      expect(createBackupFn).toHaveBeenCalledWith({
        dir: "/home/user/repo",
        name: "snapshot-sess-execution_complete",
        ttl: 259200,
      });
    });

    it("uses binding.get to retrieve the instance", async () => {
      const getFn = vi.fn(() => createMockInstance());
      const binding = createMockBinding({ get: getFn });
      const provider = new CloudflareSandboxProvider(binding);

      await provider.takeSnapshot({
        providerObjectId: "cf-obj-abc",
        sessionId: "session-1",
        reason: "test",
      });

      expect(getFn).toHaveBeenCalledWith("cf-obj-abc");
    });

    it("throws SandboxProviderError on failure", async () => {
      const instance = createMockInstance({
        createBackup: vi.fn(async () => {
          throw new Error("Backup storage full");
        }),
      });
      const binding = createMockBinding({
        get: vi.fn(() => instance),
      });
      const provider = new CloudflareSandboxProvider(binding);

      await expect(
        provider.takeSnapshot({
          providerObjectId: "cf-obj-1",
          sessionId: "session-1",
          reason: "test",
        })
      ).rejects.toThrow(SandboxProviderError);
    });
  });

  describe("restoreFromSnapshot", () => {
    it("creates a new container and restores backup", async () => {
      const restoreBackupFn = vi.fn(async () => {});
      const instance = createMockInstance({
        id: "cf-restored-456",
        restoreBackup: restoreBackupFn,
      });
      const createFn = vi.fn(async () => instance);
      const binding = createMockBinding({ create: createFn });
      const provider = new CloudflareSandboxProvider(binding);

      const result = await provider.restoreFromSnapshot(testRestoreConfig);

      expect(result.success).toBe(true);
      expect(result.sandboxId).toBe("sandbox-456");
      expect(result.providerObjectId).toBe("cf-restored-456");
      expect(createFn).toHaveBeenCalledOnce();
      expect(restoreBackupFn).toHaveBeenCalledOnce();
    });

    it("passes parsed backup handle to restoreBackup", async () => {
      const restoreBackupFn = vi.fn(async () => {});
      const instance = createMockInstance({ restoreBackup: restoreBackupFn });
      const binding = createMockBinding({
        create: vi.fn(async () => instance),
      });
      const provider = new CloudflareSandboxProvider(binding);

      await provider.restoreFromSnapshot(testRestoreConfig);

      const passedBackup = restoreBackupFn.mock.calls[0][0];
      expect(passedBackup.id).toBe("backup-abc");
      expect(passedBackup.dir).toBe("/home/user/repo");
      expect(passedBackup.name).toBe("snapshot-session-123-test");
      expect(passedBackup.ttlSeconds).toBe(259200);
    });

    it("classifies invalid snapshot JSON as permanent error", async () => {
      const binding = createMockBinding();
      const provider = new CloudflareSandboxProvider(binding);

      try {
        await provider.restoreFromSnapshot({
          ...testRestoreConfig,
          snapshotImageId: "not-valid-json",
        });
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
        expect((e as SandboxProviderError).message).toContain("Invalid snapshot data");
      }
    });

    it("classifies container creation failure as appropriate error type", async () => {
      const binding = createMockBinding({
        create: vi.fn(async () => {
          throw new Error("fetch failed");
        }),
      });
      const provider = new CloudflareSandboxProvider(binding);

      try {
        await provider.restoreFromSnapshot(testRestoreConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });

    it("classifies restoreBackup failure correctly", async () => {
      const instance = createMockInstance({
        restoreBackup: vi.fn(async () => {
          throw new Error("FUSE mount failed");
        }),
      });
      const binding = createMockBinding({
        create: vi.fn(async () => instance),
      });
      const provider = new CloudflareSandboxProvider(binding);

      try {
        await provider.restoreFromSnapshot(testRestoreConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
      }
    });

    it("passes environment variables when restoring", async () => {
      const createFn = vi.fn(async () => createMockInstance());
      const binding = createMockBinding({ create: createFn });
      const provider = new CloudflareSandboxProvider(binding);

      await provider.restoreFromSnapshot({
        ...testRestoreConfig,
        branch: "fix-branch",
        userEnvVars: { SECRET: "value" },
      });

      const callArgs = createFn.mock.calls[0][0];
      expect(callArgs.env).toMatchObject({
        SESSION_ID: "test-session",
        SANDBOX_ID: "sandbox-456",
        GIT_BRANCH: "fix-branch",
        SECRET: "value",
      });
    });
  });

  describe("error classification", () => {
    it("classifies timeout errors as transient", async () => {
      const binding = createMockBinding({
        create: vi.fn(async () => {
          throw new Error("Request timeout after 30000ms");
        }),
      });
      const provider = new CloudflareSandboxProvider(binding);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });

    it("classifies ECONNRESET as transient", async () => {
      const binding = createMockBinding({
        create: vi.fn(async () => {
          throw new Error("read ECONNRESET");
        }),
      });
      const provider = new CloudflareSandboxProvider(binding);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });

    it("handles non-Error objects", async () => {
      const binding = createMockBinding({
        create: vi.fn(async () => {
          throw "string error";
        }),
      });
      const provider = new CloudflareSandboxProvider(binding);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
      }
    });
  });
});
