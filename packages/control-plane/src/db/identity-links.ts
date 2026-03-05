export type IdentityProvider = "linear" | "slack";

export interface IdentityLink {
  provider: IdentityProvider;
  externalUserId: string;
  githubUserId: string;
  githubLogin: string;
  githubName: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

interface IdentityLinkRow {
  provider: IdentityProvider;
  external_user_id: string;
  github_user_id: string;
  github_login: string;
  github_name: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

function toLink(row: IdentityLinkRow): IdentityLink {
  return {
    provider: row.provider,
    externalUserId: row.external_user_id,
    githubUserId: row.github_user_id,
    githubLogin: row.github_login,
    githubName: row.github_name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class IdentityLinksStore {
  constructor(private readonly db: D1Database) {}

  async upsert(input: {
    provider: IdentityProvider;
    externalUserId: string;
    githubUserId: string;
    githubLogin: string;
    githubName?: string | null;
    createdBy: string;
  }): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO identity_links
         (provider, external_user_id, github_user_id, github_login, github_name, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, external_user_id) DO UPDATE SET
           github_user_id = excluded.github_user_id,
           github_login = excluded.github_login,
           github_name = excluded.github_name,
           updated_at = excluded.updated_at`
      )
      .bind(
        input.provider,
        input.externalUserId,
        input.githubUserId,
        input.githubLogin,
        input.githubName ?? null,
        input.createdBy,
        now,
        now
      )
      .run();
  }

  async getByProviderExternal(
    provider: IdentityProvider,
    externalUserId: string
  ): Promise<IdentityLink | null> {
    const row = await this.db
      .prepare(
        `SELECT provider, external_user_id, github_user_id, github_login, github_name, created_by, created_at, updated_at
         FROM identity_links
         WHERE provider = ? AND external_user_id = ?`
      )
      .bind(provider, externalUserId)
      .first<IdentityLinkRow>();

    return row ? toLink(row) : null;
  }

  async listByGithubUserId(githubUserId: string): Promise<IdentityLink[]> {
    const result = await this.db
      .prepare(
        `SELECT provider, external_user_id, github_user_id, github_login, github_name, created_by, created_at, updated_at
         FROM identity_links
         WHERE github_user_id = ?
         ORDER BY updated_at DESC`
      )
      .bind(githubUserId)
      .all<IdentityLinkRow>();

    return (result.results || []).map(toLink);
  }

  async delete(provider: IdentityProvider, externalUserId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM identity_links WHERE provider = ? AND external_user_id = ?`)
      .bind(provider, externalUserId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }
}
