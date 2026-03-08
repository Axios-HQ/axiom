import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { apiKey } from "@better-auth/api-key";
import { checkAccessAllowed, parseAllowlist } from "./access-control";

const accessConfig = {
  allowedUsers: parseAllowlist(process.env.ALLOWED_USERS),
  allowedDomains: parseAllowlist(process.env.ALLOWED_EMAIL_DOMAINS),
};

export const auth = betterAuth({
  database: {
    type: "sqlite",
    url: process.env.AUTH_DATABASE_URL!,
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      scope: ["read:user", "user:email", "repo"],
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

export type Session = typeof auth.$Infer.Session;
