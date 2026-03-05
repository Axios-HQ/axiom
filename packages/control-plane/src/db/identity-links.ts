export type IdentityProvider = "linear" | "slack";

export interface IdentityLink {
  provider: IdentityProvider;
  externalUserId: string;
  githubUserId: string;
  githubLogin: string;
  githubName: string | null;
  source: string;
  sourceMetadata: Record<string, unknown> | null;
  isManual: boolean;
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
  source: string;
  source_metadata: string | null;
  is_manual: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

function toLink(row: IdentityLinkRow): IdentityLink {
  let sourceMetadata: Record<string, unknown> | null = null;
  if (row.source_metadata) {
    try {
      sourceMetadata = JSON.parse(row.source_metadata) as Record<string, unknown>;
    } catch {
      sourceMetadata = null;
    }
  }

  return {
    provider: row.provider,
    externalUserId: row.external_user_id,
    githubUserId: row.github_user_id,
    githubLogin: row.github_login,
    githubName: row.github_name,
    source: row.source,
    sourceMetadata,
    isManual: row.is_manual === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type IdentityLinkUpsertOutcome = "linked" | "skipped" | "conflicted";

export class IdentityLinksStore {
  constructor(private readonly db: D1Database) {}

  async upsert(input: {
    provider: IdentityProvider;
    externalUserId: string;
    githubUserId: string;
    githubLogin: string;
    githubName?: string | null;
    createdBy: string;
    source?: string;
    sourceMetadata?: Record<string, unknown> | null;
    isManual?: boolean;
    preserveManual?: boolean;
  }): Promise<void> {
    await this.upsertWithOutcome(input);
  }

  async upsertWithOutcome(input: {
    provider: IdentityProvider;
    externalUserId: string;
    githubUserId: string;
    githubLogin: string;
    githubName?: string | null;
    createdBy: string;
    source?: string;
    sourceMetadata?: Record<string, unknown> | null;
    isManual?: boolean;
    preserveManual?: boolean;
  }): Promise<IdentityLinkUpsertOutcome> {
    const githubName = input.githubName ?? null;
    const preserveManual = Boolean(input.preserveManual);

    // Check for a true no-op before writing (identical values on non-manual row, or
    // a manual row that exactly matches when preserveManual is off).
    const existing = await this.getByProviderExternal(input.provider, input.externalUserId);
    if (existing) {
      const valuesMatch =
        existing.githubUserId === input.githubUserId &&
        existing.githubLogin === input.githubLogin &&
        (existing.githubName ?? null) === githubName;

      if (existing.isManual && preserveManual) {
        // Atomic guard: never overwrite a manual row when preserveManual is set.
        // Classify the intent before hitting the DB.
        return valuesMatch ? "skipped" : "conflicted";
      }

      if (valuesMatch) {
        // No-op update for non-manual rows — avoid an unnecessary write.
        return "skipped";
      }
    }

    const now = Date.now();
    // Atomic guard in SQL: skip the update if the stored row is manual and we want
    // to preserve manual links. This closes the TOCTOU window between the read
    // above and the write below (e.g. a concurrent manual-link creation).
    const result = await this.db
      .prepare(
        `INSERT INTO identity_links
         (provider, external_user_id, github_user_id, github_login, github_name, source, source_metadata, is_manual, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, external_user_id) DO UPDATE SET
            github_user_id = excluded.github_user_id,
            github_login = excluded.github_login,
            github_name = excluded.github_name,
            source = excluded.source,
            source_metadata = excluded.source_metadata,
            is_manual = excluded.is_manual,
            updated_at = excluded.updated_at
         WHERE NOT (identity_links.is_manual = 1 AND ? = 1)`
      )
      .bind(
        input.provider,
        input.externalUserId,
        input.githubUserId,
        input.githubLogin,
        githubName,
        input.source ?? "manual",
        input.sourceMetadata ? JSON.stringify(input.sourceMetadata) : null,
        input.isManual ? 1 : 0,
        input.createdBy,
        now,
        now,
        preserveManual ? 1 : 0
      )
      .run();

    // If the WHERE guard blocked the update, the row was a manual link that we
    // must not overwrite. Re-read to distinguish skipped vs conflicted.
    if ((result.meta?.changes ?? 0) === 0 && preserveManual) {
      const current = await this.getByProviderExternal(input.provider, input.externalUserId);
      if (current?.isManual) {
        const valuesMatch =
          current.githubUserId === input.githubUserId &&
          current.githubLogin === input.githubLogin &&
          (current.githubName ?? null) === githubName;
        return valuesMatch ? "skipped" : "conflicted";
      }
    }

    return "linked";
  }

  async getByProviderExternal(
    provider: IdentityProvider,
    externalUserId: string
  ): Promise<IdentityLink | null> {
    const row = await this.db
      .prepare(
        `SELECT provider, external_user_id, github_user_id, github_login, github_name, created_by, created_at, updated_at
          , source, source_metadata, is_manual
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
          , source, source_metadata, is_manual
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
