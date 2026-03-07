import { headers } from "next/headers";
import { auth } from "./auth";

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
export async function getGitHubAccessToken(requestHeaders?: Headers): Promise<string | undefined> {
  const hdrs = requestHeaders ?? (await headers());
  const session = await auth.api.getSession({ headers: hdrs });
  if (!session?.user?.id) return undefined;

  // In better-auth, the account access token is available via listUserAccounts
  // or we can query the account table directly via the auth API
  try {
    const accounts = await auth.api.listUserAccounts({
      headers: hdrs,
    });
    const githubAccount = accounts?.find(
      (account: { providerId: string }) => account.providerId === "github"
    );
    // Access token is stored on the account record
    return (githubAccount as Record<string, unknown> | undefined)?.accessToken as string | undefined;
  } catch {
    return undefined;
  }
}
