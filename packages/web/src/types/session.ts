import type { SandboxEvent as SharedSandboxEvent } from "@open-inspect/shared";

// Session-related type definitions

export interface Artifact {
  id: string;
  type: "pr" | "screenshot" | "preview" | "branch";
  url: string | null;
  metadata?: {
    prNumber?: number;
    prState?: "open" | "merged" | "closed" | "draft";
    mode?: "manual_pr";
    createPrUrl?: string;
    head?: string;
    base?: string;
    provider?: string;
    filename?: string;
    /** Status of a preview/code-server service. */
    previewStatus?: "active" | "outdated" | "stopped";
    /** Human-readable label for preview artifacts (e.g. "frontend", "code-server"). */
    label?: string;
    /** Repo attribution for multi-repo sessions. */
    repo?: string;
    /** Marks the artifact as a code-server link. */
    kind?: "code_server";
    /** Last update timestamp for preview artifacts. */
    updatedAt?: number;
  };
  createdAt: number;
}

export type SandboxEvent = SharedSandboxEvent;

export interface Task {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface FileChange {
  filename: string;
  additions: number;
  deletions: number;
}
