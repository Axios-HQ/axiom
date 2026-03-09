/**
 * Resolve GitHub users by numeric ID or email.
 *
 * These helpers are used during auto-linking to map external identities
 * (Linear gitHubUserId, Slack email) to a GitHub login.
 *
 * Note: Unauthenticated requests are rate-limited to 60/hr.
 * Pass an installation token to get 5 000/hr.
 */

import { fetchWithTimeout } from "../auth/github-app";
import { GITHUB_API_BASE, USER_AGENT } from "./providers/constants";
import { createLogger } from "../logger";

const logger = createLogger("github-user-resolver");

/** Minimal GitHub user info returned by the resolver. */
export interface ResolvedGitHubUser {
  login: string;
  id: number;
  name: string | null;
}

/** Timeout for user resolution requests (ms). */
const RESOLVE_TIMEOUT_MS = 10_000;

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": USER_AGENT,
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Resolve a GitHub user by numeric user ID.
 *
 * Uses `GET /user/:id` which returns the user's public profile.
 * Works unauthenticated but rate-limited to 60 req/hr.
 *
 * @param githubUserId - Numeric GitHub user ID (as string)
 * @param token - Optional GitHub token for higher rate limits
 * @returns Resolved user or null if not found / error
 */
export async function resolveGitHubUserById(
  githubUserId: string,
  token?: string
): Promise<ResolvedGitHubUser | null> {
  const url = `${GITHUB_API_BASE}/user/${encodeURIComponent(githubUserId)}`;

  const response = await fetchWithTimeout(url, { headers: authHeaders(token) }, RESOLVE_TIMEOUT_MS);

  if (response.status === 404) {
    logger.info("github_user.not_found_by_id", {
      github_user_id: githubUserId,
    });
    return null;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.warn("github_user.lookup_by_id_failed", {
      github_user_id: githubUserId,
      status: response.status,
      body: body.slice(0, 200),
    });
    return null;
  }

  const data = (await response.json()) as {
    login: string;
    id: number;
    name: string | null;
  };

  return {
    login: data.login,
    id: data.id,
    name: data.name,
  };
}

/**
 * Resolve a GitHub user by email address.
 *
 * Uses `GET /search/users?q=<email>+in:email` which searches
 * verified/public email addresses. Only returns a result if exactly
 * one user matches, to avoid ambiguity.
 *
 * @param email - Email address to search for
 * @param token - Optional GitHub token for higher rate limits
 * @returns Resolved user or null if not found / ambiguous / error
 */
export async function resolveGitHubUserByEmail(
  email: string,
  token?: string
): Promise<ResolvedGitHubUser | null> {
  const query = `${email} in:email`;
  const url = `${GITHUB_API_BASE}/search/users?q=${encodeURIComponent(query)}`;

  const response = await fetchWithTimeout(url, { headers: authHeaders(token) }, RESOLVE_TIMEOUT_MS);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.warn("github_user.search_by_email_failed", {
      email,
      status: response.status,
      body: body.slice(0, 200),
    });
    return null;
  }

  const data = (await response.json()) as {
    total_count: number;
    items: Array<{
      login: string;
      id: number;
      name?: string | null;
    }>;
  };

  if (data.total_count === 0 || data.items.length === 0) {
    logger.info("github_user.not_found_by_email", { email });
    return null;
  }

  if (data.total_count > 1) {
    logger.info("github_user.ambiguous_email", {
      email,
      count: data.total_count,
    });
    // Return the first result — GitHub search returns best match first
    // and for email lookups the first result is almost always correct.
  }

  const user = data.items[0];

  // The search endpoint doesn't return `name` — fetch the full profile
  // to get the display name for identity_links.
  const profileUrl = `${GITHUB_API_BASE}/users/${encodeURIComponent(user.login)}`;
  const profileResponse = await fetchWithTimeout(
    profileUrl,
    { headers: authHeaders(token) },
    RESOLVE_TIMEOUT_MS
  );

  if (profileResponse.ok) {
    const profile = (await profileResponse.json()) as {
      login: string;
      id: number;
      name: string | null;
    };
    return {
      login: profile.login,
      id: profile.id,
      name: profile.name,
    };
  }

  // Fall back to search result data (no name)
  return {
    login: user.login,
    id: user.id,
    name: null,
  };
}
