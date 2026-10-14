import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { HistoryRequest } from "./history-helper.js";

/** Serialized, bounded local-process protocol; a failed worker is retried on the
 * next request. System Node must be installed; Electron is never used as Node. */
export class HistoryHelperClient {
  private child: ChildProcess | null = null;
  private nextId = 0;
  private pendingCount = 0;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private cancel: (() => void) | null = null;
  constructor(
    private readonly options: {
      nodeBinary?: string;
      helperPath?: string;
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {}

  request<T>(request: HistoryRequest): Promise<T> {
    if (this.disposed || this.pendingCount >= 16)
      return Promise.reject(new Error("History helper unavailable"));
    this.pendingCount++;
    const result = this.queue
      .then(() => this.run<T>(request))
      .finally(() => {
        this.pendingCount--;
      });
    this.queue = result.catch(() => {});
    return result;
  }
  private run<T>(request: HistoryRequest): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("History helper disposed"));
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child =
          (this.child?.connected ? this.child : null) ??
          fork(
            this.options.helperPath ??
              fileURLToPath(new URL("./history-helper.js", import.meta.url)).replace(
                /([\\/])app\.asar([\\/])/u,
                "$1app.asar.unpacked$2",
              ),
            [],
            {
              execPath: this.options.nodeBinary ?? process.env.OPENCODE_QUOTA_NODE_BINARY ?? "node",
              execArgv: [],
              env: { ...process.env, ...this.options.env, ELECTRON_RUN_AS_NODE: undefined },
              stdio: ["ignore", "ignore", "ignore", "ipc"],
            },
          );
        this.child = child;
      } catch {
        reject(new Error("Local history helper unavailable"));
        return;
      }
      const id = ++this.nextId;
      let settled = false;
      const finish = (error?: Error, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onError);
        this.cancel = null;
        if (error) {
          if (this.child === child) this.child = null;
          child.kill();
          reject(error);
        } else resolve(result as T);
      };
      const onError = () => finish(new Error("Local history helper unavailable"));
      const onMessage = (message: { id: number; error?: string; result?: T }) => {
        if (message.id !== id) return;
        finish(
          message.error ? new Error("Local history helper unavailable") : undefined,
          message.result,
        );
      };
      const timer = setTimeout(
        () => finish(new Error("Local history helper timed out")),
        this.options.timeoutMs ?? 10_000,
      );
      this.cancel = onError;
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("exit", onError);
      try {
        child.send({ id, request }, (error) => {
          if (error) onError();
        });
      } catch {
        onError();
      }
    });
  }
  dispose(): void {
    this.disposed = true;
    this.cancel?.();
    this.child?.kill();
    this.child = null;
  }
}
