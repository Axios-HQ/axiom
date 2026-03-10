import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "./auth";

const GITHUB_LOGIN_TIMEOUT_MS = 5000;

type SessionWithUserId =
  | {
      user?: {
        id?: string | null;
      } | null;
    }
  | null
  | undefined;

/**
 * Get the current session in a server-side context (API routes, server components).
 * Replaces `getServerSession(authOptions)` from NextAuth.
 *
 * @param requestHeaders - Optional headers from the request. If not provided,
 *   uses `headers()` from next/headers (works in server components and route handlers).
 */
export async function getSession(requestHeaders?: Headers) {
  const hdrs = requestHeaders ?? (await headers());
  const session = await auth.api.getSession({
    headers: hdrs,
  });
  return session;
}

/**
 * Get the GitHub access token for the current user from their linked account.
 * Replaces `getToken({ req })?.accessToken` from NextAuth.
 */
export async function getGitHubAccessToken(
  requestHeaders?: Headers,
  session?: SessionWithUserId
): Promise<string | undefined> {
  const hdrs = requestHeaders ?? (await headers());
  const resolvedSession = session ?? (await getSession(hdrs));
  if (!resolvedSession?.user?.id) return undefined;

  // In better-auth, the account access token is available via listUserAccounts
  // or we can query the account table directly via the auth API
  try {
    const accounts = await auth.api.listUserAccounts({
      headers: hdrs,
    });
    const githubAccount = accounts?.find((account) => account.providerId === "github");
    if (!githubAccount || !("accessToken" in githubAccount)) {
      return undefined;
    }
    return typeof githubAccount.accessToken === "string" ? githubAccount.accessToken : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get the GitHub username (login) for the current user.
 *
 * better-auth stores `profile.name || profile.login` as the user's `name`,
 * so the GitHub username is not directly available on the session. This
 * helper calls the GitHub API with the stored access token to retrieve it.
 *
 * Returns `undefined` when the token is missing or the API call fails.
 */
export async function getGitHubLogin(
  requestHeaders?: Headers,
  session?: SessionWithUserId
): Promise<string | undefined> {
  const accessToken = await getGitHubAccessToken(requestHeaders, session);
  if (!accessToken) return undefined;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GITHUB_LOGIN_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "open-inspect",
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const profile = (await res.json()) as { login?: string };
    return profile.login;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Require the user to have a specific organization role.
 * Returns the session if authorized, or a 403 NextResponse if not.
 */
export async function requireRole(
  role: "admin" | "developer",
  requestHeaders?: Headers
): Promise<
  | { authorized: true; session: NonNullable<Awaited<ReturnType<typeof getSession>>> }
  | { authorized: false; response: NextResponse }
> {
  const hdrs = requestHeaders ?? (await headers());
  const session = await getSession(hdrs);
  if (!session?.user) {
    return {
      authorized: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  // If no role restriction needed (developer can do everything a developer can)
  // admin role gates admin-only operations
  if (role === "developer") {
    return { authorized: true, session };
  }

  // For admin role, check active organization membership
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orgSession = await (auth.api as any).getFullOrganization({
      headers: hdrs,
    });
    const member = orgSession?.members?.find(
      (m: { userId: string }) => m.userId === session.user.id
    );
    if (member?.role === "admin" || member?.role === "owner") {
      return { authorized: true, session };
    }
  } catch {
    // No active org or API error — deny admin access
  }

  return {
    authorized: false,
    response: NextResponse.json({ error: "Admin access required" }, { status: 403 }),
  };
}
