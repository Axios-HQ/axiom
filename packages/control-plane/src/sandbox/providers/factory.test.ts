/**
 * Unit tests for sandbox provider factory.
 */

import { describe, it, expect, vi } from "vitest";
import { createSandboxProvider } from "./factory";
import { ModalSandboxProvider } from "./modal-provider";
import { CloudflareSandboxProvider } from "./cloudflare-provider";
import type { ModalClient } from "../client";
import type { CloudflareSandboxBinding } from "./cloudflare-provider";

// ==================== Mock Factories ====================

function createMockModalClient(): ModalClient {
  return {
    createSandbox: vi.fn(),
    restoreSandbox: vi.fn(),
    snapshotSandbox: vi.fn(),
  } as unknown as ModalClient;
}

function createMockCloudflareBinding(): CloudflareSandboxBinding {
  return {
    create: vi.fn(),
    get: vi.fn(),
    destroy: vi.fn(),
  };
}

// ==================== Tests ====================

describe("createSandboxProvider", () => {
  describe("modal provider", () => {
    it("creates ModalSandboxProvider when providerName is 'modal'", () => {
      const client = createMockModalClient();
      const provider = createSandboxProvider("modal", { modalClient: client });

      expect(provider).toBeInstanceOf(ModalSandboxProvider);
      expect(provider.name).toBe("modal");
    });

    it("defaults to modal when no providerName is given", () => {
      const client = createMockModalClient();
      const provider = createSandboxProvider(undefined as never, {
        modalClient: client,
      });

      expect(provider).toBeInstanceOf(ModalSandboxProvider);
    });

    it("throws if modal client is not provided", () => {
      expect(() => createSandboxProvider("modal", {})).toThrow("Modal client is required");
    });
  });

  describe("cloudflare provider", () => {
    it("creates CloudflareSandboxProvider when providerName is 'cloudflare'", () => {
      const binding = createMockCloudflareBinding();
      const provider = createSandboxProvider("cloudflare", {
        cloudflareSandboxBinding: binding,
      });

      expect(provider).toBeInstanceOf(CloudflareSandboxProvider);
      expect(provider.name).toBe("cloudflare");
    });

    it("throws if cloudflare binding is not provided", () => {
      expect(() => createSandboxProvider("cloudflare", {})).toThrow(
        "Cloudflare sandbox binding is required"
      );
    });

    it("reports correct capabilities for cloudflare", () => {
      const binding = createMockCloudflareBinding();
      const provider = createSandboxProvider("cloudflare", {
        cloudflareSandboxBinding: binding,
      });

      expect(provider.capabilities.supportsSnapshots).toBe(true);
      expect(provider.capabilities.supportsRestore).toBe(true);
      expect(provider.capabilities.supportsWarm).toBe(false);
    });
  });

  describe("unknown provider", () => {
    it("throws for unknown provider name", () => {
      expect(() => createSandboxProvider("unknown" as never, {})).toThrow(
        "Unknown sandbox provider"
      );
    });
  });
});
