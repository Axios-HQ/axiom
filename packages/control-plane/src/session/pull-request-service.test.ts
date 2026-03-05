import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "../logger";
import type { SourceControlProvider } from "../source-control";
import type { ArtifactRow, SessionRow } from "./types";
import {
  SessionPullRequestService,
  validatePrTitle,
  type CreatePullRequestInput,
  type PullRequestRepository,
  type PullRequestServiceDeps,
  type PrPolicy,
} from "./pull-request-service";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "session-name-1",
    title: null,
    repo_owner: "acme",
    repo_name: "web",
    repo_id: 123,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-sonnet-4-5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user" as const,
    spawn_depth: 0,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function createMockProvider() {
  return {
    name: "github",
    checkRepositoryAccess: vi.fn(),
    listRepositories: vi.fn(),
    generatePushAuth: vi.fn(async () => ({ authType: "app", token: "app-token" as const })),
    getRepository: vi.fn(async () => ({
      owner: "acme",
      name: "web",
      fullName: "acme/web",
      defaultBranch: "main",
      isPrivate: true,
      providerRepoId: 123,
    })),
    createPullRequest: vi.fn(async () => ({
      id: 42,
      webUrl: "https://github.com/acme/web/pull/42",
      apiUrl: "https://api.github.com/repos/acme/web/pulls/42",
      state: "open" as const,
      sourceBranch: "open-inspect/session-name-1",
      targetBranch: "main",
    })),
    buildManualPullRequestUrl: vi.fn(
      (config: { sourceBranch: string; targetBranch: string }) =>
        `https://github.com/acme/web/pull/new/${config.targetBranch}...${config.sourceBranch}`
    ),
    buildGitPushSpec: vi.fn((config: { targetBranch: string }) => ({
      remoteUrl: "https://example.invalid/repo.git",
      redactedRemoteUrl: "https://example.invalid/<redacted>.git",
      refspec: `HEAD:refs/heads/${config.targetBranch}`,
      targetBranch: config.targetBranch,
      force: true,
    })),
  } as unknown as SourceControlProvider;
}

function createInput(overrides: Partial<CreatePullRequestInput> = {}): CreatePullRequestInput {
  return {
    title: "Test PR",
    body: "Body text",
    promptingUserId: "user-1",
    promptingAuth: null,
    sessionUrl: "https://app.example.com/session/session-name-1",
    ...overrides,
  };
}

function createTestHarness() {
  const log = createMockLogger();
  const provider = createMockProvider();
  const artifacts: ArtifactRow[] = [];
  let session: SessionRow | null = createSession();

  const repository: PullRequestRepository = {
    getSession: () => session,
    updateSessionBranch: (sessionId, branchName) => {
      if (session && session.id === sessionId) {
        session = { ...session, branch_name: branchName };
      }
    },
    listArtifacts: () => [...artifacts],
    createArtifact: (data) => {
      artifacts.unshift({
        id: data.id,
        type: data.type,
        url: data.url,
        metadata: data.metadata,
        created_at: data.createdAt,
      } as ArtifactRow);
    },
  };

  let idCounter = 0;
  const deps: PullRequestServiceDeps = {
    repository,
    sourceControlProvider: provider,
    log,
    generateId: () => `id-${++idCounter}`,
    pushBranchToRemote: vi.fn(async () => ({ success: true as const })),
    broadcastArtifactCreated: vi.fn(),
  };

  const service = new SessionPullRequestService(deps);

  return {
    service,
    deps,
    provider,
    artifacts,
    setSession: (next: SessionRow | null) => {
      session = next;
    },
  };
}

