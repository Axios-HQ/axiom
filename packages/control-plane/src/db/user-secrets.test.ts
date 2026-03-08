import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { UserSecretsStore } from "./user-secrets";
import { SecretsValidationError } from "./secrets-validation";
import { generateEncryptionKey } from "../auth/crypto";

let didPolyfillCrypto = false;

beforeAll(() => {
  if (!(globalThis as { crypto?: typeof webcrypto }).crypto) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
    didPolyfillCrypto = true;
  }
});

afterAll(() => {
  if (didPolyfillCrypto) {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  }
});

type UserSecretRow = {
  user_id: string;
  key: string;
  encrypted_value: string;
  created_at: number;
  updated_at: number;
};

/**
 * Query patterns for FakeD1Database routing.
 * Matches SQL operations in UserSecretsStore by their leading clause
 * after whitespace normalization, making the fake resilient to
 * formatting changes in the SQL strings.
 */
const QUERY_PATTERNS = {
  SELECT_EXISTING_KEYS: /^SELECT key FROM user_secrets/,
  SELECT_KEYS_WITH_METADATA: /^SELECT key, created_at, updated_at FROM user_secrets/,
  SELECT_KEYS_WITH_VALUES: /^SELECT key, encrypted_value FROM user_secrets/,
  UPSERT_SECRET: /^INSERT INTO user_secrets/,
  DELETE_SECRET: /^DELETE FROM user_secrets/,
} as const;

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

class FakeD1Database {
  private rows = new Map<string, UserSecretRow>();

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }

  all(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.SELECT_KEYS_WITH_METADATA.test(normalized)) {
      const userId = args[0] as string;
      return Array.from(this.rows.values())
        .filter((row) => row.user_id === userId)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((row) => ({
          key: row.key,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }));
    }

    if (QUERY_PATTERNS.SELECT_KEYS_WITH_VALUES.test(normalized)) {
      const userId = args[0] as string;
      return Array.from(this.rows.values())
        .filter((row) => row.user_id === userId)
        .map((row) => ({ key: row.key, encrypted_value: row.encrypted_value }));
    }

    if (QUERY_PATTERNS.SELECT_EXISTING_KEYS.test(normalized)) {
      const userId = args[0] as string;
      return Array.from(this.rows.values())
        .filter((row) => row.user_id === userId)
        .map((row) => ({ key: row.key }));
    }

    throw new Error(`Unexpected SELECT query: ${query}`);
  }

  run(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.UPSERT_SECRET.test(normalized)) {
      const [userId, key, encryptedValue, createdAt, updatedAt] = args as [
        string,
        string,
        string,
        number,
        number,
      ];
      const rowKey = `${userId}:${key}`;
      const existing = this.rows.get(rowKey);
      const created_at = existing ? existing.created_at : createdAt;
      this.rows.set(rowKey, {
        user_id: userId,
        key,
        encrypted_value: encryptedValue,
        created_at,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    if (QUERY_PATTERNS.DELETE_SECRET.test(normalized)) {
      const [userId, key] = args as [string, string];
      const rowKey = `${userId}:${key}`;
      const existed = this.rows.delete(rowKey);
      return { meta: { changes: existed ? 1 : 0 } };
    }

    throw new Error(`Unexpected mutation query: ${query}`);
  }

  async batch(statements: FakePreparedStatement[]) {
    return statements.map((stmt) => stmt.runSync());
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

  async all<T>() {
    return { results: this.db.all(this.query, this.bound) as T[] };
  }

  runSync() {
    return this.db.run(this.query, this.bound);
  }

  async run() {
    return this.runSync();
  }
}

describe("UserSecretsStore", () => {
  let db: FakeD1Database;
  let store: UserSecretsStore;

  beforeEach(() => {
    db = new FakeD1Database();
    store = new UserSecretsStore(db as unknown as D1Database, generateEncryptionKey());
  });

  it("encrypts and decrypts values", async () => {
    await store.setSecrets("user-1", { FOO: "bar" });
    const secrets = await store.getDecryptedSecrets("user-1");
    expect(secrets).toEqual({ FOO: "bar" });
  });

  it("normalizes keys and updates existing secrets", async () => {
    const first = await store.setSecrets("user-1", { foo: "one" });
    expect(first.created).toBe(1);
    expect(first.updated).toBe(0);

    const second = await store.setSecrets("user-1", { FOO: "two" });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const secrets = await store.getDecryptedSecrets("user-1");
    expect(secrets).toEqual({ FOO: "two" });
  });

  it("rejects reserved keys", async () => {
    await expect(store.setSecrets("user-1", { PATH: "nope" })).rejects.toBeInstanceOf(
      SecretsValidationError
    );
  });

  it("rejects invalid key patterns", async () => {
    await expect(store.setSecrets("user-1", { "1BAD": "nope" })).rejects.toBeInstanceOf(
      SecretsValidationError
    );
  });

  it("enforces value size limits", async () => {
    const bigValue = "a".repeat(16385);
    await expect(store.setSecrets("user-1", { BIG: bigValue })).rejects.toBeInstanceOf(
      SecretsValidationError
    );
  });

  it("enforces total size limits", async () => {
    const largeA = "a".repeat(40000);
    const largeB = "b".repeat(30000);
    await expect(store.setSecrets("user-1", { A: largeA, B: largeB })).rejects.toBeInstanceOf(
      SecretsValidationError
    );
  });

  it("enforces per-user secret limit", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      many[`KEY_${i}`] = "x";
    }
    await store.setSecrets("user-1", many);

    await expect(store.setSecrets("user-1", { EXTRA: "y" })).rejects.toBeInstanceOf(
      SecretsValidationError
    );
  });

  it("lists keys with metadata", async () => {
    await store.setSecrets("user-1", { ALPHA: "1", BETA: "2" });
    const keys = await store.listSecretKeys("user-1");
    expect(keys.map((k) => k.key)).toEqual(["ALPHA", "BETA"]);
    expect(keys[0].createdAt).toBeTypeOf("number");
  });

  it("deletes secrets by key", async () => {
    await store.setSecrets("user-1", { ALPHA: "1" });
    const deleted = await store.deleteSecret("user-1", "alpha");
    expect(deleted).toBe(true);
    const secrets = await store.getDecryptedSecrets("user-1");
    expect(secrets).toEqual({});
  });
});
