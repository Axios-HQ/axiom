import { beforeEach, describe, expect, it } from "vitest";
import { IdentityLinksStore, type IdentityProvider } from "./identity-links";

type IdentityLinkRow = {
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
};

const QUERY_PATTERNS = {
  UPSERT: /^INSERT INTO identity_links/,
  GET_ONE:
    /^SELECT provider, external_user_id, github_user_id, github_login, github_name, created_by, created_at, updated_at , source, source_metadata, is_manual FROM identity_links WHERE provider = \? AND external_user_id = \?/,
  LIST_FOR_USER:
    /^SELECT provider, external_user_id, github_user_id, github_login, github_name, created_by, created_at, updated_at , source, source_metadata, is_manual FROM identity_links WHERE github_user_id = \? ORDER BY updated_at DESC/,
  DELETE: /^DELETE FROM identity_links WHERE provider = \? AND external_user_id = \?/,
} as const;

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

class FakeD1Database {
  private rows = new Map<string, IdentityLinkRow>();

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }

  first(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);
    if (QUERY_PATTERNS.GET_ONE.test(normalized)) {
      const provider = args[0] as IdentityProvider;
      const externalUserId = args[1] as string;
      return this.rows.get(`${provider}:${externalUserId}`) ?? null;
    }
    throw new Error(`Unexpected first() query: ${query}`);
  }

  all(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);
    if (QUERY_PATTERNS.LIST_FOR_USER.test(normalized)) {
      const githubUserId = args[0] as string;
      const rows = [...this.rows.values()]
        .filter((r) => r.github_user_id === githubUserId)
        .sort((a, b) => b.updated_at - a.updated_at);
      return { results: rows };
    }
    throw new Error(`Unexpected all() query: ${query}`);
  }

  run(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);
    if (QUERY_PATTERNS.UPSERT.test(normalized)) {
      const [
        provider,
        externalUserId,
        githubUserId,
        githubLogin,
        githubName,
        source,
        sourceMetadata,
        isManual,
        createdBy,
        createdAt,
        updatedAt,
      ] = args as [
        IdentityProvider,
        string,
        string,
        string,
        string | null,
        string,
        string | null,
        number,
        string,
        number,
        number,
      ];

      const key = `${provider}:${externalUserId}`;
      const existing = this.rows.get(key);

      this.rows.set(key, {
        provider,
        external_user_id: externalUserId,
        github_user_id: githubUserId,
        github_login: githubLogin,
        github_name: githubName,
        source,
        source_metadata: sourceMetadata,
        is_manual: isManual,
        created_by: existing?.created_by ?? createdBy,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      });

      return { meta: { changes: 1 } };
    }

    if (QUERY_PATTERNS.DELETE.test(normalized)) {
      const provider = args[0] as IdentityProvider;
      const externalUserId = args[1] as string;
      const key = `${provider}:${externalUserId}`;
      const existed = this.rows.delete(key);
      return { meta: { changes: existed ? 1 : 0 } };
    }

    throw new Error(`Unexpected run() query: ${query}`);
  }
}

class FakePreparedStatement {
  private bound: unknown[] = [];

  constructor(
    private db: FakeD1Database,
    private query: string
  ) {}

  bind(...args: unknown[]) {
    this.bound = args;
    return this;
  }

  async first<T>() {
    return this.db.first(this.query, this.bound) as T | null;
  }

  async all<T>() {
    return this.db.all(this.query, this.bound) as { results?: T[] };
  }

  async run() {
    return this.db.run(this.query, this.bound);
  }
}

describe("IdentityLinksStore", () => {
  let db: FakeD1Database;
  let store: IdentityLinksStore;

  beforeEach(() => {
    db = new FakeD1Database();
    store = new IdentityLinksStore(db as unknown as D1Database);
  });

  it("upserts and reads by provider+external user id", async () => {
    await store.upsert({
      provider: "linear",
      externalUserId: "lin_123",
      githubUserId: "gh_1",
      githubLogin: "josh",
      githubName: "Josh",
      createdBy: "github:gh_1",
    });

    const link = await store.getByProviderExternal("linear", "lin_123");
    expect(link).not.toBeNull();
    expect(link?.githubLogin).toBe("josh");
    expect(link?.githubUserId).toBe("gh_1");
    expect(link?.source).toBe("manual");
    expect(link?.isManual).toBe(false);
  });

  it("updates existing link on conflict", async () => {
    await store.upsert({
      provider: "slack",
      externalUserId: "U123",
      githubUserId: "gh_1",
      githubLogin: "josh",
      createdBy: "github:gh_1",
    });
    await store.upsert({
      provider: "slack",
      externalUserId: "U123",
      githubUserId: "gh_2",
      githubLogin: "josh2",
      createdBy: "github:gh_2",
    });

    const link = await store.getByProviderExternal("slack", "U123");
    expect(link?.githubUserId).toBe("gh_2");
    expect(link?.githubLogin).toBe("josh2");
    expect(link?.createdBy).toBe("github:gh_1");
  });

  it("preserves manual links when preserveManual is true", async () => {
    await store.upsert({
      provider: "slack",
      externalUserId: "U123",
      githubUserId: "gh_1",
      githubLogin: "josh",
      createdBy: "manual:admin",
      source: "manual_api",
      isManual: true,
    });

    const outcome = await store.upsertWithOutcome({
      provider: "slack",
      externalUserId: "U123",
      githubUserId: "gh_2",
      githubLogin: "josh2",
      createdBy: "sync:identity_links",
      source: "identity_sync",
      isManual: false,
      preserveManual: true,
    });

    expect(outcome).toBe("conflicted");
    const link = await store.getByProviderExternal("slack", "U123");
    expect(link?.githubUserId).toBe("gh_1");
    expect(link?.isManual).toBe(true);
  });

  it("lists links by github user", async () => {
    await store.upsert({
      provider: "linear",
      externalUserId: "lin_1",
      githubUserId: "gh_1",
      githubLogin: "josh",
      createdBy: "github:gh_1",
    });
    await store.upsert({
      provider: "slack",
      externalUserId: "U1",
      githubUserId: "gh_1",
      githubLogin: "josh",
      createdBy: "github:gh_1",
    });

    const links = await store.listByGithubUserId("gh_1");
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.provider).sort()).toEqual(["linear", "slack"]);
  });

  it("deletes a link", async () => {
    await store.upsert({
      provider: "linear",
      externalUserId: "lin_1",
      githubUserId: "gh_1",
      githubLogin: "josh",
      createdBy: "github:gh_1",
    });

    const deleted = await store.delete("linear", "lin_1");
    expect(deleted).toBe(true);
    expect(await store.getByProviderExternal("linear", "lin_1")).toBeNull();
  });
});
