import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { RuntimePolicy } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import { CommandPolicyEvaluator } from "../policy/command-policy.js";
import { PolicyRejectionError } from "../policy/errors.js";
import { validateExecInput } from "../validation/exec-input.js";
import { ExecutionLimiter } from "./execution-limiter.js";
import { ProcessRunner } from "./process-runner.js";
import type {
  CommandStatus,
  ExecResult,
  ValidatedExecInput,
  ValidatedWorkflowCommand,
  WorkflowCommandResult,
  WorkflowSummary,
} from "./types.js";

type StopReason = "external_cancellation" | "fail_fast" | "internal_error";
type NodeState = "pending" | "ready" | "running" | "settled";

function syntheticResult(
  command: ValidatedWorkflowCommand,
  status: "cancelled" | "skipped" | "rejected",
  error: string,
  blockedBy: string[] = [],
  rejectionReason: string | null = null,
): WorkflowCommandResult {
  return {
    id: command.id,
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
    global_queue_wait_ms: 0,
    depends_on: command.dependsOn,
    blocked_by: blockedBy,
  };
}

function statusCount(
  results: readonly WorkflowCommandResult[],
  status: CommandStatus,
): number {
  return results.filter((result) => result.status === status).length;
}

function summary(
  results: readonly WorkflowCommandResult[],
  wallTimeMs: number,
  effectiveConcurrency: number,
  peakConcurrency: number,
  globalPeakConcurrency: number,
): WorkflowSummary {
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
    peak_concurrency: peakConcurrency,
    global_peak_concurrency: globalPeakConcurrency,
  };
}

function failed(result: WorkflowCommandResult): boolean {
  return result.status !== "success";
}

export class ExecExecutor {
  readonly #policyEvaluator: CommandPolicyEvaluator;
  readonly #processRunner: ProcessRunner;
  readonly #ownsRunner: boolean;

  public constructor(
    private readonly policy: RuntimePolicy,
    private readonly logger: Logger,
    processRunner?: ProcessRunner,
  ) {
    this.#policyEvaluator = new CommandPolicyEvaluator(policy);
    this.#processRunner =
      processRunner ??
      new ProcessRunner(logger, new ExecutionLimiter(policy.maxConcurrency));
    this.#ownsRunner = processRunner === undefined;
  }

  public execute(untrustedInput: unknown, signal?: AbortSignal): Promise<ExecResult> {
    return this.executeValidated(
      validateExecInput(untrustedInput, this.policy),
      signal,
    );
  }

