import { describe, expect, it } from "vitest";

import { inferControlPlaneUrlFromWebAppUrl, resolvePublicWorkerUrl } from "./public-worker-url";

describe("inferControlPlaneUrlFromWebAppUrl", () => {
  it("derives the control-plane origin from a Cloudflare web app URL", () => {
    expect(
      inferControlPlaneUrlFromWebAppUrl("https://open-inspect-web-axiom.axioshq.workers.dev")
    ).toBe("https://open-inspect-control-plane-axiom.axioshq.workers.dev");
  });

  it("returns null for non-Cloudflare web app URLs", () => {
    expect(inferControlPlaneUrlFromWebAppUrl("https://open-inspect-axiom.vercel.app")).toBeNull();
  });
});

describe("resolvePublicWorkerUrl", () => {
  it("prefers the inferred Cloudflare control-plane URL over WORKER_URL", () => {
    expect(
      resolvePublicWorkerUrl({
        WEB_APP_URL: "https://open-inspect-web-axiom.axioshq.workers.dev",
        WORKER_URL: "https://open-inspect-control-plane-axiom.workers.dev",
      })
    ).toBe("https://open-inspect-control-plane-axiom.axioshq.workers.dev");
  });

  it("falls back to WORKER_URL and normalizes the origin", () => {
    expect(
      resolvePublicWorkerUrl({
        WEB_APP_URL: "https://open-inspect-axiom.vercel.app",
        WORKER_URL: "https://open-inspect-control-plane-axiom.axioshq.workers.dev/internal/path",
      })
    ).toBe("https://open-inspect-control-plane-axiom.axioshq.workers.dev");
  });

  it("returns an empty string when neither URL is usable", () => {
    expect(
      resolvePublicWorkerUrl({
        WEB_APP_URL: "not-a-url",
        WORKER_URL: "still-not-a-url",
      })
    ).toBe("");
  });
});
