import { describe, expect, it } from "vitest";
import { buildCompletionBlocks } from "./blocks";
import type { AgentResponse, SlackCallbackContext } from "../types";

const BASE_CONTEXT: SlackCallbackContext = {
  source: "slack",
  channel: "C123",
  threadTs: "1234567890.123456",
  repoFullName: "octocat/hello-world",
  model: "anthropic/claude-haiku-4-5",
};

const BASE_RESPONSE: AgentResponse = {
  textContent: "Done.",
  toolCalls: [],
  artifacts: [],
  success: true,
};

function getActionElements(
  blocks: ReturnType<typeof buildCompletionBlocks>
): Array<Record<string, unknown>> {
  const actionsBlock = blocks.find((block) => block.type === "actions");
  if (!actionsBlock || !actionsBlock.elements) {
    return [];
  }
  return actionsBlock.elements as Array<Record<string, unknown>>;
}

describe("buildCompletionBlocks", () => {
  it("renders only View Session when there are no artifacts", () => {
    const blocks = buildCompletionBlocks(
      "session-123",
      BASE_RESPONSE,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const actionElements = getActionElements(blocks);

    expect(actionElements).toHaveLength(1);
    expect(actionElements[0]?.action_id).toBe("view_session");
  });

  it("adds Create PR button for manual PR branch artifacts", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "branch",
          url: "https://github.com/octocat/hello-world/pull/new/main...open-inspect%2Fsession-123",
          label: "Branch: open-inspect/session-123",
          metadata: {
            mode: "manual_pr",
            createPrUrl:
              "https://github.com/octocat/hello-world/pull/new/main...open-inspect%2Fsession-123",
          },
        },
      ],
    };

    const blocks = buildCompletionBlocks(
      "session-123",
      response,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const actionElements = getActionElements(blocks);
    const createPrButton = actionElements.find((element) => element.action_id === "create_pr");

    expect(createPrButton).toBeDefined();
    expect(createPrButton?.url).toBe(
      "https://github.com/octocat/hello-world/pull/new/main...open-inspect%2Fsession-123"
    );
  });

  it("does not add Create PR button when a PR artifact exists", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "branch",
          url: "https://github.com/octocat/hello-world/pull/new/main...open-inspect%2Fsession-123",
          label: "Branch: open-inspect/session-123",
          metadata: {
            mode: "manual_pr",
            createPrUrl:
              "https://github.com/octocat/hello-world/pull/new/main...open-inspect%2Fsession-123",
          },
        },
        {
          type: "pr",
          url: "https://github.com/octocat/hello-world/pull/99",
          label: "PR #99",
          metadata: { number: 99 },
        },
      ],
    };

    const blocks = buildCompletionBlocks(
      "session-123",
      response,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const actionElements = getActionElements(blocks);
    const createPrButton = actionElements.find((element) => element.action_id === "create_pr");

    expect(createPrButton).toBeUndefined();
  });

  it("adds GitHub sign-in CTA when PR used app auth", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "pr",
          url: "https://github.com/octocat/hello-world/pull/99",
          label: "PR #99",
          metadata: { number: 99, oauthSignInRequired: true },
        },
      ],
    };

    const blocks = buildCompletionBlocks(
      "session-123",
      response,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const actionElements = getActionElements(blocks);
    const signInButton = actionElements.find((element) => element.action_id === "signin_github");

    expect(signInButton).toBeDefined();
    expect(signInButton?.url).toBe("https://app.openinspect.dev/api/auth/signin/github");
  });

  it("does not add Create PR button for non-manual branch artifacts", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "branch",
          url: "https://github.com/octocat/hello-world/tree/feature-branch",
          label: "Branch: feature-branch",
          metadata: {
            mode: "auto_branch",
            createPrUrl: "https://github.com/octocat/hello-world/pull/new/main...feature-branch",
          },
        },
      ],
    };

    const blocks = buildCompletionBlocks(
      "session-123",
      response,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const actionElements = getActionElements(blocks);
    const createPrButton = actionElements.find((element) => element.action_id === "create_pr");

    expect(createPrButton).toBeUndefined();
  });

  it("adds a screenshot context block when screenshot artifacts are present", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "screenshot",
          url: "https://example.com/screenshot1.png",
          label: "Homepage after changes",
        },
        {
          type: "screenshot",
          url: "https://example.com/screenshot2.png",
          label: "Settings page",
        },
      ],
    };

    const blocks = buildCompletionBlocks(
      "session-123",
      response,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const screenshotContextBlocks = blocks.filter(
      (b) =>
        b.type === "context" &&
        b.elements?.some(
          (element) => element.type === "mrkdwn" && element.text === "2 screenshots shared above"
        )
    );

    expect(screenshotContextBlocks).toHaveLength(1);
  });

  it("uses singular screenshot copy when exactly one screenshot artifact is present", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "screenshot",
          url: "https://example.com/screenshot.png",
          label: "",
        },
      ],
    };

    const blocks = buildCompletionBlocks(
      "session-123",
      response,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const screenshotContextBlocks = blocks.filter(
      (b) =>
        b.type === "context" &&
        b.elements?.some(
          (element) => element.type === "mrkdwn" && element.text === "1 screenshot shared above"
        )
    );

    expect(screenshotContextBlocks).toHaveLength(1);
  });

  it("does not include screenshot context when there are no screenshot artifacts", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "pr",
          url: "https://github.com/octocat/hello-world/pull/42",
          label: "PR #42",
          metadata: { number: 42 },
        },
      ],
    };

    const blocks = buildCompletionBlocks(
      "session-123",
      response,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const screenshotContextBlocks = blocks.filter(
      (b) =>
        b.type === "context" &&
        b.elements?.some(
          (element) =>
            element.type === "mrkdwn" &&
            typeof element.text === "string" &&
            element.text.includes("screenshot")
        )
    );

    expect(screenshotContextBlocks).toHaveLength(0);
  });

  it("falls back to branch artifact URL when createPrUrl is missing", () => {
    const fallbackUrl = "https://github.com/octocat/hello-world/pull/new/main...feature-branch";
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "branch",
          url: fallbackUrl,
          label: "Branch: feature-branch",
          metadata: {
            mode: "manual_pr",
          },
        },
      ],
    };

    const blocks = buildCompletionBlocks(
      "session-123",
      response,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const actionElements = getActionElements(blocks);
    const createPrButton = actionElements.find((element) => element.action_id === "create_pr");

    expect(createPrButton).toBeDefined();
    expect(createPrButton?.url).toBe(fallbackUrl);
  });
});
