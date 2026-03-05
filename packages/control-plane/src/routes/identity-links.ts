import { IdentityLinksStore, type IdentityProvider } from "../db/identity-links";
import { runIdentityLinkSync } from "../identity-sync/service";
import { verifyInternalToken } from "../auth/internal";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

function isIdentityProvider(value: string): value is IdentityProvider {
  return value === "linear" || value === "slack";
}

async function handleListIdentityLinks(
  request: Request,
  env: { DB: D1Database },
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const githubUserId = url.searchParams.get("githubUserId");
  if (!githubUserId) {
    return error("githubUserId is required", 400);
  }

  const store = new IdentityLinksStore(env.DB);
  const links = await store.listByGithubUserId(githubUserId);
  return json({ links });
}

async function handleUpsertIdentityLink(
  request: Request,
  env: { DB: D1Database },
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const body = (await request.json()) as {
    provider?: string;
    externalUserId?: string;
    githubUserId?: string;
    githubLogin?: string;
    githubName?: string | null;
    createdBy?: string;
  };

  if (!body.provider || !isIdentityProvider(body.provider)) {
    return error("provider must be one of: linear, slack", 400);
  }
  if (!body.externalUserId || body.externalUserId.trim().length === 0) {
    return error("externalUserId is required", 400);
  }
  if (!body.githubUserId || body.githubUserId.trim().length === 0) {
    return error("githubUserId is required", 400);
  }
  if (!body.githubLogin || body.githubLogin.trim().length === 0) {
    return error("githubLogin is required", 400);
  }

  const store = new IdentityLinksStore(env.DB);
  await store.upsert({
    provider: body.provider,
    externalUserId: body.externalUserId.trim(),
    githubUserId: body.githubUserId.trim(),
    githubLogin: body.githubLogin.trim(),
    githubName: body.githubName ?? null,
    createdBy: body.createdBy?.trim() || `manual:github:${body.githubUserId.trim()}`,
    source: "manual_api",
    isManual: true,
  });

  return json({ status: "ok" });
}

async function handleSyncIdentityLinks(
  request: Request,
  env: {
    DB: D1Database;
    SLACK_BOT_TOKEN?: string;
    LINEAR_API_KEY?: string;
    INTERNAL_CALLBACK_SECRET?: string;
  },
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  // Defense-in-depth: verify bearer token even though the router already enforces HMAC auth.
  if (!env.INTERNAL_CALLBACK_SECRET) {
    return error("Internal authentication not configured", 500);
  }
  const isAuthorized = await verifyInternalToken(
    request.headers.get("Authorization"),
    env.INTERNAL_CALLBACK_SECRET
  );
  if (!isAuthorized) {
    return error("Unauthorized", 401);
  }

  const body = (await request.json().catch(() => ({}))) as {
    mode?: "dry-run" | "apply";
    domain?: string;
    overrideManual?: boolean;
  };

  const mode = body.mode === "dry-run" ? "dry-run" : "apply";
  const domain = body.domain?.trim() || "axioshq.com";

  if (!env.SLACK_BOT_TOKEN) {
    return error("SLACK_BOT_TOKEN is required for identity sync", 500);
  }
  if (!env.LINEAR_API_KEY) {
    return error("LINEAR_API_KEY is required for identity sync", 500);
  }

  const summary = await runIdentityLinkSync({
    db: env.DB,
    slackBotToken: env.SLACK_BOT_TOKEN,
    linearApiKey: env.LINEAR_API_KEY,
    domain,
    mode,
    overrideManual: Boolean(body.overrideManual),
  });

  return json({
    status: "ok",
    mode,
    domain,
    linked: summary.linked,
    skipped: summary.skipped,
    conflicted: summary.conflicted,
  });
}

async function handleDeleteIdentityLink(
  _request: Request,
  env: { DB: D1Database },
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const provider = match.groups?.provider;
  const externalUserId = match.groups?.externalUserId;
  if (!provider || !isIdentityProvider(provider)) {
    return error("provider must be one of: linear, slack", 400);
  }
  if (!externalUserId) {
    return error("externalUserId is required", 400);
  }

  const store = new IdentityLinksStore(env.DB);
  const deleted = await store.delete(provider, externalUserId);
  if (!deleted) {
    return error("Identity link not found", 404);
  }

  return json({ status: "deleted" });
}

export const identityLinksRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/identity-links"),
    handler: handleListIdentityLinks,
  },
  {
    method: "POST",
    pattern: parsePattern("/identity-links"),
    handler: handleUpsertIdentityLink,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/identity-links/:provider/:externalUserId"),
    handler: handleDeleteIdentityLink,
  },
  {
    method: "POST",
    pattern: parsePattern("/identity-links/sync"),
    handler: handleSyncIdentityLinks,
  },
];