  public async executeValidated(
    input: ValidatedExecInput,
    externalSignal?: AbortSignal,
  ): Promise<ExecResult> {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const results = new Array<WorkflowCommandResult | undefined>(input.steps.length);
    const states = input.steps.map<NodeState>((step) =>
      step.dependsOn.length === 0 ? "ready" : "pending",
    );
    const indexById = new Map(input.steps.map((step, index) => [step.id, index]));
    const dependencyIndexes = input.steps.map((step) =>
      step.dependsOn.map((dependency) => {
        const index = indexById.get(dependency);
        if (index === undefined) {
          throw new Error(`Validated dependency is missing: ${dependency}`);
        }
        return index;
      }),
    );
    const dependentIndexes = input.steps.map(() => new Array<number>());
    dependencyIndexes.forEach((dependencies, dependentIndex) => {
      dependencies.forEach((dependencyIndex) => {
        dependentIndexes[dependencyIndex]?.push(dependentIndex);
      });
    });
    const ready = states.flatMap((state, index) => (state === "ready" ? [index] : []));
    const controller = new AbortController();
    let stopReason: StopReason | undefined;
    let internalError: unknown;
    let running = 0;
    let settled = 0;
    let peakConcurrency = 0;

    this.logger.info("exec_started", {
      request_id: requestId,
      step_count: input.steps.length,
      effective_concurrency: input.concurrency,
      failure_mode: input.failureMode,
      output_mode: input.output.mode,
    });

    return await new Promise<ExecResult>((resolve, reject) => {
      const record = (index: number, result: WorkflowCommandResult): boolean => {
        if (states[index] === "settled") {
          return false;
        }
        states[index] = "settled";
        results[index] = result;
        settled += 1;
        return true;
      };

      const releaseDependents = (completedIndex: number): void => {
        for (const dependentIndex of dependentIndexes[completedIndex] ?? []) {
          if (states[dependentIndex] !== "pending") {
            continue;
          }
          const dependencies = dependencyIndexes[dependentIndex] ?? [];
          const blockedBy = dependencies
            .filter((index) => results[index] !== undefined && failed(results[index]))
            .map((index) => input.steps[index]?.id ?? "");
          const step = input.steps[dependentIndex];
          if (step === undefined) {
            continue;
          }
          if (blockedBy.length > 0) {
            record(
              dependentIndex,
              syntheticResult(
                step,
                "skipped",
                `Dependency did not succeed: ${blockedBy.join(", ")}`,
                blockedBy,
              ),
            );
            releaseDependents(dependentIndex);
          } else if (dependencies.every((index) => states[index] === "settled")) {
            states[dependentIndex] = "ready";
            ready.push(dependentIndex);
          }
        }
      };

      const stop = (reason: StopReason, error?: unknown): void => {
        if (stopReason !== undefined) {
          return;
        }
        stopReason = reason;
        internalError = error;
        controller.abort(new Error(reason));
        states.forEach((state, index) => {
          if (state !== "pending" && state !== "ready") {
            return;
          }
          const step = input.steps[index];
          if (step === undefined) {
            return;
          }
          record(
            index,
            syntheticResult(
              step,
              reason === "external_cancellation" ? "cancelled" : "skipped",
              reason === "external_cancellation"
                ? "Exec request was cancelled before this step started"
                : reason === "fail_fast"
                  ? "Step was not started after fail-fast stopped execution"
                  : "Step was not started after an internal execution error",
            ),
          );
        });
      };

      const externalAbortListener = (): void => {
        stop("external_cancellation");
        schedule();
      };

      const finish = (): void => {
        externalSignal?.removeEventListener("abort", externalAbortListener);
        if (internalError !== undefined) {
          reject(
            internalError instanceof Error
              ? internalError
              : new Error("Unexpected internal exec error"),
          );
          return;
        }
        const completed = results.map((result) => {
          if (result === undefined) {
            throw new Error("Exec ended without a result for every step");
          }
          return result;
        });
        const wallTimeMs = Math.max(0, Math.round(performance.now() - startedAt));
        const executionSummary = summary(
          completed,
          wallTimeMs,
          input.concurrency,
          peakConcurrency,
          this.#processRunner.globalPeakConcurrency,
        );
        this.logger.info("exec_finished", {
          request_id: requestId,
          step_count: input.steps.length,
          wall_time_ms: wallTimeMs,
          succeeded: executionSummary.succeeded,
          failed: executionSummary.failed,
          global_peak_concurrency: executionSummary.global_peak_concurrency,
        });
        resolve({
          request_id: requestId,
          results: completed,
          summary: executionSummary,
          output_mode: input.output.mode,
        });
      };

      const runStep = async (index: number): Promise<WorkflowCommandResult> => {
        const step = input.steps[index];
        if (step === undefined) {
          throw new Error(`Exec step is missing at index ${index}`);
        }
        try {
          const prepared = await this.#policyEvaluator.prepare(
            step,
            input.output.maxStreamBytes,
            input.output.capture,
            input.output.stripAnsi,
          );
          const result = await this.#processRunner.run(prepared, controller.signal);
          return { ...result, depends_on: step.dependsOn, blocked_by: [] };
        } catch (error) {
          if (error instanceof PolicyRejectionError) {
            this.logger.warn("command_rejected", {
              request_id: requestId,
              command_id: step.id,
              executable: step.argv[0],
              rejection_reason: error.code,
            });
            return syntheticResult(step, "rejected", error.message, [], error.code);
          }
          throw error;
        }
      };

      const stepFinished = (index: number, result: WorkflowCommandResult): void => {
        running -= 1;
        record(index, result);
        if (
          stopReason === undefined &&
          input.failureMode === "fail_fast" &&
          failed(result)
        ) {
          stop("fail_fast");
        } else if (stopReason === undefined) {
          releaseDependents(index);
        }
        schedule();
      };

      const stepErrored = (index: number, error: unknown): void => {
        running -= 1;
        const step = input.steps[index];
        if (step !== undefined) {
          record(
            index,
            syntheticResult(
              step,
              "skipped",
              "Step could not be prepared because of an internal execution error",
            ),
          );
        }
        stop("internal_error", error);
        schedule();
      };

      function schedule(): void {
        while (
          stopReason === undefined &&
          running < input.concurrency &&
          ready.length > 0
        ) {
          const index = ready.shift();
          if (index === undefined || states[index] !== "ready") {
            continue;
          }
          states[index] = "running";
          running += 1;
          peakConcurrency = Math.max(peakConcurrency, running);
          void runStep(index).then(
            (result) => {
              stepFinished(index, result);
            },
            (error: unknown) => {
              stepErrored(index, error);
            },
          );
        }
        if (settled === input.steps.length && running === 0) {
          finish();
        }
      }

      if (externalSignal?.aborted === true) {
        stop("external_cancellation");
      } else {
        externalSignal?.addEventListener("abort", externalAbortListener, {
          once: true,
        });
      }
      schedule();
    });
  }

  public async shutdown(): Promise<void> {
    if (this.#ownsRunner) {
      await this.#processRunner.shutdown();
    }
  }
}
