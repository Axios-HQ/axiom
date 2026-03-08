import { test as setup } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const AUTH_FILE = path.join(__dirname, ".auth", "user.json");

/**
 * Auth setup that creates a mock storageState file with a next-auth session cookie.
 *
 * TODO: Replace this with a real authentication flow once a test GitHub OAuth app
 * is configured. Options:
 *   1. Use a programmatic login endpoint (e.g. /api/auth/callback/credentials) with
 *      a test-only credentials provider.
 *   2. Use Playwright's browser context to complete the GitHub OAuth flow against a
 *      test account, then save the resulting storageState.
 *   3. Seed the NextAuth session database/JWT directly and inject the cookie.
 */
setup("create authenticated session", async ({ browser }) => {
  const authDir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  // TODO: This mock cookie will not work against a real Next.js server that
  // validates sessions server-side. For now, tests using this storageState
  // should mock API responses via page.route() to avoid hitting real auth.
  const storageState = {
    cookies: [
      {
        name: "next-auth.session-token",
        value: "mock-e2e-session-token",
        domain: "localhost",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
        expires: Math.floor(Date.now() / 1000) + 86400,
      },
    ],
    origins: [
      {
        origin: "http://localhost:3000",
        localStorage: [],
      },
    ],
  };

  fs.writeFileSync(AUTH_FILE, JSON.stringify(storageState, null, 2));
});