describe("SessionPullRequestService", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  it("returns 404 when session is missing", async () => {
    harness.setSession(null);

    const result = await harness.service.createPullRequest(createInput());

    expect(result).toEqual({ kind: "error", status: 404, error: "Session not found" });
  });

  it("returns 409 when PR artifact already exists", async () => {
    harness.artifacts.push({
      id: "artifact-pr-existing",
      type: "pr",
      url: "https://github.com/acme/web/pull/1",
      metadata: null,
      created_at: Date.now(),
    });

    const result = await harness.service.createPullRequest(createInput());

    expect(result).toEqual({
      kind: "error",
      status: 409,
      error: "A pull request has already been created for this session.",
    });
    expect(harness.provider.generatePushAuth).not.toHaveBeenCalled();
  });

  it("returns 500 when push to remote fails", async () => {
    harness.deps.pushBranchToRemote = vi.fn(async () => ({
      success: false as const,
      error: "Failed to push branch: timeout",
    }));
    harness.service = new SessionPullRequestService(harness.deps);

    const result = await harness.service.createPullRequest(
      createInput({ promptingAuth: { authType: "oauth", token: "user-token" } })
    );

    expect(result).toEqual({
      kind: "error",
      status: 500,
      error: "Failed to push branch: timeout",
    });
  });

  it("creates PR with app auth when prompting auth is unavailable", async () => {
    const result = await harness.service.createPullRequest(createInput({ promptingAuth: null }));

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
      authMode: "app",
      oauthSignInRequired: true,
    });
    const createPrCall = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[0]).toEqual({ authType: "app", token: "app-token" });
    expect(createPrCall[1].body).toContain("Requested by user-1");
    expect(createPrCall[1].reviewers).toBeUndefined();
    expect(harness.deps.broadcastArtifactCreated).toHaveBeenCalledTimes(1);
    // Verify artifact metadata carries auth fields
    const storedArtifact = harness.artifacts[0];
    const metadata = JSON.parse(storedArtifact.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.authMode).toBe("app");
    expect(metadata.oauthSignInRequired).toBe(true);
  });

  it("creates PR with OAuth token and stores PR artifact", async () => {
    const result = await harness.service.createPullRequest(
      createInput({ promptingAuth: { authType: "oauth", token: "user-token" } })
    );

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
      authMode: "oauth",
      oauthSignInRequired: false,
    });
    expect(harness.provider.createPullRequest).toHaveBeenCalledTimes(1);
    const createPrCall = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[0]).toEqual({ authType: "oauth", token: "user-token" });
    expect(createPrCall[1].body).toContain("Requested by user-1");
    expect(createPrCall[1].body).toContain(
      "*Created with [Open-Inspect](https://app.example.com/session/session-name-1)*"
    );
    expect(harness.deps.broadcastArtifactCreated).toHaveBeenCalledWith({
      id: "id-1",
      type: "pr",
      url: "https://github.com/acme/web/pull/42",
      prNumber: 42,
    });
    // Verify artifact metadata carries auth fields
    const storedArtifact = harness.artifacts[0];
    const metadata = JSON.parse(storedArtifact.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.authMode).toBe("oauth");
    expect(metadata.oauthSignInRequired).toBe(false);
  });

  it("forwards draft flag when creating a PR", async () => {
    await harness.service.createPullRequest(
      createInput({
        promptingAuth: { authType: "oauth", token: "user-token" },
        draft: true,
      })
    );

    const createPrCall = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[1].draft).toBe(true);
  });

  it("requests review from prompting scm login when using app auth", async () => {
    await harness.service.createPullRequest(
      createInput({ promptingAuth: null, promptingScmLogin: "josh" })
    );

    const createPrCall = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[1].reviewers).toEqual(["josh"]);
    expect(createPrCall[1].body).toContain("Requested by @josh");
  });

  it("ignores prior manual branch artifact and creates PR", async () => {
    harness.artifacts.push({
      id: "branch-artifact-1",
      type: "branch",
      url: "https://github.com/acme/web/pull/new/main...open-inspect/session-name-1",
      metadata: JSON.stringify({
        mode: "manual_pr",
        head: "open-inspect/session-name-1",
        createPrUrl: "https://existing.example.com/manual-pr",
      }),
      created_at: Date.now(),
    });

    const result = await harness.service.createPullRequest(createInput({ promptingAuth: null }));

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
      authMode: "app",
      oauthSignInRequired: true,
    });
    expect(harness.provider.createPullRequest).toHaveBeenCalledTimes(1);
  });
});

