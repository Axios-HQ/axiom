import { DurableObject } from "cloudflare:workers";
import {
  LinearClient,
  OrchestratorController,
  OrchestratorObservability,
  OrchestratorEventLogger,
  logOrchestratorSnapshot,
  getEffectiveConfig,
  parseWorkflowFile,
  renderPromptTemplate,
  type EffectiveWorkflowConfig,
  type Issue,
  type OrchestratorState,
  type WorkflowDefinition,
} from "@open-inspect/shared";
import { generateId } from "../auth/crypto";
import { SessionIndexStore } from "../db/session-index";
import { createLogger, parseLogLevel } from "../logger";
import type { Logger } from "../logger";
import type { Env } from "../types";

const DEFAULT_ORCHESTRATOR_NAME = "global-symphony-orchestrator";

interface RepoContext {
  repoOwner: string;
  repoName: string;
  repoId: number;
  baseBranch: string;
  userId: string;
  model: string;
}

interface ConfigureRequest {
  workflowContent: string;
  repoOwner: string;
  repoName: string;
  repoId: number;
  baseBranch?: string;
  userId?: string;
  model?: string;
}

interface RunCompleteRequest {
  issueId: string;
  issueIdentifier?: string;
  sessionId?: string;
  success: boolean;
  error?: string;
}

interface SymphonyCallbackContext {
  source: "symphony";
  issueId: string;
  issueIdentifier: string;
}

interface PersistedRuntime {
  workflow: WorkflowDefinition;
  effectiveConfig: EffectiveWorkflowConfig;
  repoContext: RepoContext;
  state: SerializedOrchestratorState;
}

interface SerializedOrchestratorState extends Omit<OrchestratorState, "claimed" | "completed"> {
  claimed: string[];
  completed: string[];
}

