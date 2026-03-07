import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { checkAccessAllowed, parseAllowlist } from "./access-control";

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
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  },
  pages: {
    error: "/access-denied",
  },
});

export type Session = typeof auth.$Infer.Session;
