import { createLogger, type Logger } from "../logger";
import { IdentityLinksStore } from "../db/identity-links";
import {
  resolveGitHubUserById,
  type ResolvedGitHubUser,
} from "../source-control/github-user-resolver";
import { fetchWithTimeout } from "../auth/github-app";

const logger = createLogger("identity-sync");

const SLACK_USERS_PAGE_SIZE = 200;
const IDENTITY_SYNC_HTTP_TIMEOUT_MS = 15_000;

interface SlackUser {
  id: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    email?: string;
  };
}

interface LinearUser {
  id: string;
  email: string;
  gitHubUserId: string | null;
}

export interface IdentitySyncInput {
  db: D1Database;
  slackBotToken: string;
  linearApiKey: string;
  domain: string;
  mode: "dry-run" | "apply";
  overrideManual?: boolean;
  log?: Logger;
}

export interface IdentitySyncResult {
  linked: number;
  skipped: number;
  conflicted: number;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function matchesDomain(email: string, domain: string): boolean {
  return normalizeEmail(email).endsWith(`@${domain.toLowerCase()}`);
}

async function fetchSlackUsers(slackBotToken: string): Promise<SlackUser[]> {
  const users: SlackUser[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL("https://slack.com/api/users.list");
    url.searchParams.set("limit", String(SLACK_USERS_PAGE_SIZE));
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetchWithTimeout(
      url.toString(),
      { headers: { Authorization: `Bearer ${slackBotToken}` } },
      IDENTITY_SYNC_HTTP_TIMEOUT_MS
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch Slack users: ${response.status}`);
    }

    const data = (await response.json()) as {
      ok: boolean;
      error?: string;
      members?: SlackUser[];
      response_metadata?: { next_cursor?: string };
    };

    if (!data.ok) {
      throw new Error(`Slack users.list failed: ${data.error || "unknown_error"}`);
    }

    users.push(...(data.members || []));
    const nextCursor = data.response_metadata?.next_cursor;
    cursor = nextCursor && nextCursor.length > 0 ? nextCursor : undefined;
  } while (cursor);

  return users;
}

async function fetchLinearUsers(linearApiKey: string): Promise<LinearUser[]> {
  const users: LinearUser[] = [];
  let hasMore = true;
  let cursor: string | null = null;

  while (hasMore) {
    const response = await fetchWithTimeout(
      "https://api.linear.app/graphql",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: linearApiKey,
        },
        body: JSON.stringify({
          query: `
            query IdentitySyncUsers($after: String) {
              users(first: 100, after: $after) {
                nodes {
                  id
                  email
                  gitHubUserId
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          `,
          variables: { after: cursor },
        }),
      },
      IDENTITY_SYNC_HTTP_TIMEOUT_MS
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch Linear users: ${response.status}`);
    }

    const payload = (await response.json()) as {
      errors?: Array<{ message?: string }>;
      data?: {
        users?: {
          nodes?: Array<{ id?: string; email?: string; gitHubUserId?: string | null }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      };
    };

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Linear GraphQL error: ${payload.errors[0]?.message || "unknown_error"}`);
    }

    const page = payload.data?.users;
    if (!page) {
      break;
    }

    for (const node of page.nodes || []) {
      if (!node.id || !node.email) continue;
      users.push({
        id: node.id,
        email: node.email,
        gitHubUserId: node.gitHubUserId ?? null,
      });
    }

    hasMore = Boolean(page.pageInfo?.hasNextPage);
    cursor = page.pageInfo?.endCursor ?? null;
  }

  return users;
}

export async function runIdentityLinkSync(input: IdentitySyncInput): Promise<IdentitySyncResult> {
  const log = input.log ?? logger;
  const store = new IdentityLinksStore(input.db);
  const domain = input.domain.trim().toLowerCase();
  const preserveManual = !input.overrideManual;

  const [slackUsers, linearUsers] = await Promise.all([
    fetchSlackUsers(input.slackBotToken),
    fetchLinearUsers(input.linearApiKey),
  ]);

  const linearByEmail = new Map<string, LinearUser>();
  for (const linearUser of linearUsers) {
    const email = normalizeEmail(linearUser.email);
    if (!matchesDomain(email, domain)) continue;
    if (!linearByEmail.has(email)) {
      linearByEmail.set(email, linearUser);
    }
  }

  const githubUsers = new Map<string, ResolvedGitHubUser | null>();
  const result: IdentitySyncResult = { linked: 0, skipped: 0, conflicted: 0 };

  for (const slackUser of slackUsers) {
    if (slackUser.deleted || slackUser.is_bot) {
      result.skipped += 1;
      continue;
    }

    const email = slackUser.profile?.email;
    if (!email || !matchesDomain(email, domain)) {
      result.skipped += 1;
      continue;
    }

    const normalizedEmail = normalizeEmail(email);
    const linearUser = linearByEmail.get(normalizedEmail);
    if (!linearUser || !linearUser.gitHubUserId) {
      result.skipped += 1;
      continue;
    }

    let ghUser = githubUsers.get(linearUser.gitHubUserId);
    if (ghUser === undefined) {
      ghUser = await resolveGitHubUserById(linearUser.gitHubUserId);
      githubUsers.set(linearUser.gitHubUserId, ghUser ?? null);
    }

    if (!ghUser) {
      result.skipped += 1;
      continue;
    }

    const sourceMetadata = {
      method: "slack_email_linear_github_id",
      domain,
      slackEmail: normalizedEmail,
      linearUserId: linearUser.id,
      mode: input.mode,
    };

    if (input.mode === "dry-run") {
      // Simulate upsert decisions without writing to DB.
      const candidates: Array<{ provider: "slack" | "linear"; externalUserId: string }> = [
        { provider: "slack", externalUserId: slackUser.id },
        { provider: "linear", externalUserId: linearUser.id },
      ];
      for (const candidate of candidates) {
        const existing = await store.getByProviderExternal(
          candidate.provider,
          candidate.externalUserId
        );
        if (existing?.isManual && preserveManual) {
          const wouldConflict =
            existing.githubUserId !== String(ghUser.id) ||
            existing.githubLogin !== ghUser.login ||
            (existing.githubName ?? null) !== (ghUser.name ?? null);
          if (wouldConflict) {
            result.conflicted += 1;
          } else {
            result.skipped += 1;
          }
        } else {
          result.linked += 1;
        }
      }
      continue;
    }

    const slackOutcome = await store.upsertWithOutcome({
      provider: "slack",
      externalUserId: slackUser.id,
      githubUserId: String(ghUser.id),
      githubLogin: ghUser.login,
      githubName: ghUser.name,
      createdBy: "sync:identity_links",
      source: "identity_sync",
      sourceMetadata,
      isManual: false,
      preserveManual,
    });

    const linearOutcome = await store.upsertWithOutcome({
      provider: "linear",
      externalUserId: linearUser.id,
      githubUserId: String(ghUser.id),
      githubLogin: ghUser.login,
      githubName: ghUser.name,
      createdBy: "sync:identity_links",
      source: "identity_sync",
      sourceMetadata,
      isManual: false,
      preserveManual,
    });

    for (const outcome of [slackOutcome, linearOutcome]) {
      if (outcome === "linked") result.linked += 1;
      if (outcome === "skipped") result.skipped += 1;
      if (outcome === "conflicted") result.conflicted += 1;
    }
  }

  log.info("identity_link.sync.completed", {
    mode: input.mode,
    domain,
    linked: result.linked,
    skipped: result.skipped,
    conflicted: result.conflicted,
  });

  return result;
}
