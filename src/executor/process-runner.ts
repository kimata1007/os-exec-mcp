import { spawn, type ChildProcessByStdio } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";

import type { Logger } from "../observability/logger.js";
import { OutputBuffer } from "./output-buffer.js";
import { ExecutionLimiter, ExecutionLimiterError } from "./execution-limiter.js";
import type { OutputArtifactStore } from "./output-artifact-store.js";
import { terminateProcessTree } from "./process-tree.js";
import type { CommandResult, PreparedCommand } from "./types.js";

type CombinedSignal = {
  signal: AbortSignal;
  cleanup: () => void;
};

function combineSignals(signals: readonly AbortSignal[]): CombinedSignal {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();

  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = (): void => {
      abortFrom(signal);
    };
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      listeners.forEach((listener, signal) => {
        signal.removeEventListener("abort", listener);
      });
    },
  };
}

function durationSince(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function spawnErrorResult(
  commandId: string,
  startedAt: number,
  error: unknown,
): CommandResult {
  return {
    id: commandId,
    status: "spawn_error",
    exit_code: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    duration_ms: durationSince(startedAt),
    error: error instanceof Error ? error.message : "Failed to spawn executable",
    rejection_reason: null,
    global_queue_wait_ms: 0,
  };
}

export class ProcessRunner {
  readonly #shutdownController = new AbortController();
  readonly #active = new Set<Promise<CommandResult>>();

  public constructor(
    private readonly logger: Logger,
    private readonly limiter = new ExecutionLimiter(16),
    private readonly artifactStore?: OutputArtifactStore,
    private readonly persistedOutputMaximumBytes = 0,
  ) {}

  public get globalPeakConcurrency(): number {
    return this.limiter.peak;
  }

  public run(command: PreparedCommand, signal?: AbortSignal): Promise<CommandResult> {
    const signals = [
      this.#shutdownController.signal,
      ...(signal === undefined ? [] : [signal]),
    ];
    const combined = combineSignals(signals);
    const running = this.#runLimited(command, combined.signal).finally(
      combined.cleanup,
    );
    this.#active.add(running);
    void running.finally(() => {
      this.#active.delete(running);
    });
    return running;
  }

  public async shutdown(): Promise<void> {
    if (!this.#shutdownController.signal.aborted) {
      this.#shutdownController.abort(new Error("Server is shutting down"));
    }
    await Promise.allSettled([...this.#active]);
  }

  async #runLimited(
    command: PreparedCommand,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    let permit;
    try {
      permit = await this.limiter.acquire(signal);
    } catch (error) {
      if (error instanceof ExecutionLimiterError) {
        return {
          id: command.id,
          status: "cancelled",
          exit_code: null,
          signal: null,
          stdout: "",
          stderr: "",
          stdout_bytes: 0,
          stderr_bytes: 0,
          stdout_truncated: false,
          stderr_truncated: false,
          duration_ms: 0,
          error: error.message,
          rejection_reason: null,
          global_queue_wait_ms: 0,
        };
      }
      throw error;
    }
    try {
      const result = await this.#run(command, signal);
      return { ...result, global_queue_wait_ms: permit.queueWaitMs };
    } finally {
      permit.release();
    }
  }

  async #run(command: PreparedCommand, signal: AbortSignal): Promise<CommandResult> {
    const startedAt = performance.now();
    if (signal.aborted) {
      return {
        id: command.id,
        status: "cancelled",
        exit_code: null,
        signal: null,
        stdout: "",
        stderr: "",
        stdout_bytes: 0,
        stderr_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        duration_ms: 0,
        error: "Command cancelled before it started",
        rejection_reason: null,
        global_queue_wait_ms: 0,
      };
    }

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        detached: process.platform !== "win32",
        env: command.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      return spawnErrorResult(command.id, startedAt, error);
    }

    this.logger.debug("command_started", {
      command_id: command.id,
      executable: command.executable,
      timeout: command.timeoutMs,
    });

    const stdout = new OutputBuffer(
      command.maxOutputBytes,
      command.outputCapture,
      command.stripAnsi,
      this.persistedOutputMaximumBytes,
    );
    const stderr = new OutputBuffer(
      command.maxOutputBytes,
      command.outputCapture,
      command.stripAnsi,
      this.persistedOutputMaximumBytes,
    );

    return await new Promise<CommandResult>((resolve) => {
      let completed = false;
      let termination: "timeout" | "cancelled" | undefined;

      child.stdout.on("data", (chunk: Buffer) => {
        stdout.append(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.append(chunk);
      });

      const requestTermination = (reason: "timeout" | "cancelled"): void => {
        if (termination === undefined) {
          termination = reason;
          terminateProcessTree(child, this.logger, command.id);
        }
      };

      const abortListener = (): void => {
        requestTermination("cancelled");
      };
      signal.addEventListener("abort", abortListener, { once: true });

      const timeout = setTimeout(() => {
        requestTermination("timeout");
      }, command.timeoutMs);
      timeout.unref();

      const finish = (
        exitCode: number | null,
        exitSignal: NodeJS.Signals | null,
        spawnError?: unknown,
      ): void => {
        if (completed) {
          return;
        }
        completed = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortListener);

        const capturedStdout = stdout.result();
        const capturedStderr = stderr.result();
        const status =
          spawnError !== undefined
            ? "spawn_error"
            : termination === "timeout"
              ? "timeout"
              : termination === "cancelled"
                ? "cancelled"
                : exitCode === 0
                  ? "success"
                  : "failed";
        const error =
          spawnError !== undefined
            ? spawnError instanceof Error
              ? spawnError.message
              : "Failed to spawn executable"
            : status === "timeout"
              ? `Command exceeded timeout of ${command.timeoutMs} ms`
              : status === "cancelled"
                ? "Command was cancelled"
                : null;
        const stdoutResource =
          capturedStdout.persistedText === undefined || this.artifactStore === undefined
            ? undefined
            : this.artifactStore.put(
                capturedStdout.persistedText,
                capturedStdout.totalBytes,
                capturedStdout.persistedTruncated ?? false,
              );
        const stderrResource =
          capturedStderr.persistedText === undefined || this.artifactStore === undefined
            ? undefined
            : this.artifactStore.put(
                capturedStderr.persistedText,
                capturedStderr.totalBytes,
                capturedStderr.persistedTruncated ?? false,
              );

        const result: CommandResult = {
          id: command.id,
          status,
          exit_code: exitCode,
          signal: exitSignal,
          stdout: capturedStdout.text,
          stderr: capturedStderr.text,
          stdout_bytes: capturedStdout.totalBytes,
          stderr_bytes: capturedStderr.totalBytes,
          stdout_truncated: capturedStdout.truncated,
          stderr_truncated: capturedStderr.truncated,
          duration_ms: durationSince(startedAt),
          error,
          rejection_reason: null,
          global_queue_wait_ms: 0,
          ...(stdoutResource === undefined ? {} : { stdout_resource: stdoutResource }),
          ...(stderrResource === undefined ? {} : { stderr_resource: stderrResource }),
        };

        this.logger.info("command_finished", {
          command_id: command.id,
          executable: command.executable,
          status,
          exit_code: exitCode,
          duration_ms: result.duration_ms,
          timeout: status === "timeout",
          stdout_bytes: result.stdout_bytes,
          stderr_bytes: result.stderr_bytes,
          truncated: result.stdout_truncated || result.stderr_truncated,
        });
        resolve(result);
      };

      child.once("error", (error) => {
        finish(null, null, error);
      });
      child.once("close", (exitCode, exitSignal) => {
        finish(exitCode, exitSignal);
      });
    });
  }
}
