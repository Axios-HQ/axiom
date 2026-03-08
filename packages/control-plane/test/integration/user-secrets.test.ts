import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { UserSecretsStore } from "../../src/db/user-secrets";

describe("UserSecretsStore (integration)", () => {
  let store: UserSecretsStore;

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM user_secrets").run();
    store = new UserSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
  });

  it("sets and retrieves user secrets", async () => {
    await store.setSecrets("user-123", {
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      OPENAI_API_KEY: "sk-test-openai",
    });

    const keys = await store.listSecretKeys("user-123");
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.key).sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);

    const decrypted = await store.getDecryptedSecrets("user-123");
    expect(decrypted.ANTHROPIC_API_KEY).toBe("sk-ant-test-key");
    expect(decrypted.OPENAI_API_KEY).toBe("sk-test-openai");
  });

  it("isolates secrets between users", async () => {
    await store.setSecrets("user-1", { ANTHROPIC_API_KEY: "key-1" });
    await store.setSecrets("user-2", { ANTHROPIC_API_KEY: "key-2" });

    const secrets1 = await store.getDecryptedSecrets("user-1");
    const secrets2 = await store.getDecryptedSecrets("user-2");

    expect(secrets1.ANTHROPIC_API_KEY).toBe("key-1");
    expect(secrets2.ANTHROPIC_API_KEY).toBe("key-2");
  });

  it("deletes a user secret", async () => {
    await store.setSecrets("user-123", { ANTHROPIC_API_KEY: "test-key" });

    const deleted = await store.deleteSecret("user-123", "ANTHROPIC_API_KEY");
    expect(deleted).toBe(true);

    const keys = await store.listSecretKeys("user-123");
    expect(keys).toHaveLength(0);
  });

  it("upserts existing keys", async () => {
    await store.setSecrets("user-123", { ANTHROPIC_API_KEY: "old-key" });
    const result = await store.setSecrets("user-123", { ANTHROPIC_API_KEY: "new-key" });

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);

    const decrypted = await store.getDecryptedSecrets("user-123");
    expect(decrypted.ANTHROPIC_API_KEY).toBe("new-key");
  });
});
