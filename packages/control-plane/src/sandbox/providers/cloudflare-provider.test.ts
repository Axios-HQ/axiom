/**
 * Unit tests for CloudflareSandboxProvider.
 *
 * Tests sandbox creation and error classification using the DO namespace interface.
 */

import { describe, it, expect, vi } from "vitest";
import { CloudflareSandboxProvider } from "./cloudflare-provider";
import { SandboxProviderError } from "../provider";

// ==================== Mock Factories ====================

function createMockStub(
  overrides: Partial<{ fetch: (req: Request) => Promise<Response> }> = {}
): DurableObjectStub {
  return {
    fetch: vi.fn(async () => new Response(JSON.stringify({ status: "started" }), { status: 200 })),
    ...overrides,
  } as unknown as DurableObjectStub;
}

function createMockNamespace(stub: DurableObjectStub): DurableObjectNamespace {
  const doId = { toString: () => "do-id-123" } as DurableObjectId;
  return {
    idFromName: vi.fn(() => doId),
    get: vi.fn(() => stub),
    newUniqueId: vi.fn(),
    idFromString: vi.fn(),
    jurisdiction: vi.fn(),
  } as unknown as DurableObjectNamespace;
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

// ==================== Tests ====================

describe("CloudflareSandboxProvider", () => {
  describe("capabilities", () => {
    it("reports correct capabilities", () => {
      const stub = createMockStub();
      const namespace = createMockNamespace(stub);
      const provider = new CloudflareSandboxProvider(namespace);

      expect(provider.name).toBe("cloudflare");
      expect(provider.capabilities.supportsSnapshots).toBe(false);
      expect(provider.capabilities.supportsRestore).toBe(false);
      expect(provider.capabilities.supportsWarm).toBe(false);
    });
  });

  describe("createSandbox", () => {
    it("returns correct result on success", async () => {
      const stub = createMockStub();
      const namespace = createMockNamespace(stub);
      const provider = new CloudflareSandboxProvider(namespace);

      const result = await provider.createSandbox(testConfig);

      expect(result.sandboxId).toBe("sandbox-123");
      expect(result.providerObjectId).toBe("do-id-123");
      expect(result.status).toBe("created");
      expect(result.createdAt).toBeGreaterThan(0);
    });

    it("calls configure endpoint with correct env vars", async () => {
      const fetchFn = vi.fn(
        async () => new Response(JSON.stringify({ status: "started" }), { status: 200 })
      );
      const stub = createMockStub({ fetch: fetchFn });
      const namespace = createMockNamespace(stub);
      const provider = new CloudflareSandboxProvider(namespace);

      await provider.createSandbox({
        ...testConfig,
        branch: "feature-branch",
        userEnvVars: { API_KEY: "secret-key" },
        opencodeSessionId: "ocode-session-1",
      });

      expect(fetchFn).toHaveBeenCalledOnce();
      const calledRequest = (fetchFn.mock.calls as unknown[][])[0]?.[0] as Request | undefined;
      expect(calledRequest?.url).toContain("/_sandbox/configure");
      expect(calledRequest?.method).toBe("POST");

      const body = JSON.parse(await calledRequest!.text()) as Record<string, string>;
      expect(body).toMatchObject({
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
      const fetchFn = vi.fn(
        async () => new Response(JSON.stringify({ status: "started" }), { status: 200 })
      );
      const stub = createMockStub({ fetch: fetchFn });
      const namespace = createMockNamespace(stub);
      const provider = new CloudflareSandboxProvider(namespace);

      await provider.createSandbox(testConfig);

      const calledRequest = (fetchFn.mock.calls as unknown[][])[0]?.[0] as Request | undefined;
      const body = JSON.parse(await calledRequest!.text()) as Record<string, string>;
      expect(body).not.toHaveProperty("GIT_BRANCH");
      expect(body).not.toHaveProperty("REPO_IMAGE_ID");
      expect(body).not.toHaveProperty("REPO_IMAGE_SHA");
      expect(body).not.toHaveProperty("OPENCODE_SESSION_ID");
    });

    it("throws SandboxProviderError on non-ok response", async () => {
      const stub = createMockStub({
        fetch: vi.fn(async () => new Response("Internal Error", { status: 500 })),
      });
      const namespace = createMockNamespace(stub);
      const provider = new CloudflareSandboxProvider(namespace);

      await expect(provider.createSandbox(testConfig)).rejects.toThrow(SandboxProviderError);
    });

    it("classifies network errors as transient", async () => {
      const stub = createMockStub({
        fetch: vi.fn(async () => {
          throw new Error("fetch failed");
        }),
      });
      const namespace = createMockNamespace(stub);
      const provider = new CloudflareSandboxProvider(namespace);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });

    it("classifies unknown errors as permanent", async () => {
      const stub = createMockStub({
        fetch: vi.fn(async () => {
          throw new Error("Invalid configuration");
        }),
      });
      const namespace = createMockNamespace(stub);
      const provider = new CloudflareSandboxProvider(namespace);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
      }
    });

    it("re-throws SandboxProviderError without wrapping", async () => {
      const original = new SandboxProviderError("Already wrapped", "transient");
      const stub = createMockStub({
        fetch: vi.fn(async () => {
          throw original;
        }),
      });
      const namespace = createMockNamespace(stub);
      const provider = new CloudflareSandboxProvider(namespace);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBe(original);
      }
    });
  });

  describe("error classification", () => {
    it("classifies timeout errors as transient", async () => {
      const stub = createMockStub({
        fetch: vi.fn(async () => {
          throw new Error("Request timeout after 30000ms");
        }),
      });
      const namespace = createMockNamespace(stub);
      const provider = new CloudflareSandboxProvider(namespace);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });

    it("classifies ECONNRESET as transient", async () => {
      const stub = createMockStub({
        fetch: vi.fn(async () => {
          throw new Error("read ECONNRESET");
        }),
      });
      const namespace = createMockNamespace(stub);
      const provider = new CloudflareSandboxProvider(namespace);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });

    it("handles non-Error objects", async () => {
      const stub = createMockStub({
        fetch: vi.fn(async () => {
          throw "string error";
        }),
      });
      const namespace = createMockNamespace(stub);
      const provider = new CloudflareSandboxProvider(namespace);

      try {
        await provider.createSandbox(testConfig);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
      }
    });
  });
});
