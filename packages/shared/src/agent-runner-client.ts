import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RunnerInitializeResult,
  toRunnerInitializeParams,
  type RunnerPolicyConfig,
} from "./agent-runner-protocol";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000;

export interface AgentRunnerClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  policy: RunnerPolicyConfig;
  handshakeTimeoutMs?: number;
  onNotification?: (notification: JsonRpcNotification) => void;
}

export class AgentRunnerClient {
  private readonly options: AgentRunnerClientOptions;
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private notificationQueue: JsonRpcNotification[] = [];
  private notificationWaiters: Array<(notification: JsonRpcNotification) => void> = [];

  constructor(options: AgentRunnerClientOptions) {
    this.options = options;
  }

  async launch(): Promise<RunnerInitializeResult> {
    if (this.process) {
      throw new Error("Agent runner already launched");
    }

    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env,
      },
      stdio: "pipe",
    });
    this.process = child;

    child.on("exit", (code, signal) => {
      const reason = `Agent runner exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.rejectAll(reason);
      this.process = null;
    });

    child.on("error", (error) => {
      this.rejectAll(`Agent runner process error: ${error.message}`);
    });

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      this.handleOutputLine(line);
    });

    const initializeResult = await this.request<RunnerInitializeResult>("initialize", {
      clientName: "open-inspect",
      ...toRunnerInitializeParams(this.options.policy),
    });

    return initializeResult;
  }

  async shutdown(): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }

    await this.notify("shutdown", {});
    child.kill("SIGTERM");
    this.process = null;
  }

  async request<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams
  ): Promise<TResult> {
    const child = this.process;
    if (!child) {
      throw new Error("Agent runner is not launched");
    }

    const id = this.nextId;
    this.nextId += 1;
    const payload: JsonRpcRequest<TParams> = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const timeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out for method ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as TResult);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async notify<TParams = unknown>(method: string, params?: TParams): Promise<void> {
    const child = this.process;
    if (!child) {
      throw new Error("Agent runner is not launched");
    }

    const payload: JsonRpcNotification<TParams> = {
      jsonrpc: "2.0",
      method,
      params,
    };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleOutputLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: JsonRpcResponse | JsonRpcNotification;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      return;
    }

    if ("id" in parsed) {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }

      this.pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message));
        return;
      }

      pending.resolve(parsed.result);
      return;
    }

    this.options.onNotification?.(parsed);
    const waiter = this.notificationWaiters.shift();
    if (waiter) {
      waiter(parsed);
      return;
    }
    this.notificationQueue.push(parsed);
  }

  async waitForNotification(timeoutMs?: number): Promise<JsonRpcNotification> {
    if (this.notificationQueue.length > 0) {
      return this.notificationQueue.shift() as JsonRpcNotification;
    }

    return new Promise<JsonRpcNotification>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const handler = (notification: JsonRpcNotification) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(notification);
      };

      this.notificationWaiters.push(handler);

      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          const index = this.notificationWaiters.indexOf(handler);
          if (index >= 0) {
            this.notificationWaiters.splice(index, 1);
          }
          reject(new Error("Timed out waiting for JSON-RPC notification"));
        }, timeoutMs);
      }
    });
  }

  private rejectAll(reason: string): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
