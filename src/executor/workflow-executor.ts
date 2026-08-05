import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { RuntimePolicy } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import { CommandPolicyEvaluator } from "../policy/command-policy.js";
import { PolicyRejectionError } from "../policy/errors.js";
import { validateWorkflowInput } from "../validation/workflow-input.js";
import { ProcessRunner } from "./process-runner.js";
import type {
  CommandStatus,
  ValidatedWorkflowCommand,
  WorkflowCommandResult,
  WorkflowExecResult,
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

function createSummary(
  results: readonly WorkflowCommandResult[],
  wallTimeMs: number,
  effectiveConcurrency: number,
  peakConcurrency: number,
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
  };
}

function isFailure(result: WorkflowCommandResult): boolean {
  return result.status !== "success";
}

export class WorkflowExecutor {
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
  ): Promise<WorkflowExecResult> {
    const input = validateWorkflowInput(untrustedInput, this.policy);
    const requestId = randomUUID();
    const startedAt = performance.now();
    const results = new Array<WorkflowCommandResult | undefined>(input.commands.length);
    const states = input.commands.map<NodeState>((command) =>
      command.dependsOn.length === 0 ? "ready" : "pending",
    );
    const indexById = new Map(
      input.commands.map((command, index) => [command.id, index]),
    );
    const dependencyIndexes = input.commands.map((command) =>
      command.dependsOn.map((dependency) => {
        const index = indexById.get(dependency);
        if (index === undefined) {
          throw new Error(`Validated dependency is missing: ${dependency}`);
        }
        return index;
      }),
    );
    const dependentIndexes = input.commands.map(() => new Array<number>());
    dependencyIndexes.forEach((dependencies, dependentIndex) => {
      dependencies.forEach((dependencyIndex) => {
        dependentIndexes[dependencyIndex]?.push(dependentIndex);
      });
    });
    const ready = states.flatMap((state, index) => (state === "ready" ? [index] : []));
    const workflowController = new AbortController();
    let stopReason: StopReason | undefined;
    let internalError: unknown;
    let running = 0;
    let settled = 0;
    let peakConcurrency = 0;

    this.logger.info("workflow_started", {
      request_id: requestId,
      workflow_size: input.commands.length,
      effective_concurrency: input.concurrency,
      failure_mode: input.failureMode,
    });

    return await new Promise<WorkflowExecResult>((resolve, reject) => {
      const recordResult = (index: number, result: WorkflowCommandResult): boolean => {
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
            .filter((dependencyIndex) => {
              const result = results[dependencyIndex];
              return result !== undefined && isFailure(result);
            })
            .map((dependencyIndex) => input.commands[dependencyIndex]?.id ?? "");

          if (blockedBy.length > 0) {
            const command = input.commands[dependentIndex];
            if (command === undefined) {
              continue;
            }
            recordResult(
              dependentIndex,
              syntheticResult(
                command,
                "skipped",
                `Dependency did not succeed: ${blockedBy.join(", ")}`,
                blockedBy,
              ),
            );
            releaseDependents(dependentIndex);
            continue;
          }

          if (
            dependencies.every(
              (dependencyIndex) => states[dependencyIndex] === "settled",
            )
          ) {
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
        workflowController.abort(new Error(reason));

        states.forEach((state, index) => {
          if (state !== "pending" && state !== "ready") {
            return;
          }
          const command = input.commands[index];
          if (command === undefined) {
            return;
          }
          recordResult(
            index,
            syntheticResult(
              command,
              reason === "external_cancellation" ? "cancelled" : "skipped",
              reason === "external_cancellation"
                ? "Workflow request was cancelled before this command started"
                : reason === "fail_fast"
                  ? "Command was not started after fail-fast stopped the workflow"
                  : "Command was not started after an internal workflow error",
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
              : new Error("Unexpected internal workflow execution error"),
          );
          return;
        }

        const completedResults = results.map((result) => {
          if (result === undefined) {
            throw new Error("Workflow ended without a result for every command");
          }
          return result;
        });
        const wallTimeMs = Math.max(0, Math.round(performance.now() - startedAt));
        const summary = createSummary(
          completedResults,
          wallTimeMs,
          input.concurrency,
          peakConcurrency,
        );

        this.logger.info("workflow_finished", {
          request_id: requestId,
          workflow_size: input.commands.length,
          effective_concurrency: input.concurrency,
          peak_concurrency: peakConcurrency,
          wall_time_ms: wallTimeMs,
          succeeded: summary.succeeded,
          failed: summary.failed,
          timed_out: summary.timed_out,
          cancelled: summary.cancelled,
          skipped: summary.skipped,
          rejected: summary.rejected,
        });
        resolve({
          request_id: requestId,
          results: completedResults,
          summary,
        });
      };

      const runCommand = async (index: number): Promise<WorkflowCommandResult> => {
        const command = input.commands[index];
        if (command === undefined) {
          throw new Error(`Workflow command is missing at index ${index}`);
        }

        try {
          const prepared = await this.#policyEvaluator.prepare(
            command,
            input.maxOutputBytes,
          );
          const result = await this.#processRunner.run(
            prepared,
            workflowController.signal,
          );
          return {
            ...result,
            depends_on: command.dependsOn,
            blocked_by: [],
          };
        } catch (error) {
          if (error instanceof PolicyRejectionError) {
            this.logger.warn("command_rejected", {
              request_id: requestId,
              command_id: command.id,
              executable: command.argv[0],
              status: "rejected",
              rejection_reason: error.code,
            });
            return syntheticResult(command, "rejected", error.message, [], error.code);
          }
          throw error;
        }
      };

      const commandFinished = (index: number, result: WorkflowCommandResult): void => {
        running -= 1;
        recordResult(index, result);
        if (
          stopReason === undefined &&
          input.failureMode === "fail_fast" &&
          isFailure(result)
        ) {
          stop("fail_fast");
        } else if (stopReason === undefined) {
          releaseDependents(index);
        }
        schedule();
      };

      const commandErrored = (index: number, error: unknown): void => {
        running -= 1;
        const command = input.commands[index];
        if (command !== undefined) {
          recordResult(
            index,
            syntheticResult(
              command,
              "skipped",
              "Command could not be prepared because of an internal workflow error",
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
          void runCommand(index).then(
            (result) => {
              commandFinished(index, result);
            },
            (error: unknown) => {
              commandErrored(index, error);
            },
          );
        }

        if (settled === input.commands.length && running === 0) {
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
    await this.#processRunner.shutdown();
  }
}
