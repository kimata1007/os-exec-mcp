import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { ProgramExecutionError } from "./errors.js";
import type {
  HostToWorkerMessage,
  ProgramHostExecutor,
  ProgramRuntime,
  ProgramRuntimeInput,
  WorkerToHostMessage,
} from "./types.js";

function publicWorkerError(error: unknown): string {
  const message =
    error instanceof Error ? error.message.slice(0, 4096) : "Program worker failed";
  return message
    .replace(/[A-Za-z]:\\(?:[^\\\s:'"]+\\)*[^\\\s:'"]+/g, "<path>")
    .replace(/\/(?:[^/\s:'"]+\/)*[^/\s:'"]+/g, "<path>");
}

function workerUrl(): URL {
  const adjacent = new URL("./quickjs-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(adjacent))) {
    return adjacent;
  }
  return pathToFileURL(path.resolve("dist/program/quickjs-worker.js"));
}

export class QuickJsProgramRuntime implements ProgramRuntime {
  public async run(
    input: ProgramRuntimeInput,
    execute: ProgramHostExecutor,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted === true) {
      throw new ProgramExecutionError(
        "cancelled",
        "Program was cancelled before it started",
      );
    }

    const memoryMb = Math.max(16, Math.ceil(input.memoryBytes / (1024 * 1024)));
    const worker = new Worker(workerUrl(), {
      workerData: input,
      resourceLimits: {
        maxOldGenerationSizeMb: memoryMb,
        maxYoungGenerationSizeMb: Math.max(4, Math.min(16, Math.floor(memoryMb / 4))),
        stackSizeMb: 4,
      },
    });

    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortListener);
        callback();
      };
      const fail = (error: ProgramExecutionError): void => {
        settle(() => {
          reject(error);
          void worker.terminate();
        });
      };
      const abortListener = (): void => {
        fail(new ProgramExecutionError("cancelled", "Program execution was cancelled"));
      };
      signal?.addEventListener("abort", abortListener, { once: true });

      const timeout = setTimeout(() => {
        fail(
          new ProgramExecutionError(
            "timeout",
            `Program exceeded timeout of ${input.timeoutMs} ms`,
          ),
        );
      }, input.timeoutMs);
      timeout.unref();

      worker.on("message", (untrusted: WorkerToHostMessage) => {
        if (settled) {
          return;
        }
        if (untrusted.type === "result") {
          settle(() => {
            resolve(untrusted.value);
            void worker.terminate();
          });
          return;
        }
        if (untrusted.type === "error") {
          const code =
            untrusted.code === "memory_limit"
              ? "memory_limit"
              : untrusted.code === "timeout"
                ? "timeout"
                : "execution_failed";
          fail(new ProgramExecutionError(code, untrusted.message));
          return;
        }

        void executeFromWorker(untrusted);
      });

      const executeFromWorker = async (
        message: Extract<WorkerToHostMessage, { type: "exec_request" }>,
      ): Promise<void> => {
        let response: HostToWorkerMessage;
        try {
          const result = await execute(
            message.argv as string[],
            message.options as { cwd?: string; timeout_ms?: number },
          );
          response = { type: "exec_response", id: message.id, result };
        } catch (error) {
          response = {
            type: "exec_error",
            id: message.id,
            message: publicWorkerError(error),
          };
        }
        if (!settled) {
          worker.postMessage(response);
        }
      };

      worker.once("error", (error) => {
        fail(new ProgramExecutionError("execution_failed", publicWorkerError(error)));
      });
      worker.once("exit", (code) => {
        if (!settled) {
          fail(
            new ProgramExecutionError(
              code === 0 ? "execution_failed" : "memory_limit",
              code === 0
                ? "Program worker exited before returning a result"
                : "Program worker terminated, possibly after exceeding its memory limit",
            ),
          );
        }
      });
    });
  }
}