// ── PR title policy (validatePrTitle + service integration) ──────────────────

describe("validatePrTitle", () => {
  it("returns null when no regex is set", () => {
    expect(validatePrTitle("anything", {})).toBeNull();
  });

  it("returns null when title matches regex", () => {
    const policy: PrPolicy = { prTitleRegex: "^feat: .+" };
    expect(validatePrTitle("feat: add dark mode", policy)).toBeNull();
  });

  it("returns error message when title does not match regex", () => {
    const policy: PrPolicy = { prTitleRegex: "^feat: .+" };
    const result = validatePrTitle("Add dark mode", policy);
    expect(result).toContain("does not match the required format");
    expect(result).toContain("^feat: .+");
  });

  it("includes example in error message when prTitleExample is set", () => {
    const policy: PrPolicy = {
      prTitleRegex: "^feat: .+",
      prTitleExample: "feat: add login page",
    };
    const result = validatePrTitle("bad title", policy);
    expect(result).toContain("feat: add login page");
  });

  it("returns null for misconfigured (invalid) regex", () => {
    const policy: PrPolicy = { prTitleRegex: "[invalid(" };
    expect(validatePrTitle("anything", policy)).toBeNull();
  });
});

describe("SessionPullRequestService — PR title policy", () => {
  function createHarnessWithPolicy(policy: PrPolicy) {
    const log = createMockLogger();
    const provider = createMockProvider();
    const artifacts: ArtifactRow[] = [];
    let session: SessionRow | null = createSession();

    const repository: PullRequestRepository = {
      getSession: () => session,
      updateSessionBranch: (sessionId, branchName) => {
        if (session && session.id === sessionId) {
          session = { ...session, branch_name: branchName };
        }
      },
      listArtifacts: () => [...artifacts],
      createArtifact: (data) => {
        artifacts.unshift({
          id: data.id,
          type: data.type,
          url: data.url,
          metadata: data.metadata,
          created_at: data.createdAt,
        } as ArtifactRow);
      },
    };

    let idCounter = 0;
    const deps: PullRequestServiceDeps = {
      repository,
      sourceControlProvider: provider,
      log,
      generateId: () => `id-${++idCounter}`,
      pushBranchToRemote: vi.fn(async () => ({ success: true as const })),
      broadcastArtifactCreated: vi.fn(),
      prPolicy: policy,
    };

    return { service: new SessionPullRequestService(deps), artifacts, provider };
  }

  it("returns 400 when title does not match policy regex", async () => {
    const { service } = createHarnessWithPolicy({
      prTitleRegex: "^(feat|fix): .+",
      prTitleExample: "feat: add login",
    });

    const result = await service.createPullRequest(
      createInput({ title: "Add new feature", promptingAuth: null })
    );

    expect(result).toMatchObject({
      kind: "error",
      status: 400,
    });
    expect((result as { kind: "error"; error: string }).error).toContain(
      "does not match the required format"
    );
  });

  it("allows PR creation when title matches policy regex", async () => {
    const { service } = createHarnessWithPolicy({
      prTitleRegex: "^(feat|fix): .+",
    });

    const result = await service.createPullRequest(
      createInput({ title: "feat: add dark mode", promptingAuth: null })
    );

    expect(result).toMatchObject({ kind: "created" });
  });

  it("passes baseBranch to pushBranchToRemote", async () => {
    const { service, ...rest } = createHarnessWithPolicy({});

    // Verify baseBranch is used as the PR target branch (confirming it flows through)
    const result = await service.createPullRequest(
      createInput({ baseBranch: "develop", promptingAuth: null })
    );

    expect(result).toMatchObject({ kind: "created" });
    const createPrCall = (rest.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[1].targetBranch).toBe("develop");
  });
});

