import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

let idCounter = 0;
vi.mock("../auth/crypto", () => ({
  generateId: vi.fn(() => {
    idCounter += 1;
    return `sess-${idCounter}`;
  }),
}));

const { SymphonyOrchestratorDO } = await import("./durable-object");

function createCtx() {
  const data = new Map<string, unknown>();
  return {
    id: {
      toString: () => "global-symphony-orchestrator",
    },
    storage: {
      get: vi.fn(async (key: string) => data.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        data.set(key, value);
      }),
      setAlarm: vi.fn(async () => {}),
    },
  } as unknown as DurableObjectState;
}

function createSessionStub(): DurableObjectStub {
  return {
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url).pathname;
      if (path === "/internal/init") {
        return Response.json({ ok: true });
      }
      if (path === "/internal/prompt") {
        return Response.json({ ok: true });
      }
      return new Response("Not Found", { status: 404 });
    }),
  } as never;
}

function createEnv(overrides?: Partial<Env>): Env {
  const sessionStub = createSessionStub();
  const db = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      }),
    }),
  } as unknown as D1Database;
  return {
    DB: db,
    SESSION: {
      idFromName: vi.fn().mockReturnValue("session-do-id"),
      get: vi.fn().mockReturnValue(sessionStub),
    } as unknown as DurableObjectNamespace,
    DEPLOYMENT_NAME: "test",
    TOKEN_ENCRYPTION_KEY: "key",
    ...overrides,
  } as Env;
}

function createWorkflow(content?: string): string {
  return (
    content ??
    `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: TEST
  active_states: [Todo, In Progress]
  terminal_states: [Done]
polling:
  interval_ms: 5000
agent:
  max_concurrent_agents: 2
---
Fix issue {{ issue.identifier }}: {{ issue.title }}
`
  );
}

function mockLinearFetch(options: {
  candidates: Array<{ id: string; identifier: string; title: string; state: string }>;
  statesById?: Record<string, string>;
}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query: string;
      variables: Record<string, unknown>;
    };

    if (body.query.includes("FetchCandidateIssues")) {
      return Response.json({
        data: {
          issues: {
            nodes: options.candidates.map((issue) => ({
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              description: "",
              priority: 2,
              state: { name: issue.state },
              branchName: null,
              url: null,
              labels: { nodes: [] },
              relations: { nodes: [] },
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }

    if (body.query.includes("FetchIssueStates")) {
      const ids = (body.variables.ids ?? []) as string[];
      return Response.json({
        data: {
          issues: {
            nodes: ids.map((id) => ({
              id,
              state: { name: options.statesById?.[id] ?? "Todo" },
            })),
          },
        },
      });
    }

    return Response.json({ data: {} });
  });
}

describe("SymphonyOrchestratorDO", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    idCounter = 0;
  });

  it("configures orchestrator from workflow content", async () => {
    const orchestrator = new SymphonyOrchestratorDO(createCtx(), createEnv());
    const response = await orchestrator.fetch(
      new Request("http://internal/internal/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowContent: createWorkflow(),
          repoOwner: "Axios-HQ",
          repoName: "axiom",
          repoId: 123,
        }),
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ ok: boolean; pollIntervalMs: number }>();
    expect(body.ok).toBe(true);
    expect(body.pollIntervalMs).toBe(5000);
  });

  it("dispatches one issue when global concurrency is 1", async () => {
    mockLinearFetch({
      candidates: [
        { id: "issue-1", identifier: "PROJ-1", title: "First", state: "Todo" },
        { id: "issue-2", identifier: "PROJ-2", title: "Second", state: "Todo" },
      ],
    });

    const workflow = createWorkflow(`---
tracker:
  kind: linear
  api_key: test-key
  project_slug: TEST
  active_states: [Todo]
  terminal_states: [Done]
agent:
  max_concurrent_agents: 1
---
Run {{ issue.identifier }}
`);

    const orchestrator = new SymphonyOrchestratorDO(createCtx(), createEnv());
    await orchestrator.fetch(
      new Request("http://internal/internal/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowContent: workflow,
          repoOwner: "axios-hq",
          repoName: "axiom",
          repoId: 123,
        }),
      })
    );

    const tick = await orchestrator.fetch(
      new Request("http://internal/internal/tick", { method: "POST" })
    );
    const tickBody = await tick.json<{ dispatched: number; running: number }>();

    expect(tickBody.dispatched).toBe(1);
    expect(tickBody.running).toBe(1);
  });

  it("schedules retry on failed run completion and dispatches retry when due", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T00:00:00.000Z"));

    mockLinearFetch({
      candidates: [{ id: "issue-1", identifier: "PROJ-1", title: "First", state: "Todo" }],
    });

    const orchestrator = new SymphonyOrchestratorDO(createCtx(), createEnv());
    await orchestrator.fetch(
      new Request("http://internal/internal/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowContent: createWorkflow(),
          repoOwner: "axios-hq",
          repoName: "axiom",
          repoId: 123,
        }),
      })
    );

    await orchestrator.fetch(new Request("http://internal/internal/tick", { method: "POST" }));

    await orchestrator.fetch(
      new Request("http://internal/internal/symphony/run-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: "issue-1", success: false, error: "runner failed" }),
      })
    );

    vi.setSystemTime(new Date("2026-03-06T00:00:10.500Z"));
    const retryTick = await orchestrator.fetch(
      new Request("http://internal/internal/tick", { method: "POST" })
    );
    const retryBody = await retryTick.json<{ retried: number }>();
    expect(retryBody.retried).toBe(1);

    vi.useRealTimers();
  });

  it("reconciles running issues when issue enters terminal state", async () => {
    mockLinearFetch({
      candidates: [{ id: "issue-1", identifier: "PROJ-1", title: "First", state: "Todo" }],
      statesById: { "issue-1": "Done" },
    });

    const orchestrator = new SymphonyOrchestratorDO(createCtx(), createEnv());
    await orchestrator.fetch(
      new Request("http://internal/internal/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowContent: createWorkflow(),
          repoOwner: "axios-hq",
          repoName: "axiom",
          repoId: 123,
        }),
      })
    );

    const tick = await orchestrator.fetch(
      new Request("http://internal/internal/tick", { method: "POST" })
    );
    const body = await tick.json<{ running: number }>();
    expect(body.running).toBe(0);
  });
});
