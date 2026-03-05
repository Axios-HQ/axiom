import { generateBranchName } from "@open-inspect/shared";
import type { Logger } from "../logger";
import { resolveHeadBranchForPr } from "../source-control/branch-resolution";
import {
  SourceControlProviderError,
  type SourceControlProvider,
  type SourceControlAuthContext,
  type GitPushAuthContext,
  type GitPushSpec,
} from "../source-control";
import type { ArtifactRow, SessionRow } from "./types";

/**
 * Inputs required to create a PR once caller identity/auth are already resolved.
 */
export interface CreatePullRequestInput {
  title: string;
  body: string;
  baseBranch?: string;
  headBranch?: string;
  draft?: boolean;
  promptingUserId: string;
  promptingScmLogin?: string | null;
  promptingScmName?: string | null;
  promptingAuth: SourceControlAuthContext | null;
  sessionUrl: string;
}

export type CreatePullRequestResult =
  | {
      kind: "created";
      prNumber: number;
      prUrl: string;
      state: "open" | "closed" | "merged" | "draft";
      authMode: "oauth" | "app";
      oauthSignInRequired: boolean;
    }
  | { kind: "error"; status: number; error: string };

export type PushBranchResult = { success: true } | { success: false; error: string };

/**
 * PR policy configuration resolved from integration/repo settings.
 * All fields are optional — missing or undefined means no enforcement.
 */
export interface PrPolicy {
  /**
   * Regex pattern that the PR title must match.
   * Example: "^(feat|fix|chore|docs|refactor|test)(\\(.+\\))?: .+"
   */
  prTitleRegex?: string | null;
  /**
   * Human-readable example of a valid title shown in rejection errors.
   */
  prTitleExample?: string | null;
  /**
   * When true, PR creation is blocked if no screenshot artifact exists and
   * the changed files include paths matching uiFileGlobs.
   */
  requireScreenshotForUiChanges?: boolean;
  /**
   * Glob patterns used to detect UI file changes.
   * Defaults to common UI patterns when requireScreenshotForUiChanges is true.
   */
  uiFileGlobs?: string[];
}

/**
 * Session persistence operations required by pull request orchestration.
 */
export interface PullRequestRepository {
  getSession(): SessionRow | null;
  updateSessionBranch(sessionId: string, branchName: string): void;
  listArtifacts(): ArtifactRow[];
  createArtifact(data: {
    id: string;
    type: "pr" | "branch" | "screenshot";
    url: string | null;
    metadata: string | null;
    createdAt: number;
  }): void;
}

/**
 * Durable-object adapters that bridge runtime concerns into the service.
 */
export interface PullRequestServiceDeps {
  repository: PullRequestRepository;
  sourceControlProvider: SourceControlProvider;
  log: Logger;
  generateId: () => string;
  pushBranchToRemote: (
    headBranch: string,
    pushSpec: GitPushSpec,
    baseBranch?: string
  ) => Promise<PushBranchResult>;
  broadcastArtifactCreated: (artifact: {
    id: string;
    type: "pr" | "branch";
    url: string;
    prNumber?: number;
  }) => void;
  /** Optional PR policy resolved for the target repo. */
  prPolicy?: PrPolicy | null;
}

/**
 * Validates a PR title against the policy regex.
 * Returns null when valid, or an error string when invalid.
 */
export function validatePrTitle(title: string, policy: PrPolicy): string | null {
  if (!policy.prTitleRegex) return null;

  let regex: RegExp;
  try {
    regex = new RegExp(policy.prTitleRegex);
  } catch {
    // Misconfigured regex — don't block PR creation
    return null;
  }

  if (!regex.test(title)) {
    const example = policy.prTitleExample ? ` Example: "${policy.prTitleExample}"` : "";
    return `PR title does not match the required format (pattern: ${policy.prTitleRegex}).${example}`;
  }
  return null;
}

/**
 * Builds a Markdown Verification section from screenshot artifact URLs.
 */
