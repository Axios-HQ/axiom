import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { apiKey } from "@better-auth/api-key";
import { checkAccessAllowed, parseAllowlist } from "./access-control";

const accessConfig = {
  allowedUsers: parseAllowlist(process.env.ALLOWED_USERS),
  allowedDomains: parseAllowlist(process.env.ALLOWED_EMAIL_DOMAINS),
};

/**
 * Try to get the Cloudflare D1 binding for auth.
 * Returns null when not running on Cloudflare Workers.
 */
async function getD1Database(): Promise<unknown | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = await getCloudflareContext({ async: true });
    const db = (ctx as { env?: { AUTH_DB?: unknown } }).env?.AUTH_DB;
    if (db && typeof db === "object" && "prepare" in db) {
      return db;
    }
    return null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _cachedAuth: any = null;

function createAuth(d1Database: unknown | null) {
  // Use D1 binding when available (Cloudflare Workers), otherwise SQLite file URL
  const database = d1Database ?? {
    type: "sqlite" as const,
    url: process.env.AUTH_DATABASE_URL!,
  };

  return betterAuth({
    database,
    socialProviders: {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
        scope: ["read:user", "user:email", "repo"],
        // Custom getUserInfo to reliably fetch email on Cloudflare Workers.
        // The default betterFetch-based implementation can fail silently on CF.
        getUserInfo: async (token) => {
          const headers = {
            Authorization: `Bearer ${token.accessToken}`,
            "User-Agent": "open-inspect",
            Accept: "application/vnd.github+json",
          };
          const profileRes = await fetch("https://api.github.com/user", { headers });
          if (!profileRes.ok) return null;
          const profile = (await profileRes.json()) as Record<string, unknown>;

          // Try /user/emails if profile has no public email
          if (!profile.email) {
            try {
              const emailsRes = await fetch("https://api.github.com/user/emails", { headers });
              if (emailsRes.ok) {
                const emails = (await emailsRes.json()) as Array<{
                  email: string;
                  primary: boolean;
                  verified: boolean;
                }>;
                profile.email = (emails.find((e) => e.primary) ?? emails[0])?.email;
              }
            } catch {
              // /user/emails may 403 for GitHub App tokens — fall through
            }
          }

          // Fallback: use noreply email if GitHub doesn't expose a real one.
          // GitHub App OAuth tokens may not have email access.
          if (!profile.email) {
            profile.email = `${profile.id}+${profile.login}@users.noreply.github.com`;
          }

          return {
            user: {
              id: String(profile.id),
              name: (profile.name as string) || (profile.login as string) || "",
              email: profile.email as string,
              image: profile.avatar_url as string,
              emailVerified: true,
            },
            data: profile,
          };
        },
      },
    },
    plugins: [
      organization({
        creatorRole: "admin",
      }),
      apiKey([
        {
          configId: "service-keys",
          defaultPrefix: "oi_",
          references: "organization",
        },
      ]),
    ],
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        // Gate access on social sign-in callback (new accounts + returning users)
        if (!ctx.path.startsWith("/callback/")) return;
        const session = ctx.context.newSession ?? ctx.context.session;
        if (!session?.user) return;

        const allowed = checkAccessAllowed(accessConfig, {
          githubUsername: session.user.name ?? undefined,
          email: session.user.email ?? undefined,
        });

        if (!allowed) {
          throw new APIError("FORBIDDEN", {
            message: "Your account is not on the access allowlist",
          });
        }
      }),
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },
  });
}

type AuthInstance = ReturnType<typeof createAuth>;

/**
 * Get the auth instance. On Cloudflare Workers, uses D1 binding (auto-detected
 * by better-auth). On Vercel/local dev, uses SQLite file URL.
 * Cached per isolate after first call.
 */
export async function getAuth(): Promise<AuthInstance> {
  if (_cachedAuth) return _cachedAuth as AuthInstance;

  const d1 = await getD1Database();
  _cachedAuth = createAuth(d1);
  return _cachedAuth as AuthInstance;
}

export type Session = AuthInstance["$Infer"]["Session"];
