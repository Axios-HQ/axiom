/**
 * Sandbox provider factory.
 *
 * Selects and creates the appropriate SandboxProvider based on configuration.
 */

import type { SandboxProvider } from "../provider";
import type { ModalClient } from "../client";
import { ModalSandboxProvider } from "./modal-provider";
import { CloudflareSandboxProvider, type CloudflareSandboxBinding } from "./cloudflare-provider";

/** Supported provider names. */
export type SandboxProviderName = "modal" | "cloudflare";

/** Bindings that may be available for provider construction. */
export interface SandboxProviderBindings {
  /** Modal client for Modal provider */
  modalClient?: ModalClient;
  /** Cloudflare Sandbox SDK binding for Cloudflare provider */
  cloudflareSandboxBinding?: CloudflareSandboxBinding;
}

/**
 * Create a sandbox provider by name.
 *
 * @param providerName - Which provider to create ("modal" or "cloudflare"). Defaults to "modal".
 * @param bindings - Provider-specific bindings/clients
 * @returns A configured SandboxProvider instance
 * @throws Error if required bindings are missing for the selected provider
 */
export function createSandboxProvider(
  providerName: SandboxProviderName = "modal",
  bindings: SandboxProviderBindings
): SandboxProvider {
  switch (providerName) {
    case "cloudflare": {
      if (!bindings.cloudflareSandboxBinding) {
        throw new Error(
          "Cloudflare sandbox binding is required but not provided. " +
            "Ensure the SANDBOX binding is configured in wrangler."
        );
      }
      return new CloudflareSandboxProvider(bindings.cloudflareSandboxBinding);
    }

    case "modal": {
      if (!bindings.modalClient) {
        throw new Error(
          "Modal client is required but not provided. " +
            "Ensure MODAL_SHARED_SECRET and MODAL_WORKSPACE are configured."
        );
      }
      return new ModalSandboxProvider(bindings.modalClient);
    }

    default: {
      // Exhaustiveness check — if a new provider is added to the union
      // but not handled here, TypeScript will flag it at compile time.
      const _exhaustive: never = providerName;
      throw new Error(`Unknown sandbox provider: ${_exhaustive}`);
    }
  }
}