function buildVerificationSection(screenshotUrls: string[]): string {
  if (screenshotUrls.length === 0) return "";

  const lines = ["", "---", "### Verification", ""];
  screenshotUrls.forEach((url, i) => {
    lines.push(`![Screenshot ${i + 1}](${url})`);
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * Orchestrates branch push and PR creation for a session.
 * Participant lookup and token resolution are handled by SessionDO.
 */
export class SessionPullRequestService {
  constructor(private readonly deps: PullRequestServiceDeps) {}

  private formatRequesterIdentity(input: CreatePullRequestInput): string {
    if (input.promptingScmLogin && input.promptingScmLogin.trim().length > 0) {
      return `@${input.promptingScmLogin.trim()}`;
    }

    if (input.promptingScmName && input.promptingScmName.trim().length > 0) {
      return input.promptingScmName.trim();
    }

    return input.promptingUserId;
  }

  /**
   * Creates a pull request when OAuth auth is available, or falls back
   * to a manual PR URL artifact when user OAuth cannot be used.
   */
  async createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    const session = this.deps.repository.getSession();
    if (!session) {
      return { kind: "error", status: 404, error: "Session not found" };
    }

    this.deps.log.info("Creating PR", { user_id: input.promptingUserId });

    try {
      // --- C) PR title policy validation ---
      const policy = this.deps.prPolicy;
      if (policy?.prTitleRegex) {
        const titleError = validatePrTitle(input.title, policy);
        if (titleError) {
          this.deps.log.warn("pr.title_policy_rejected", {
            title: input.title,
            regex: policy.prTitleRegex,
          });
          return { kind: "error", status: 400, error: titleError };
        }
      }

      const sessionId = session.session_name || session.id;
      const generatedHeadBranch = generateBranchName(sessionId);

      const initialArtifacts = this.deps.repository.listArtifacts();
      const existingPrArtifact = initialArtifacts.find((artifact) => artifact.type === "pr");
      if (existingPrArtifact) {
        return {
          kind: "error",
          status: 409,
          error: "A pull request has already been created for this session.",
        };
      }

      // --- B) Screenshot policy enforcement ---
      // Collect screenshot artifacts for PR body injection and policy checks.
      const screenshotArtifacts = initialArtifacts.filter((a) => a.type === "screenshot" && a.url);
      const screenshotUrls = screenshotArtifacts.map((a) => a.url as string);

      if (policy?.requireScreenshotForUiChanges && screenshotUrls.length === 0) {
        this.deps.log.warn("pr.screenshot_policy_rejected", {
          session_id: session.id,
        });
        return {
          kind: "error",
          status: 400,
          error:
            "PR creation blocked: this repository requires screenshot evidence for UI changes. " +
            "Use the send-update tool with a screenshotPath to capture proof-of-work before creating the PR.",
        };
      }

      let pushAuth: GitPushAuthContext;
      try {
        pushAuth = await this.deps.sourceControlProvider.generatePushAuth();
        this.deps.log.info("Generated fresh push auth token");
      } catch (error) {
        this.deps.log.error("Failed to generate push auth", {
          error: error instanceof Error ? error : String(error),
        });
        return {
          kind: "error",
          status: 500,
          error:
            error instanceof SourceControlProviderError
              ? error.message
              : "Failed to generate push authentication",
        };
      }

      const appAuth: SourceControlAuthContext = {
        authType: "app",
        token: pushAuth.token,
      };

      const repoInfo = await this.deps.sourceControlProvider.getRepository(appAuth, {
        owner: session.repo_owner,
        name: session.repo_name,
      });
      const baseBranch = input.baseBranch || repoInfo.defaultBranch;
      const branchResolution = resolveHeadBranchForPr({
        requestedHeadBranch: input.headBranch,
        sessionBranchName: session.branch_name,
        generatedBranchName: generatedHeadBranch,
        baseBranch,
      });
      const headBranch = branchResolution.headBranch;
      this.deps.log.info("Resolved PR head branch", {
        requested_head_branch: input.headBranch ?? null,
        session_branch_name: session.branch_name,
        generated_head_branch: generatedHeadBranch,
        resolved_head_branch: headBranch,
        resolution_source: branchResolution.source,
        base_branch: baseBranch,
      });
      const pushSpec = this.deps.sourceControlProvider.buildGitPushSpec({
        owner: session.repo_owner,
        name: session.repo_name,
        sourceRef: "HEAD",
        targetBranch: headBranch,
        auth: pushAuth,
        force: true,
      });

      const pushResult = await this.deps.pushBranchToRemote(headBranch, pushSpec, baseBranch);
      if (!pushResult.success) {
        return { kind: "error", status: 500, error: pushResult.error };
      }

      this.deps.repository.updateSessionBranch(session.id, headBranch);

      const latestArtifacts = this.deps.repository.listArtifacts();
      const latestPrArtifact = latestArtifacts.find((artifact) => artifact.type === "pr");
      if (latestPrArtifact) {
        return {
          kind: "error",
          status: 409,
          error: "A pull request has already been created for this session.",
        };
      }

      // Use user OAuth if available, otherwise fall back to GitHub App token
      // (e.g. sessions triggered from Linear or other integrations without user GitHub OAuth)
      const prAuth = input.promptingAuth ?? appAuth;

      const requesterIdentity = this.formatRequesterIdentity(input);

      // Build the PR body: user body + verification screenshots + footer
      const verificationSection = buildVerificationSection(screenshotUrls);
      const fullBody =
        input.body +
        verificationSection +
        `\n\n---\nRequested by ${requesterIdentity}\n\n*Created with [Open-Inspect](${input.sessionUrl})*`;

      if (screenshotUrls.length > 0) {
        this.deps.log.info("pr.screenshot_evidence_appended", {
          screenshot_count: screenshotUrls.length,
        });
      }

      const reviewers =
        prAuth.authType === "app" && input.promptingScmLogin
          ? [input.promptingScmLogin]
          : undefined;

      const prResult = await this.deps.sourceControlProvider.createPullRequest(prAuth, {
        repository: repoInfo,
        title: input.title,
        body: fullBody,
        sourceBranch: headBranch,
        targetBranch: baseBranch,
        draft: input.draft,
        reviewers,
      });

      const artifactId = this.deps.generateId();
      const now = Date.now();
      if (prAuth.authType !== "oauth" && prAuth.authType !== "app") {
        return {
          kind: "error",
          status: 500,
          error: `Unexpected auth type: ${String(prAuth.authType)}`,
        };
      }
      const authMode: "oauth" | "app" = prAuth.authType;
      const oauthSignInRequired = authMode === "app";
      this.deps.repository.createArtifact({
        id: artifactId,
        type: "pr",
        url: prResult.webUrl,
        metadata: JSON.stringify({
          number: prResult.id,
          state: prResult.state,
          head: headBranch,
          base: baseBranch,
          authMode,
          oauthSignInRequired,
          screenshotCount: screenshotUrls.length,
        }),
        createdAt: now,
      });

      this.deps.broadcastArtifactCreated({
        id: artifactId,
        type: "pr",
        url: prResult.webUrl,
        prNumber: prResult.id,
      });

      return {
        kind: "created",
        prNumber: prResult.id,
        prUrl: prResult.webUrl,
        state: prResult.state,
        authMode,
        oauthSignInRequired,
      };
    } catch (error) {
      this.deps.log.error("PR creation failed", {
        error: error instanceof Error ? error : String(error),
      });

      if (error instanceof SourceControlProviderError) {
        return {
          kind: "error",
          status: error.httpStatus || 500,
          error: error.message,
        };
      }

      return {
        kind: "error",
        status: 500,
        error: error instanceof Error ? error.message : "Failed to create PR",
      };
    }
  }
}