export class SymphonyOrchestratorDO extends DurableObject<Env> {
  private readonly log: Logger;
  private readonly controller: OrchestratorController;
  private workflow: WorkflowDefinition | null = null;
  private effectiveConfig: EffectiveWorkflowConfig | null = null;
  private repoContext: RepoContext | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.log = createLogger("symphony-orchestrator", {}, parseLogLevel(env.LOG_LEVEL));
    this.controller = new OrchestratorController();
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/internal/configure") {
      return this.handleConfigure(request);
    }

    if (request.method === "POST" && path === "/internal/tick") {
      return this.handleTick();
    }

    if (
      request.method === "POST" &&
      (path === "/internal/run-complete" || path === "/internal/symphony/run-complete")
    ) {
      return this.handleRunComplete(request);
    }

    if (request.method === "GET" && path === "/internal/state") {
      return this.handleState();
    }

    if (request.method === "GET" && path === "/internal/health") {
      return this.handleHealth();
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.ensureLoaded();
    if (!this.isConfigured()) {
      return;
    }

    await this.runCycle();
    await this.scheduleNextTick();
  }

  private async handleConfigure(request: Request): Promise<Response> {
    let body: ConfigureRequest;
    try {
      body = (await request.json()) as ConfigureRequest;
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.workflowContent || typeof body.workflowContent !== "string") {
      return Response.json({ error: "workflowContent is required" }, { status: 400 });
    }

    if (!body.repoOwner || !body.repoName || typeof body.repoId !== "number") {
      return Response.json(
        { error: "repoOwner, repoName, and repoId are required" },
        { status: 400 }
      );
    }

    const parsed = parseWorkflowFile(body.workflowContent);
    if ("type" in parsed) {
      const message = "message" in parsed ? parsed.message : "invalid workflow";
      return Response.json({ error: `${parsed.type}: ${message}` }, { status: 400 });
    }

    const effectiveConfig = getEffectiveConfig(parsed.config);
    const policyValidation = validateCodexPolicies(effectiveConfig);
    if (!policyValidation.ok) {
      return Response.json({ error: policyValidation.error }, { status: 400 });
    }

    const configureResult = this.controller.setWorkflow(parsed, effectiveConfig);
    if (!configureResult.ok) {
      return Response.json({ error: configureResult.error }, { status: 400 });
    }

    this.workflow = parsed;
    this.effectiveConfig = effectiveConfig;
    this.repoContext = {
      repoOwner: body.repoOwner.toLowerCase(),
      repoName: body.repoName.toLowerCase(),
      repoId: body.repoId,
      baseBranch: body.baseBranch || "main",
      userId: body.userId || "symphony",
      model: body.model || "anthropic/claude-sonnet-4-6",
    };

    await this.persistRuntime();
    await this.scheduleNextTick();

    this.log.info("Symphony orchestrator configured", {
      event: "symphony.configured",
      repo: `${this.repoContext.repoOwner}/${this.repoContext.repoName}`,
      project_slug: this.effectiveConfig.tracker.project_slug,
      poll_interval_ms: this.effectiveConfig.polling.interval_ms,
    });

    return Response.json({
      ok: true,
      pollIntervalMs: this.effectiveConfig.polling.interval_ms,
      maxConcurrentAgents: this.effectiveConfig.agent.max_concurrent_agents,
    });
  }

  private async handleTick(): Promise<Response> {
    if (!this.isConfigured()) {
      return Response.json({ error: "orchestrator is not configured" }, { status: 400 });
    }

    const result = await this.runCycle();
    return Response.json(result);
  }

  private async handleRunComplete(request: Request): Promise<Response> {
    if (!this.isConfigured()) {
      return Response.json({ error: "orchestrator is not configured" }, { status: 400 });
    }

    let body: RunCompleteRequest;
    try {
      body = (await request.json()) as RunCompleteRequest;
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.issueId || typeof body.success !== "boolean") {
      return Response.json({ error: "issueId and success are required" }, { status: 400 });
    }

    const state = this.controller.getState();
    const running = state.running[body.issueId];
    if (!running) {
      return Response.json({ ok: true, ignored: true });
    }

    if (body.sessionId && running.session_id && running.session_id !== body.sessionId) {
      return Response.json({ ok: true, ignored: true, reason: "session_mismatch" });
    }

    this.controller.reportWorkerExit(
      body.issueId,
      body.success ? "success" : "failure",
      this.effectiveConfig!.agent.max_retry_backoff_ms,
      body.error
    );
    await this.persistStateOnly();

    return Response.json({ ok: true });
  }

  private async handleState(): Promise<Response> {
    const state = this.controller.getState();
    const snapshot = logOrchestratorSnapshot(state);

    return Response.json({
      configured: this.isConfigured(),
      workflowProjectSlug: this.effectiveConfig?.tracker.project_slug ?? null,
      timestamp: Date.now(),
      // Orchestrator state snapshot
      snapshot: this.controller.getSnapshot(),
      // Observability metrics
      observability: {
        ...snapshot,
        codexTotals: state.codex_totals,
        pollIntervalMs: state.poll_interval_ms,
        maxConcurrentAgents: state.max_concurrent_agents,
      },
      // Issue queues
      queues: {
        running: Object.keys(state.running),
        claimed: Array.from(state.claimed),
        retrying: Object.keys(state.retry_attempts),
        completed: Array.from(state.completed),
      },
      // Retry queue details
      retries: Object.entries(state.retry_attempts).map(([issueId, entry]) => ({
        issueId,
        identifier: entry.identifier,
        attempt: entry.attempt,
        dueAtMs: entry.due_at_ms,
      })),
    });
  }

  private async handleHealth(): Promise<Response> {
    const state = this.controller.getState();
    return Response.json({
      status: this.isConfigured() ? "healthy" : "not_configured",
      running: Object.keys(state.running).length,
      retrying: Object.keys(state.retry_attempts).length,
    });
  }

  private async runCycle(): Promise<{ dispatched: number; retried: number; running: number }> {
    const effectiveConfig = this.effectiveConfig!;
    const obs = new OrchestratorObservability();
    const cycleStartTime = Date.now();

    const linear = new LinearClient(
      effectiveConfig.tracker.api_key,
      effectiveConfig.tracker.endpoint
    );

    // Fetch active candidates
    const candidates = await this.fetchAllActiveCandidates(linear, effectiveConfig);
    const candidateMap = new Map(candidates.map((issue) => [issue.id, issue]));

    this.log.info("Symphony cycle: fetched candidates", {
      event: "symphony.candidates_fetched",
      candidate_count: candidates.length,
    });

    // Process retries
    const retryResult = this.controller.processRetries(
      {
        active_states: effectiveConfig.tracker.active_states,
        agent: {
          max_concurrent_agents: effectiveConfig.agent.max_concurrent_agents,
          max_concurrent_agents_by_state: effectiveConfig.agent.max_concurrent_agents_by_state,
        },
      },
      (issueId) => candidateMap.get(issueId) || null
    );

    for (const retry of retryResult.toRetry) {
      obs.recordRetryProcessed(
        retry.issue.id,
        Date.now(),
        retry.retry_attempt,
        0 // backoff already applied internally
      );
    }

    // Process new dispatches
    const tickResult = this.controller.processTick(candidates, {
      active_states: effectiveConfig.tracker.active_states,
      terminal_states: effectiveConfig.tracker.terminal_states,
      agent: {
        max_concurrent_agents: effectiveConfig.agent.max_concurrent_agents,
        max_concurrent_agents_by_state: effectiveConfig.agent.max_concurrent_agents_by_state,
      },
    });

    for (const issue of tickResult.toDispatch) {
      obs.recordDispatchCheck(issue.id, true);
      await this.dispatchIssue(issue, null);
    }

    for (const retry of retryResult.toRetry) {
      await this.dispatchIssue(retry.issue, retry.retry_attempt);
    }

    // Reconcile running issues
    await this.reconcileRunningIssues(linear);
    await this.persistStateOnly();

    // Log cycle completion with metrics
    const cycleDuration = Date.now() - cycleStartTime;
    const stats = obs.getSummary();
    const snapshot = logOrchestratorSnapshot(this.controller.getState());

    this.log.info("Symphony cycle completed", {
      event: "symphony.cycle_completed",
      duration_ms: cycleDuration,
      dispatched: tickResult.toDispatch.length,
      retried: retryResult.toRetry.length,
      running: Object.keys(this.controller.getState().running).length,
      stats,
      snapshot,
    });

    return {
      dispatched: tickResult.toDispatch.length,
      retried: retryResult.toRetry.length,
      running: Object.keys(this.controller.getState().running).length,
    };
  }

  private async dispatchIssue(issue: Issue, attempt: number | null): Promise<void> {
    const dispatchStartTime = Date.now();
    const logger = new OrchestratorEventLogger({
      issueId: issue.id,
      attempt: attempt ?? undefined,
    });

    try {
      this.log.info("Dispatching symphony issue", {
        ...logger.dispatchStarted({ issue_identifier: issue.identifier }),
      });

      const { sessionId } = await this.createSessionForIssue(issue);
      await this.sendPromptToSession(issue, sessionId, attempt);

      const dispatchDuration = Date.now() - dispatchStartTime;
      const state = this.controller.getState();
      const running = state.running[issue.id];
      if (running) {
        running.session_id = sessionId;
      }

      this.log.info("Symphony issue dispatched successfully", {
        ...logger.dispatchSuccess(sessionId, {
          duration_ms: dispatchDuration,
          attempt: attempt ?? 1,
        }),
      });
    } catch (errorValue) {
      const errorMessage = errorValue instanceof Error ? errorValue.message : String(errorValue);
      const dispatchDuration = Date.now() - dispatchStartTime;

      this.log.error("Failed to dispatch symphony issue", {
        ...logger.dispatchFailed(errorMessage, {
          duration_ms: dispatchDuration,
        }),
      });

      this.controller.reportWorkerExit(
        issue.id,
        "failure",
        this.effectiveConfig!.agent.max_retry_backoff_ms,
        errorMessage
      );
    }
  }

  private async createSessionForIssue(issue: Issue): Promise<{ sessionId: string }> {
    const repoContext = this.repoContext!;
    const sessionId = generateId();
    const doId = this.env.SESSION.idFromName(sessionId);
    const stub = this.env.SESSION.get(doId);

    const initResponse = await stub.fetch("http://internal/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName: sessionId,
        repoOwner: repoContext.repoOwner,
        repoName: repoContext.repoName,
        repoId: repoContext.repoId,
        defaultBranch: repoContext.baseBranch,
        model: repoContext.model,
        title: `[Symphony] ${issue.identifier}: ${issue.title}`,
        userId: repoContext.userId,
        spawnSource: "automation",
      }),
    });

    if (!initResponse.ok) {
      throw new Error(`Session init failed with status ${initResponse.status}`);
    }

    const now = Date.now();
    const sessionStore = new SessionIndexStore(this.env.DB);
    await sessionStore.create({
      id: sessionId,
      title: `[Symphony] ${issue.identifier}: ${issue.title}`,
      repoOwner: repoContext.repoOwner,
      repoName: repoContext.repoName,
      model: repoContext.model,
      reasoningEffort: null,
      baseBranch: repoContext.baseBranch,
      status: "created",
      spawnSource: "automation",
      spawnDepth: 0,
      createdAt: now,
      updatedAt: now,
    });

    return { sessionId };
  }

  private async sendPromptToSession(
    issue: Issue,
    sessionId: string,
    attempt: number | null
  ): Promise<void> {
    const workflow = this.workflow!;
    const rendered = renderPromptTemplate(workflow.prompt_template, issue, attempt);
    if (!rendered.ok) {
      throw new Error(`Prompt template render failed: ${rendered.error.type}`);
    }

    const callbackContext: SymphonyCallbackContext = {
      source: "symphony",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
    };

    const doId = this.env.SESSION.idFromName(sessionId);
    const stub = this.env.SESSION.get(doId);
    const promptResponse = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: rendered.prompt,
        authorId: this.repoContext!.userId,
        source: "symphony",
        callbackContext,
      }),
    });

    if (!promptResponse.ok) {
      throw new Error(`Prompt enqueue failed with status ${promptResponse.status}`);
    }
  }

  private async reconcileRunningIssues(linear: LinearClient): Promise<void> {
    const runningIssueIds = Object.keys(this.controller.getState().running);
    if (runningIssueIds.length === 0) {
      return;
    }

    const rows = await linear.fetchIssueStatesByIds(runningIssueIds);
    const issueStates = new Map(rows.map((row) => [row.id, row.state]));

    this.controller.reconcileRunning(issueStates, {
      active_states: this.effectiveConfig!.tracker.active_states,
      terminal_states: this.effectiveConfig!.tracker.terminal_states,
    });
  }

  private async fetchAllActiveCandidates(
    linear: LinearClient,
    config: EffectiveWorkflowConfig
  ): Promise<Issue[]> {
    const issues: Issue[] = [];
    let endCursor: string | undefined;

    for (;;) {
      const page = await linear.fetchCandidateIssues(
        config.tracker.project_slug,
        config.tracker.active_states,
        50,
        endCursor
      );
      issues.push(...page.issues);
      if (!page.hasMore || !page.endCursor) {
        break;
      }
      endCursor = page.endCursor;
    }

    return issues;
  }

  private isConfigured(): boolean {
    return this.workflow !== null && this.effectiveConfig !== null && this.repoContext !== null;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromStorage();
    }
    await this.loadPromise;
  }

  private async loadFromStorage(): Promise<void> {
    const runtime = await this.ctx.storage.get<PersistedRuntime>("runtime");
    if (!runtime) {
      return;
    }

    this.workflow = runtime.workflow;
    this.effectiveConfig = runtime.effectiveConfig;
    this.repoContext = runtime.repoContext;
    this.controller.setWorkflow(this.workflow, this.effectiveConfig);
    this.replaceControllerState(deserializeState(runtime.state));
  }

  private replaceControllerState(state: OrchestratorState): void {
    const target = this.controller.getState();
    target.poll_interval_ms = state.poll_interval_ms;
    target.max_concurrent_agents = state.max_concurrent_agents;
    target.running = state.running;
    target.claimed = state.claimed;
    target.retry_attempts = state.retry_attempts;
    target.completed = state.completed;
    target.codex_totals = state.codex_totals;
    target.codex_rate_limits = state.codex_rate_limits;
  }

  private async persistRuntime(): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }

    const payload: PersistedRuntime = {
      workflow: this.workflow!,
      effectiveConfig: this.effectiveConfig!,
      repoContext: this.repoContext!,
      state: serializeState(this.controller.getState()),
    };
    await this.ctx.storage.put("runtime", payload);
  }

  private async persistStateOnly(): Promise<void> {
    const runtime = await this.ctx.storage.get<PersistedRuntime>("runtime");
    if (!runtime) {
      return;
    }

    runtime.state = serializeState(this.controller.getState());
    await this.ctx.storage.put("runtime", runtime);
  }

  private async scheduleNextTick(): Promise<void> {
    if (!this.effectiveConfig) {
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + this.effectiveConfig.polling.interval_ms);
  }
}

