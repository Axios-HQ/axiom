/**
 * agent-login — provision a better-auth session cookie for agent-browser.
 *
 * Open-Inspect uses better-auth with database-backed sessions. This script
 * creates a session by calling the sign-in endpoint on the running dev server,
 * then injects the resulting session cookie into a persistent agent-browser
 * session.
 *
 * The script signs in by POSTing to the running server's internal sign-in
 * endpoint. If the server is not running, it will fail.
 *
 * Usage:
 *   pnpm --filter @open-inspect/web agent:login -- [options]
 *
 * Requires:
 *   - A running dev server at the base URL
 *   - agent-browser CLI on PATH
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PORT_REGEX = /^[0-9]{2,5}$/;
const SESSION_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * better-auth uses cookie names with a `better-auth` prefix.
 * HTTPS → `__Secure-better-auth.session_token`
 * HTTP  → `better-auth.session_token`
 */
function sessionCookieName(secure: boolean): string {
  return secure ? "__Secure-better-auth.session_token" : "better-auth.session_token";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CliOptions = {
  agentArgs: string[];
  allowNonLocal: boolean;
  baseUrl: string;
  headed: boolean;
  open: boolean;
  openArgs: string[];
  outputJson: boolean;
  redirect: string | null;
  sessionName: string;
  // User fields
  githubUserId: string;
  githubLogin: string;
  userName: string;
  userEmail: string;
  userImage: string | null;
  accessToken: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultBaseUrl(): string {
  const repoRoot = resolve(__dirname, "..", "..", "..");
  const portFile = resolve(repoRoot, ".worktree-port");

  if (existsSync(portFile)) {
    const port = readFileSync(portFile, "utf-8").trim();
    if (PORT_REGEX.test(port)) {
      return `http://localhost:${port}`;
    }
  }

  return "http://localhost:3000";
}

function usage(): string {
  return [
    "Usage: pnpm --filter @open-inspect/web agent:login -- [options]",
    "",
    "Provision a better-auth session cookie for agent-browser so automated",
    "browser sessions can access the Open-Inspect web UI.",
    "",
    "Options:",
    "  --base-url <url>          App base URL (default: .worktree-port or http://localhost:3000)",
    "  --session <name>          agent-browser session name (default: open-inspect-auth)",
    "  --github-user-id <id>     GitHub numeric user ID (default: 0)",
    "  --github-login <login>    GitHub username (default: agent-browser)",
    "  --name <name>             Display name (default: Agent Browser)",
    "  --email <email>           User email (default: agent-browser@local.test)",
    "  --image <url>             Avatar URL (default: none)",
    "  --access-token <token>    GitHub access token (default: none)",
    "  --redirect <path>         Redirect path after login (default: /)",
    "  --headed                  Open browser in headed mode",
    "  --agent-arg <flag>        Extra arg forwarded to all agent-browser calls (repeatable)",
    "  --open-arg <flag>         Extra arg forwarded to agent-browser open (repeatable)",
    "  --no-open                 Set cookie only; do not open the page",
    "  --allow-non-local         Allow non-local base URLs",
    "  --json                    Print machine-readable JSON output",
    "  -h, --help                Show this help text",
    "",
    "Environment:",
    "  AUTH_DATABASE_URL          Required. Path to the better-auth SQLite database.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseCliArgs(args: string[]): CliOptions {
  const sanitizedArgs = args.filter((arg) => arg !== "--");
  const parsed = parseArgs({
    args: sanitizedArgs,
    allowPositionals: true,
    allowNegative: true,
    strict: false,
    options: {
      "access-token": { type: "string" },
      "agent-arg": { type: "string", multiple: true },
      "allow-non-local": { type: "boolean" },
      "base-url": { type: "string" },
      email: { type: "string" },
      "github-login": { type: "string" },
      "github-user-id": { type: "string" },
      headed: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      image: { type: "string" },
      json: { type: "boolean" },
      name: { type: "string" },
      open: { type: "boolean" },
      "open-arg": { type: "string", multiple: true },
      redirect: { type: "string" },
      session: { type: "string" },
    },
  });

  if (parsed.values.help) {
    console.log(usage());
    process.exit(0);
  }

  if (parsed.positionals.length > 0) {
    throw new Error(`Unknown argument: ${parsed.positionals[0]}`);
  }

  const allowedKeys = new Set([
    "access-token",
    "agent-arg",
    "allow-non-local",
    "base-url",
    "email",
    "github-login",
    "github-user-id",
    "headed",
    "help",
    "image",
    "json",
    "name",
    "open",
    "open-arg",
    "redirect",
    "session",
  ]);

  for (const key of Object.keys(parsed.values)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown argument: --${key}`);
    }
  }

  const asBoolean = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;
  const asString = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  const asStringOrNull = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const asStringArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.filter((i): i is string => typeof i === "string");
    if (typeof v === "string") return [v];
    return [];
  };

  return {
    accessToken: asStringOrNull(parsed.values["access-token"]),
    agentArgs: asStringArray(parsed.values["agent-arg"]),
    allowNonLocal: asBoolean(parsed.values["allow-non-local"], false),
    baseUrl: asString(parsed.values["base-url"], getDefaultBaseUrl()),
    githubLogin: asString(parsed.values["github-login"], "agent-browser"),
    githubUserId: asString(parsed.values["github-user-id"], "0"),
    headed: asBoolean(parsed.values.headed, false),
    open: asBoolean(parsed.values.open, true),
    openArgs: asStringArray(parsed.values["open-arg"]),
    outputJson: asBoolean(parsed.values.json, false),
    redirect: asStringOrNull(parsed.values.redirect),
    sessionName: asString(parsed.values.session, "open-inspect-auth"),
    userEmail: asString(parsed.values.email, "agent-browser@local.test"),
    userImage: asStringOrNull(parsed.values.image),
    userName: asString(parsed.values.name, "Agent Browser"),
  };
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

function assertSafeBaseUrl(baseUrl: string, allowNonLocal: boolean): URL {
  const parsed = new URL(baseUrl);
  if (!(allowNonLocal || LOCAL_HOSTNAMES.has(parsed.hostname))) {
    throw new Error(
      `Refusing non-local base URL "${baseUrl}". Pass --allow-non-local to override.`
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Session creation via running server
// ---------------------------------------------------------------------------

/**
 * Create a session by calling the running server's better-auth sign-up
 * endpoint with email/password. If the user already exists, falls back
 * to sign-in. Returns the session token extracted from Set-Cookie headers.
 *
 * This uses the email/password flow as a dev convenience. The running server
 * must be reachable at `baseUrl`.
 */
async function createSessionViaServer(
  baseUrl: URL,
  options: {
    userName: string;
    userEmail: string;
    userImage: string | null;
  }
): Promise<{ sessionToken: string }> {
  // Use a deterministic password for agent-browser sessions
  const agentPassword = "agent-browser-dev-password-not-for-production";

  // Try sign-up first, fall back to sign-in if user exists
  const signUpUrl = new URL("/api/auth/sign-up/email", baseUrl);
  const signUpRes = await fetch(signUpUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: options.userName,
      email: options.userEmail,
      password: agentPassword,
      image: options.userImage,
    }),
    redirect: "manual",
  });

  let cookieHeader = signUpRes.headers.get("set-cookie");

  if (!cookieHeader || signUpRes.status >= 400) {
    // User may already exist — try sign-in
    const signInUrl = new URL("/api/auth/sign-in/email", baseUrl);
    const signInRes = await fetch(signInUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: options.userEmail,
        password: agentPassword,
      }),
      redirect: "manual",
    });

    cookieHeader = signInRes.headers.get("set-cookie");
    if (!cookieHeader) {
      throw new Error(
        `Failed to sign in. Status: ${signInRes.status}. ` +
          "Ensure the dev server is running and accessible."
      );
    }
  }

  // Extract the session token from Set-Cookie header
  const sessionToken = extractSessionToken(cookieHeader);
  if (!sessionToken) {
    throw new Error(
      "Session cookie not found in server response. " +
        "The server may not be configured for email/password authentication."
    );
  }

  return { sessionToken };
}

/**
 * Extract the better-auth session token from a Set-Cookie header value.
 */
function extractSessionToken(setCookieHeader: string): string | null {
  // Parse all cookies from the header (may contain multiple Set-Cookie values)
  const cookieParts = setCookieHeader.split(/,(?=[^ ])/);
  for (const part of cookieParts) {
    // Match both secure and non-secure cookie names
    const match = part.match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/);
    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// agent-browser wrapper
// ---------------------------------------------------------------------------

function runAgentBrowser(args: string[]): void {
  const result = spawnSync("agent-browser", args, { stdio: "inherit" });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "agent-browser CLI is not installed or not on PATH. " +
          "Install it first: npm install -g agent-browser"
      );
    }
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`agent-browser exited with code ${result.status}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const baseUrl = assertSafeBaseUrl(options.baseUrl, options.allowNonLocal);
  const isSecure = baseUrl.protocol === "https:";

  // --- Create session via running server ------------------------------------
  const { sessionToken } = await createSessionViaServer(baseUrl, {
    userName: options.userName,
    userEmail: options.userEmail,
    userImage: options.userImage,
  });

  const cookieName = sessionCookieName(isSecure);
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + SESSION_EXPIRY_SECONDS;
  const redirectPath = options.redirect ?? "/";
  const destinationUrl = new URL(redirectPath, baseUrl).toString();

  // --- Inject cookie via agent-browser ----------------------------------------
  //
  // Sequence matters: we first navigate to the base URL so that the browser
  // context is initialised with the correct origin, then set our session
  // cookie, and finally reload so the server sees the valid session on the
  // next request.
  //
  const baseAgentBrowserArgs = ["--session", options.sessionName];
  if (options.headed) {
    baseAgentBrowserArgs.push("--headed");
  }
  baseAgentBrowserArgs.push(...options.agentArgs);

  // 1. Navigate to the base URL to bootstrap the browser context.
  runAgentBrowser([...baseAgentBrowserArgs, "open", baseUrl.toString()]);

  // 2. Set the session cookie.
  const cookieArgs = [
    ...baseAgentBrowserArgs,
    "cookies",
    "set",
    cookieName,
    sessionToken,
    "--url",
    baseUrl.toString(),
    "--httpOnly",
    "--sameSite",
    "Lax",
    "--expires",
    String(expiresAtSeconds),
  ];

  if (isSecure) {
    cookieArgs.push("--secure");
  }

  runAgentBrowser(cookieArgs);

  // 3. Navigate to the destination (or reload if same) so the server
  //    picks up the freshly-set session cookie.
  if (options.open) {
    const openArgs = [...baseAgentBrowserArgs, ...options.openArgs, "open", destinationUrl];
    runAgentBrowser(openArgs);
  } else {
    // Even with --no-open we reload to verify the cookie sticks.
    runAgentBrowser([...baseAgentBrowserArgs, "reload"]);
  }

  // --- Output ----------------------------------------------------------------
  const output = {
    baseUrl: baseUrl.toString(),
    cookieName,
    destinationUrl,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    sessionName: options.sessionName,
    user: {
      email: options.userEmail,
      githubLogin: options.githubLogin,
      githubUserId: options.githubUserId,
      name: options.userName,
    },
  };

  if (options.outputJson) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log("");
  console.log("Agent browser login is ready.");
  console.log(`  Session:     ${options.sessionName}`);
  console.log(`  Cookie:      ${cookieName}`);
  console.log(`  Destination: ${destinationUrl}`);
  console.log(`  User:        ${options.githubLogin} <${options.userEmail}>`);
  console.log(`  Expires:     ${output.expiresAt}`);
}

main().catch((error) => {
  console.error(
    error instanceof Error ? `[agent-login] ${error.message}` : "[agent-login] Unknown error"
  );
  process.exit(1);
});
