/**
 * Linear tracker client adapter
 * Compliant with Symphony spec Section 11
 */

import type { CandidateIssuesResult, Issue, IssueBlocker } from "./types/symphony";

/**
 * Linear GraphQL endpoint and pagination defaults
 */
const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_PAGE_SIZE = 50;
const NETWORK_TIMEOUT_MS = 30000;

interface LinearQueryResult {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

/**
 * Linear tracker client
 * Handles GraphQL queries against Linear API
 */
export class LinearClient {
  private endpoint: string;
  private apiKey: string;

  constructor(apiKey: string, endpoint?: string) {
    this.apiKey = apiKey;
    this.endpoint = endpoint || DEFAULT_LINEAR_ENDPOINT;
  }

  /**
   * Fetch candidate issues in active states
   * Spec: Section 11.2 - Candidate issue query
   */
  async fetchCandidateIssues(
    projectSlug: string,
    activeStates: string[],
    pageSize: number = DEFAULT_PAGE_SIZE,
    endCursor?: string
  ): Promise<CandidateIssuesResult> {
    const query = `
      query FetchCandidateIssues($projectSlug: String!, $states: [String!]!, $pageSize: Int!, $after: String) {
        issues(
          filter: {
            project: { slugId: { eq: $projectSlug } }
            state: { name: { in: $states } }
          }
          first: $pageSize
          after: $after
          orderBy: { createdAt: StartOfDay }
        ) {
          nodes {
            id
            identifier
            title
            description
            priority
            state { name }
            branchName
            url
            labels(first: 100) {
              nodes {
                name
              }
            }
            relations(first: 100) {
              nodes {
                relatedIssue {
                  id
                  identifier
                  state { name }
                }
                type
              }
            }
            createdAt
            updatedAt
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const variables = {
      projectSlug,
      states: activeStates,
      pageSize,
      after: endCursor || null,
    };

    const result = await this.query(query, variables);

    if (!result.data || !("issues" in result.data)) {
      throw new Error("Invalid Linear API response: missing issues field");
    }

    const issuesData = (result.data as Record<string, unknown>).issues as Record<string, unknown>;
    const issuesNodes = issuesData.nodes as unknown[];
    const issues = issuesNodes.map((node) => normalizeLinearIssue(node));

    const pageInfo = issuesData.pageInfo as Record<string, unknown>;
    return {
      issues,
      hasMore: pageInfo.hasNextPage as boolean,
      endCursor: (pageInfo.endCursor as string) || undefined,
    };
  }

  /**
   * Fetch issue states by IDs for reconciliation
   * Spec: Section 11.2 - Issue state refresh query
   */
  async fetchIssueStatesByIds(issueIds: string[]): Promise<{ id: string; state: string }[]> {
    if (issueIds.length === 0) {
      return [];
    }

    const query = `
      query FetchIssueStates($ids: [ID!]!) {
        issues(filter: { id: { in: $ids } }) {
          nodes {
            id
            state { name }
          }
        }
      }
    `;

    const variables = { ids: issueIds };
    const result = await this.query(query, variables);

    if (!result.data || !("issues" in result.data)) {
      throw new Error("Invalid Linear API response: missing issues field");
    }

    const issuesData = (result.data as Record<string, unknown>).issues as Record<string, unknown>;
    const issuesNodes = issuesData.nodes as Array<{ id: string; state: { name: string } }>;

    return issuesNodes.map((node) => ({
      id: node.id,
      state: node.state.name,
    }));
  }

  /**
   * Fetch issues in terminal states for startup cleanup
   * Spec: Section 8.6 - Startup Terminal Workspace Cleanup
   */
  async fetchIssuesByStates(
    projectSlug: string,
    states: string[],
    pageSize: number = DEFAULT_PAGE_SIZE,
    endCursor?: string
  ): Promise<CandidateIssuesResult> {
    if (states.length === 0) {
      return { issues: [], hasMore: false };
    }

    const query = `
      query FetchIssuesByStates($projectSlug: String!, $states: [String!]!, $pageSize: Int!, $after: String) {
        issues(
          filter: {
            project: { slugId: { eq: $projectSlug } }
            state: { name: { in: $states } }
          }
          first: $pageSize
          after: $after
        ) {
          nodes {
            id
            identifier
            title
            description
            priority
            state { name }
            branchName
            url
            labels(first: 100) {
              nodes {
                name
              }
            }
            relations(first: 100) {
              nodes {
                relatedIssue {
                  id
                  identifier
                  state { name }
                }
                type
              }
            }
            createdAt
            updatedAt
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const variables = {
      projectSlug,
      states,
      pageSize,
      after: endCursor || null,
    };

    const result = await this.query(query, variables);

    if (!result.data || !("issues" in result.data)) {
      throw new Error("Invalid Linear API response: missing issues field");
    }

    const issuesData = (result.data as Record<string, unknown>).issues as Record<string, unknown>;
    const issuesNodes = issuesData.nodes as unknown[];
    const issues = issuesNodes.map((node) => normalizeLinearIssue(node));

    const pageInfo = issuesData.pageInfo as Record<string, unknown>;
    return {
      issues,
      hasMore: pageInfo.hasNextPage as boolean,
      endCursor: (pageInfo.endCursor as string) || undefined,
    };
  }

  /**
   * Execute a GraphQL query against Linear API
   */
  private async query(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<LinearQueryResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          query,
          variables,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
      }

      const result = (await response.json()) as LinearQueryResult;

      if (result.errors && result.errors.length > 0) {
        throw new Error(`Linear GraphQL error: ${result.errors.map((e) => e.message).join(", ")}`);
      }

      return result;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error) {
        if (err.name === "AbortError") {
          throw new Error(`Linear API request timeout (${NETWORK_TIMEOUT_MS}ms)`);
        }
        throw err;
      }
      throw new Error(`Linear API request failed: ${String(err)}`);
    }
  }
}

/**
 * Normalize Linear issue from API response to internal Issue model
 * Spec: Section 11.3 - Normalization Rules
 */
function normalizeLinearIssue(node: unknown): Issue {
  const nodeData = node as Record<string, unknown>;

  const labels = (
    ((nodeData.labels as Record<string, unknown>)?.nodes as Array<{ name: string }>) || []
  ).map((label) => label.name.toLowerCase());

  // Extract blockers from relations (inverse of "blocks" relation type)
  const blockedBy: IssueBlocker[] = [];
  const relations =
    ((nodeData.relations as Record<string, unknown>)?.nodes as Array<{
      type: string;
      relatedIssue?: { id: string; identifier: string; state?: { name: string } };
    }>) || [];

  for (const relation of relations) {
    if (relation.type === "blocks" && relation.relatedIssue) {
      blockedBy.push({
        id: relation.relatedIssue.id || null,
        identifier: relation.relatedIssue.identifier || null,
        state: relation.relatedIssue.state?.name || null,
      });
    }
  }

  // Parse priority (Linear typically uses 0-4, where lower is higher)
  let priority: number | null = null;
  if (nodeData.priority !== null && nodeData.priority !== undefined) {
    const parsed = Number(nodeData.priority);
    priority = Number.isNaN(parsed) ? null : parsed;
  }

  // Parse timestamps
  const createdAt = nodeData.createdAt ? new Date(nodeData.createdAt as string).getTime() : null;
  const updatedAt = nodeData.updatedAt ? new Date(nodeData.updatedAt as string).getTime() : null;

  const state = nodeData.state as Record<string, unknown> | undefined;

  return {
    id: String(nodeData.id),
    identifier: String(nodeData.identifier),
    title: String(nodeData.title),
    description: (nodeData.description as string) || null,
    priority,
    state: (state?.name as string) || "",
    branch_name: (nodeData.branchName as string) || null,
    url: (nodeData.url as string) || null,
    labels,
    blocked_by: blockedBy,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}
