/**
 * Cloudflare Container class for sandboxed dev environments.
 *
 * Extends the Container base class from @cloudflare/containers to run
 * Docker-based sandbox environments. Each instance is a Durable Object
 * that manages a single container lifecycle.
 *
 * The control plane creates instances via DurableObjectNamespace, configures
 * them with dynamic env vars (session ID, tokens, repo info), and starts
 * the container. The container runs the sandbox supervisor which manages
 * the OpenCode agent and WebSocket bridge.
 */
import { Container } from "@cloudflare/containers";

/** Timeout for container boot (git clone + npm install can be slow on cold start). */
const STARTUP_TIMEOUT_MS = 120_000;

export class SandboxContainer extends Container {
  // Default port the sandbox bridge/supervisor listens on for health
  defaultPort = 8080;

  // Auto-sleep after 2h of inactivity (matches DEFAULT_SANDBOX_TIMEOUT_SECONDS)
  sleepAfter = "2h" as const;

  // Sandbox needs internet for GitHub API, LLM API, npm, etc.
  enableInternet = true;

  override async onStart(): Promise<void> {
    const storedEnv = await this.ctx.storage.get<Record<string, string>>("env");
    if (storedEnv) {
      await this.start({
        envVars: storedEnv,
        enableInternet: true,
      });
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Configure endpoint: control plane calls this before starting
    if (url.pathname === "/_sandbox/configure" && request.method === "POST") {
      const env = (await request.json()) as Record<string, string>;
      // Only persist env AFTER successful boot so onStart() won't retry broken configs.
      try {
        await this.startAndWaitForPorts({
          startOptions: { envVars: env, enableInternet: true },
          cancellationOptions: {
            instanceGetTimeoutMS: STARTUP_TIMEOUT_MS,
            portReadyTimeoutMS: STARTUP_TIMEOUT_MS,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[SandboxContainer] startAndWaitForPorts failed: ${message}`);
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      await this.ctx.storage.put("env", env);
      return new Response(JSON.stringify({ status: "started" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // State endpoint: check container state
    if (url.pathname === "/_sandbox/state") {
      const state = await this.getState();
      return new Response(JSON.stringify(state), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Stop endpoint: stop the container and clear stored env so onStart() won't restart
    if (url.pathname === "/_sandbox/stop" && request.method === "POST") {
      await this.ctx.storage.delete("env");
      await this.stop();
      return new Response(JSON.stringify({ status: "stopped" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // All other requests proxy to the container
    return super.fetch(request);
  }
}