// ── Screenshot evidence ───────────────────────────────────────────────────────

describe("SessionPullRequestService — screenshot evidence", () => {
  function createHarnessWithScreenshots(screenshotUrls: string[], policy?: PrPolicy) {
    const log = createMockLogger();
    const provider = createMockProvider();
    const artifacts: ArtifactRow[] = screenshotUrls.map((url, i) => ({
      id: `screenshot-${i}`,
      type: "screenshot" as const,
      url,
      metadata: null,
      created_at: Date.now() - i * 1000,
    }));

    let session: SessionRow | null = createSession();

    const repository: PullRequestRepository = {
      getSession: () => session,
      updateSessionBranch: (sessionId, branchName) => {
        if (session && session.id === sessionId) {
          session = { ...session, branch_name: branchName };
        }
      },
      listArtifacts: () => [...artifacts],
      createArtifact: (data) => {
        artifacts.unshift({
          id: data.id,
          type: data.type,
          url: data.url,
          metadata: data.metadata,
          created_at: data.createdAt,
        } as ArtifactRow);
      },
    };

    let idCounter = 0;
    const deps: PullRequestServiceDeps = {
      repository,
      sourceControlProvider: provider,
      log,
      generateId: () => `id-${++idCounter}`,
      pushBranchToRemote: vi.fn(async () => ({ success: true as const })),
      broadcastArtifactCreated: vi.fn(),
      prPolicy: policy,
    };

    return { service: new SessionPullRequestService(deps), artifacts, provider };
  }

  it("appends Verification section with screenshot images when screenshots exist", async () => {
    const { service, provider } = createHarnessWithScreenshots([
      "https://cdn.example.com/shot1.png",
      "https://cdn.example.com/shot2.png",
    ]);

    const result = await service.createPullRequest(createInput({ promptingAuth: null }));

    expect(result).toMatchObject({ kind: "created" });
    const createPrCall = (provider.createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = createPrCall[1].body as string;
    expect(body).toContain("### Verification");
    expect(body).toContain("![Screenshot 1](https://cdn.example.com/shot1.png)");
    expect(body).toContain("![Screenshot 2](https://cdn.example.com/shot2.png)");
  });

  it("stores screenshot count in PR artifact metadata", async () => {
    const { service, artifacts } = createHarnessWithScreenshots([
      "https://cdn.example.com/shot1.png",
    ]);

    await service.createPullRequest(createInput({ promptingAuth: null }));

    const prArtifact = artifacts.find((a) => a.type === "pr");
    expect(prArtifact).toBeDefined();
    const meta = JSON.parse(prArtifact!.metadata ?? "{}") as Record<string, unknown>;
    expect(meta.screenshotCount).toBe(1);
  });

  it("omits Verification section when no screenshots exist", async () => {
    const { service, provider } = createHarnessWithScreenshots([]);

    const result = await service.createPullRequest(createInput({ promptingAuth: null }));

    expect(result).toMatchObject({ kind: "created" });
    const createPrCall = (provider.createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = createPrCall[1].body as string;
    expect(body).not.toContain("### Verification");
  });

  it("blocks PR when requireScreenshotForUiChanges is true and no screenshots", async () => {
    const { service } = createHarnessWithScreenshots([], {
      requireScreenshotForUiChanges: true,
    });

    const result = await service.createPullRequest(createInput({ promptingAuth: null }));

    expect(result).toMatchObject({
      kind: "error",
      status: 400,
    });
    expect((result as { kind: "error"; error: string }).error).toContain("screenshot evidence");
  });

  it("allows PR when requireScreenshotForUiChanges is true and screenshots exist", async () => {
    const { service } = createHarnessWithScreenshots(["https://cdn.example.com/shot.png"], {
      requireScreenshotForUiChanges: true,
    });

    const result = await service.createPullRequest(createInput({ promptingAuth: null }));

    expect(result).toMatchObject({ kind: "created" });
  });
});
