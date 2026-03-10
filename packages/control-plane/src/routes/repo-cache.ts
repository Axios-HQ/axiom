/**
 * Repo cache routes — R2-based tarball caching for fast sandbox cold starts.
 *
 * PUT  /sessions/:id/repo-cache?owner=X&name=Y — upload tarball after first clone
 * GET  /sessions/:id/repo-cache?owner=X&name=Y — download cached tarball
 * HEAD /sessions/:id/repo-cache?owner=X&name=Y — check if cache exists
 *
 * R2 key: repo-cache/{owner}/{name}.tar.gz (shared across sessions for same repo)
 */

import { createLogger } from "../logger";
import type { Env } from "../types";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

const logger = createLogger("router:repo-cache");

/** Max tarball size: 500 MB */
const MAX_TARBALL_SIZE = 500 * 1024 * 1024;

function r2Key(owner: string, name: string): string {
  return `repo-cache/${owner}/${name}.tar.gz`;
}

function parseRepoParams(request: Request): { owner: string; name: string } | null {
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const name = url.searchParams.get("name");
  if (!owner || !name) return null;
  // Basic validation — no path traversal
  if (owner.includes("/") || owner.includes("..") || name.includes("/") || name.includes("..")) {
    return null;
  }
  return { owner, name };
}

async function handleUpload(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.MEDIA_BUCKET) {
    return error("R2 storage not configured", 503);
  }

  const repo = parseRepoParams(request);
  if (!repo) {
    return error("Missing or invalid owner/name query params", 400);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_TARBALL_SIZE) {
    return error("Tarball too large (max 500 MB)", 413);
  }

  if (!request.body) {
    return error("Empty body", 400);
  }

  const key = r2Key(repo.owner, repo.name);

  await env.MEDIA_BUCKET.put(key, request.body, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: {
      uploadedAt: new Date().toISOString(),
      requestId: ctx.request_id,
    },
  });

  logger.info("repo_cache.uploaded", {
    event: "repo_cache.uploaded",
    key,
    owner: repo.owner,
    name: repo.name,
    size: contentLength ? parseInt(contentLength, 10) : "unknown",
    request_id: ctx.request_id,
  });

  return json({ key, status: "cached" }, 201);
}

async function handleDownload(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  if (!env.MEDIA_BUCKET) {
    return error("R2 storage not configured", 503);
  }

  const repo = parseRepoParams(request);
  if (!repo) {
    return error("Missing or invalid owner/name query params", 400);
  }

  const key = r2Key(repo.owner, repo.name);
  const object = await env.MEDIA_BUCKET.get(key);

  if (!object) {
    return error("No cached tarball found", 404);
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(object.size),
      "X-Cache-Uploaded-At": object.customMetadata?.uploadedAt ?? "unknown",
    },
  });
}

async function handleHead(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  if (!env.MEDIA_BUCKET) {
    return error("R2 storage not configured", 503);
  }

  const repo = parseRepoParams(request);
  if (!repo) {
    return error("Missing or invalid owner/name query params", 400);
  }

  const key = r2Key(repo.owner, repo.name);
  const head = await env.MEDIA_BUCKET.head(key);

  if (!head) {
    return new Response(null, { status: 404 });
  }

  return new Response(null, {
    status: 200,
    headers: {
      "Content-Length": String(head.size),
      "X-Cache-Uploaded-At": head.customMetadata?.uploadedAt ?? "unknown",
    },
  });
}

export const repoCacheRoutes: Route[] = [
  {
    method: "PUT",
    pattern: parsePattern("/sessions/:id/repo-cache"),
    handler: handleUpload,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/repo-cache"),
    handler: handleDownload,
  },
  {
    method: "HEAD",
    pattern: parsePattern("/sessions/:id/repo-cache"),
    handler: handleHead,
  },
];
