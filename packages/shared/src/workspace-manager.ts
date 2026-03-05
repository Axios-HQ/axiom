/**
 * Workspace manager for orchestrating workspace lifecycle
 * Compliant with Symphony spec Section 9
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import type { Workspace } from "./types/symphony";

/**
 * Sanitize workspace key from issue identifier
 * Spec: Section 4.2 - Workspace Key - only [A-Za-z0-9._-] allowed
 */
export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Options for workspace creation
 */
export interface WorkspaceCreateOptions {
  rootPath: string;
  afterCreateHook?: string;
  hooksTimeoutMs?: number;
}

/**
 * Workspace manager
 * Handles per-issue workspace creation, reuse, and lifecycle
 */
export class WorkspaceManager {
  private rootPath: string;
  private afterCreateHook?: string;
  private beforeRunHook?: string;
  private afterRunHook?: string;
  private beforeRemoveHook?: string;
  private hooksTimeoutMs: number;

  constructor(
    options: WorkspaceCreateOptions & {
      beforeRunHook?: string;
      afterRunHook?: string;
      beforeRemoveHook?: string;
    }
  ) {
    this.rootPath = options.rootPath;
    this.afterCreateHook = options.afterCreateHook;
    this.beforeRunHook = options.beforeRunHook;
    this.afterRunHook = options.afterRunHook;
    this.beforeRemoveHook = options.beforeRemoveHook;
    this.hooksTimeoutMs = options.hooksTimeoutMs || 60000;

    // Ensure root directory exists
    this.ensureDirectory(this.rootPath);
  }

  /**
   * Create or reuse workspace for an issue
   * Spec: Section 9.2 - Workspace Creation and Reuse
   */
  async createWorkspace(issueIdentifier: string): Promise<Workspace | { error: string }> {
    try {
      const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
      const workspacePath = path.join(this.rootPath, workspaceKey);

      // Check if workspace path stays within root (safety invariant)
      const resolvedPath = path.resolve(workspacePath);
      const resolvedRoot = path.resolve(this.rootPath);

      if (!resolvedPath.startsWith(resolvedRoot)) {
        return {
          error: "Workspace path would escape root directory",
        };
      }

      // Check if workspace exists
      const exists = fs.existsSync(workspacePath);

      if (exists && !fs.statSync(workspacePath).isDirectory()) {
        return {
          error: `Path exists but is not a directory: ${workspacePath}`,
        };
      }

      // Create directory if needed
      const createdNow = !exists;
      if (createdNow) {
        fs.mkdirSync(workspacePath, { recursive: true });
      }

      // Run after_create hook only on new workspaces
      if (createdNow && this.afterCreateHook) {
        const hookResult = await this.runHook(this.afterCreateHook, workspacePath, "after_create");

        if (!hookResult.ok) {
          // Clean up partially created workspace on after_create failure
          try {
            fs.rmSync(workspacePath, { recursive: true, force: true });
          } catch (err) {
            console.error(`Failed to clean up workspace after hook failure: ${err}`);
          }
          return { error: `after_create hook failed: ${hookResult.error}` };
        }
      }

      return {
        path: resolvedPath,
        workspace_key: workspaceKey,
        created_now: createdNow,
      };
    } catch (err) {
      return {
        error: `Failed to create workspace: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Run before_run hook
   * Spec: Section 9.4 - before_run hook execution
   * Failure is fatal to the current run attempt
   */
  async runBeforeRunHook(
    workspacePath: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.beforeRunHook) {
      return { ok: true };
    }

    return this.runHook(this.beforeRunHook, workspacePath, "before_run");
  }

  /**
   * Run after_run hook
   * Spec: Section 9.4 - after_run hook execution
   * Failure is logged but ignored
   */
  async runAfterRunHook(workspacePath: string): Promise<void> {
    if (!this.afterRunHook) {
      return;
    }

    const result = await this.runHook(this.afterRunHook, workspacePath, "after_run");
    if (!result.ok) {
      console.warn(`after_run hook failed (ignored): ${result.error}`);
    }
  }

  /**
   * Clean up workspace
   * Spec: Section 9.4 - before_remove hook and workspace deletion
   */
  async cleanupWorkspace(
    workspaceKey: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const workspacePath = path.join(this.rootPath, workspaceKey);

      // Check path safety
      const resolvedPath = path.resolve(workspacePath);
      const resolvedRoot = path.resolve(this.rootPath);

      if (!resolvedPath.startsWith(resolvedRoot)) {
        return {
          ok: false,
          error: "Workspace path would escape root directory",
        };
      }

      if (!fs.existsSync(workspacePath)) {
        return { ok: true }; // Already gone
      }

      // Run before_remove hook
      if (this.beforeRemoveHook) {
        const hookResult = await this.runHook(
          this.beforeRemoveHook,
          workspacePath,
          "before_remove"
        );
        if (!hookResult.ok) {
          console.warn(`before_remove hook failed (ignored): ${hookResult.error}`);
        }
      }

      // Delete workspace directory
      fs.rmSync(workspacePath, { recursive: true, force: true });

      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: `Failed to clean up workspace: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Run a hook script in the workspace
   * Spec: Section 9.4 - Workspace Hooks
   */
  private async runHook(
    script: string,
    cwd: string,
    hookName: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      try {
        const command = `bash -lc '${script.replace(/'/g, "'\\''")}'`;

        // Set up timeout
        const timeout = setTimeout(() => {
          console.error(`${hookName} hook timed out after ${this.hooksTimeoutMs}ms`);
          resolve({
            ok: false,
            error: `Hook timeout after ${this.hooksTimeoutMs}ms`,
          });
        }, this.hooksTimeoutMs);

        try {
          execSync(command, {
            cwd,
            stdio: "pipe",
            timeout: this.hooksTimeoutMs,
          });
          clearTimeout(timeout);
          resolve({ ok: true });
        } catch (err) {
          clearTimeout(timeout);
          const errorMsg = err instanceof Error ? err.message : String(err);
          resolve({
            ok: false,
            error: `Hook execution failed: ${errorMsg}`,
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        resolve({
          ok: false,
          error: `Failed to run hook: ${errorMsg}`,
        });
      }
    });
  }

  /**
   * Ensure a directory exists
   */
  private ensureDirectory(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Get workspace path for issue
   */
  getWorkspacePath(issueIdentifier: string): string {
    const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
    return path.resolve(path.join(this.rootPath, workspaceKey));
  }

  /**
   * Validate workspace path is within root
   * Spec: Section 9.5 - Safety Invariant 2
   */
  validateWorkspacePathSafety(workspacePath: string): boolean {
    const resolvedPath = path.resolve(workspacePath);
    const resolvedRoot = path.resolve(this.rootPath);
    return resolvedPath.startsWith(resolvedRoot + path.sep) || resolvedPath === resolvedRoot;
  }
}