function serializeState(state: OrchestratorState): SerializedOrchestratorState {
  return {
    ...state,
    claimed: [...state.claimed],
    completed: [...state.completed],
  };
}

function deserializeState(state: SerializedOrchestratorState): OrchestratorState {
  return {
    ...state,
    claimed: new Set(state.claimed),
    completed: new Set(state.completed),
  };
}

export const SYMPHONY_ORCHESTRATOR_NAME = DEFAULT_ORCHESTRATOR_NAME;

function validateCodexPolicies(
  config: EffectiveWorkflowConfig
): { ok: true } | { ok: false; error: string } {
  const approval = config.codex.approval_policy;
  const threadSandbox = config.codex.thread_sandbox;
  const turnSandboxPolicy = config.codex.turn_sandbox_policy;

  const validApprovals = new Set(["never", "on-failure", "on-request", "untrusted", "on", "off"]);
  const validThreadSandboxes = new Set(["read-only", "workspace-write", "danger-full-access"]);
  const validTurnPolicies = new Set(["allow-network", "deny-network", "allow", "deny"]);

  if (approval !== null && !validApprovals.has(approval)) {
    return { ok: false, error: `Unsupported approval policy: ${approval}` };
  }

  if (threadSandbox !== null && !validThreadSandboxes.has(threadSandbox)) {
    return { ok: false, error: `Unsupported thread sandbox: ${threadSandbox}` };
  }

  if (turnSandboxPolicy !== null && !validTurnPolicies.has(turnSandboxPolicy)) {
    return { ok: false, error: `Unsupported turn sandbox policy: ${turnSandboxPolicy}` };
  }

  return { ok: true };
}
