import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { RuntimePolicy } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import { CommandPolicyEvaluator } from "../policy/command-policy.js";
import { PolicyRejectionError } from "../policy/errors.js";
import { validateBatchInput } from "../validation/batch-input.js";
import { ProcessRunner } from "./process-runner.js";
import type {
  BatchExecResult,
  BatchSummary,
  CommandResult,
  CommandStatus,
} from "./types.js";

type StopReason = "external_cancellation" | "fail_fast" | "internal_error";

function syntheticResult(
  id: string,
  status: "cancelled" | "skipped" | "rejected",
  error: string,
  rejectionReason: string | null = null,
): CommandResult {
  return {
    id,
    status,
    exit_code: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    duration_ms: 0,
    error,
    rejection_reason: rejectionReason,
  };
}

function statusCount(results: readonly CommandResult[], status: CommandStatus): number {
  return results.filter((result) => result.status === status).length;
}

function createSummary(
  results: readonly CommandResult[],
  wallTimeMs: number,
  effectiveConcurrency: number,
): BatchSummary {
  return {
    total: results.length,
    succeeded: statusCount(results, "success"),
    failed: statusCount(results, "failed") + statusCount(results, "spawn_error"),
    timed_out: statusCount(results, "timeout"),
    cancelled: statusCount(results, "cancelled"),
    skipped: statusCount(results, "skipped"),
    rejected: statusCount(results, "rejected"),
    spawn_errors: statusCount(results, "spawn_error"),
    wall_time_ms: wallTimeMs,
    effective_concurrency: effectiveConcurrency,
  };
}

function isFailure(result: CommandResult): boolean {
  return result.status !== "success";
}

export class BatchExecutor {
  readonly #policyEvaluator: CommandPolicyEvaluator;
  readonly #processRunner: ProcessRunner;

  public constructor(
    private readonly policy: RuntimePolicy,
    private readonly logger: Logger,
    processRunner?: ProcessRunner,
  ) {
    this.#policyEvaluator = new CommandPolicyEvaluator(policy);
    this.#processRunner = processRunner ?? new ProcessRunner(logger);
  }

  public async execute(
    untrustedInput: unknown,
    externalSignal?: AbortSignal,
  ): Promise<BatchExecResult> {
    const input = validateBatchInput(untrustedInput, this.policy);
    const requestId = randomUUID();
    const startedAt = performance.now();
    const results = new Array<CommandResult | undefined>(input.commands.length);
    const batchController = new AbortController();
    let nextIndex = 0;
    let stopReason: StopReason | undefined;
    let internalError: unknown;

    const stop = (reason: StopReason): void => {
      if (stopReason !== undefined) {
        return;
      }
      stopReason = reason;
      batchController.abort(new Error(reason));
    };
    const isStopped = (): boolean => stopReason !== undefined;

    const externalAbortListener = (): void => {
      stop("external_cancellation");
    };
    if (externalSignal?.aborted === true) {
      stop("external_cancellation");
    } else {
      externalSignal?.addEventListener("abort", externalAbortListener, {
        once: true,
      });
    }

    this.logger.info("batch_started", {
      request_id: requestId,
      batch_size: input.commands.length,
      effective_concurrency: input.concurrency,
      failure_mode: input.failureMode,
    });

    const worker = async (): Promise<void> => {
      while (!isStopped()) {
        const index = nextIndex;
        nextIndex += 1;
        const command = input.commands[index];
        if (command === undefined) {
          return;
        }

        try {
          const prepared = await this.#policyEvaluator.prepare(
            command,
            input.maxOutputBytes,
          );
          if (isStopped()) {
            return;
          }

          const result = await this.#processRunner.run(
            prepared,
            batchController.signal,
          );
          results[index] = result;

          if (input.failureMode === "fail_fast" && isFailure(result)) {
            stop("fail_fast");
          }
        } catch (error) {
          if (error instanceof PolicyRejectionError) {
            results[index] = syntheticResult(
              command.id,
              "rejected",
              error.message,
              error.code,
            );
            this.logger.warn("command_rejected", {
              request_id: requestId,
              command_id: command.id,
              executable: command.argv[0],
              status: "rejected",
              rejection_reason: error.code,
            });
            if (input.failureMode === "fail_fast") {
              stop("fail_fast");
            }
          } else {
            internalError = error;
            stop("internal_error");
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: input.concurrency }, async () => await worker()),
    );
    externalSignal?.removeEventListener("abort", externalAbortListener);

    if (internalError !== undefined) {
      throw internalError instanceof Error
        ? internalError
        : new Error("Unexpected internal batch execution error");
    }

    const fallbackStatus =
      stopReason === "external_cancellation" ? "cancelled" : "skipped";
    const completedResults = Array.from(
      { length: input.commands.length },
      (_, index) =>
        results[index] ??
        syntheticResult(
          input.commands[index]?.id ?? `command-${index}`,
          fallbackStatus,
          fallbackStatus === "cancelled"
            ? "Batch request was cancelled before this command started"
            : "Command was not started after fail-fast stopped the batch",
        ),
    );
    const wallTimeMs = Math.max(0, Math.round(performance.now() - startedAt));
    const summary = createSummary(completedResults, wallTimeMs, input.concurrency);

    this.logger.info("batch_finished", {
      request_id: requestId,
      batch_size: input.commands.length,
      effective_concurrency: input.concurrency,
      wall_time_ms: wallTimeMs,
      succeeded: summary.succeeded,
      failed: summary.failed,
      timed_out: summary.timed_out,
      cancelled: summary.cancelled,
      skipped: summary.skipped,
      rejected: summary.rejected,
    });

    return {
      request_id: requestId,
      results: completedResults,
      summary,
    };
  }

  public async shutdown(): Promise<void> {
    await this.#processRunner.shutdown();
  }
}
