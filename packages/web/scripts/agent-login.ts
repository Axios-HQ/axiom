/**
 * agent-login — provision a NextAuth session cookie for agent-browser.
 *
 * Open-Inspect uses NextAuth v4 with JWT-only sessions (no DB adapter).
 * The session cookie IS the encrypted JWT.  We mint one using NextAuth's
 * own `encode()`, then inject it into a persistent agent-browser session.
 *
 * Usage:
 *   pnpm --filter @open-inspect/web agent:login -- [options]
 *
 * Requires:
 *   - NEXTAUTH_SECRET env var (same value the running dev server uses)
 *   - agent-browser CLI on PATH
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { encode } from "next-auth/jwt";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PORT_REGEX = /^[0-9]{2,5}$/;
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days — NextAuth default

/**
 * NextAuth v4 uses different cookie names depending on the protocol.
 * HTTPS → `__Secure-next-auth.session-token`
 * HTTP  → `next-auth.session-token`
 */
function sessionCookieName(secure: boolean): string {
  return secure ? "__Secure-next-auth.session-token" : "next-auth.session-token";
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
  // JWT payload fields
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
    "Provision a NextAuth session cookie for agent-browser so automated",
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
    "  --access-token <token>    GitHub access token to embed in the JWT (default: none)",
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
    "  NEXTAUTH_SECRET           Required. Must match the running dev server's secret.",
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
// JWT minting
// ---------------------------------------------------------------------------

async function mintSessionJwt(options: {
  secret: string;
  githubUserId: string;
  githubLogin: string;
  userName: string;
  userEmail: string;
  userImage: string | null;
  accessToken: string | null;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // NextAuth v4 JWT payload — must match the shape produced by the jwt
  // callback in src/lib/auth.ts.  `encode()` encrypts this as a JWE using
  // the secret and HKDF-derived key, salted with the cookie name.
  const token: Record<string, unknown> = {
    githubUserId: options.githubUserId,
    githubLogin: options.githubLogin,
    name: options.userName,
    email: options.userEmail,
    picture: options.userImage,
    sub: options.githubUserId,
    iat: now,
    exp: now + MAX_AGE_SECONDS,
    jti: crypto.randomUUID(),
  };

  if (options.accessToken) {
    token.accessToken = options.accessToken;
  }

  // NextAuth v4's server-side `decode()` (called from the session route) does
  // NOT pass a `salt` — it defaults to `""`.  We must match that here so the
  // HKDF-derived key is identical on both sides.
  return encode({
    token,
    secret: options.secret,
    maxAge: MAX_AGE_SECONDS,
  });
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

  // --- Resolve NEXTAUTH_SECRET -----------------------------------------------
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      "NEXTAUTH_SECRET is not set. Export it or add it to packages/web/.env " +
        "and source the file before running this script."
    );
  }

  // --- Mint JWT --------------------------------------------------------------
  const cookieName = sessionCookieName(isSecure);
  const jwt = await mintSessionJwt({
    secret,
    githubUserId: options.githubUserId,
    githubLogin: options.githubLogin,
    userName: options.userName,
    userEmail: options.userEmail,
    userImage: options.userImage,
    accessToken: options.accessToken,
  });

  const expiresAtSeconds = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const redirectPath = options.redirect ?? "/";
  const destinationUrl = new URL(redirectPath, baseUrl).toString();

  // --- Inject cookie via agent-browser ----------------------------------------
  //
  // Sequence matters: we first navigate to the base URL so that the browser
  // context is initialised with the correct origin, then set our session
  // cookie (which overwrites whatever NextAuth may have set), and finally
  // reload so the server sees the valid JWT on the next request.
  //
  const baseAgentBrowserArgs = ["--session", options.sessionName];
  if (options.headed) {
    baseAgentBrowserArgs.push("--headed");
  }
  baseAgentBrowserArgs.push(...options.agentArgs);

  // 1. Navigate to the base URL to bootstrap the browser context.
  runAgentBrowser([...baseAgentBrowserArgs, "open", baseUrl.toString()]);

  // 2. Set the session cookie (overwrites any default NextAuth cookies).
  const cookieArgs = [
    ...baseAgentBrowserArgs,
    "cookies",
    "set",
    cookieName,
    jwt,
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
