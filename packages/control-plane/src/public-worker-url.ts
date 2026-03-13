import type { Env } from "./types";

const WEB_APP_HOST_PREFIX = "open-inspect-web-";
const CONTROL_PLANE_HOST_PREFIX = "open-inspect-control-plane-";

function normalizeOrigin(rawUrl?: string): string | null {
  if (!rawUrl) return null;

  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

export function inferControlPlaneUrlFromWebAppUrl(webAppUrl?: string): string | null {
  const origin = normalizeOrigin(webAppUrl);
  if (!origin) return null;

  const url = new URL(origin);
  if (!url.hostname.startsWith(WEB_APP_HOST_PREFIX) || !url.hostname.endsWith(".workers.dev")) {
    return null;
  }

  url.hostname = `${CONTROL_PLANE_HOST_PREFIX}${url.hostname.slice(WEB_APP_HOST_PREFIX.length)}`;
  return url.origin;
}

export function resolvePublicWorkerUrl(env: Pick<Env, "WEB_APP_URL" | "WORKER_URL">): string {
  return (
    inferControlPlaneUrlFromWebAppUrl(env.WEB_APP_URL) ?? normalizeOrigin(env.WORKER_URL) ?? ""
  );
}
